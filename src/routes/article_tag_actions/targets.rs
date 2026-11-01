//! Resolve exact tag names and freeze the complete, ordered article change.

use super::{Intent, Prepared, Tag};
use crate::routes::article_actions;
use sea_orm::{ConnectionTrait, DatabaseBackend, DbErr, Statement, Value};
use sha2::{Digest, Sha256};

const CURRENT: &str = "SELECT COALESCE(o.id,t.id) AS id,CASE WHEN o.id IS NOT NULL THEN 1 ELSE 2 END::smallint AS level,COALESCE(o.name,t.name) AS name,t.tag_one_id AS parent_id,COALESCE(o.color,t.color) AS color FROM note_tag r LEFT JOIN tag_one o ON o.id=r.tag_one_id LEFT JOIN tag_two t ON t.id=r.tag_two_id WHERE r.note_id=$1 ORDER BY r.seq LIMIT 41";

pub(super) fn failure(message: &str) -> DbErr {
    DbErr::Custom(message.to_owned())
}

pub(super) async fn current<C: ConnectionTrait>(db: &C, id: i32) -> Result<Vec<Tag>, DbErr> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            CURRENT,
            vec![id.into()],
        ))
        .await?;
    if rows.len() > 40 {
        return Err(failure("单篇文章最多支持40个标签，请在后台整理后重试"));
    }
    rows.into_iter()
        .map(|r| {
            Ok(Tag {
                id: Some(r.try_get("", "id")?),
                level: r.try_get("", "level")?,
                name: r.try_get("", "name")?,
                parent_id: r.try_get("", "parent_id")?,
                color: r.try_get("", "color")?,
            })
        })
        .collect()
}

pub(super) async fn named<C: ConnectionTrait>(
    db: &C,
    name: &str,
    level: Option<i16>,
    parent: Option<i32>,
    lock: bool,
) -> Result<Option<Tag>, DbErr> {
    let mut hits = Vec::new();
    for tier in [1, 2] {
        if level.is_some_and(|v| v != tier) || (parent.is_some() && tier == 1) {
            continue;
        }
        // Table selection is closed over the two known hierarchy levels.
        let (table, parent_column) = if tier == 1 {
            ("tag_one", "NULL::integer")
        } else {
            ("tag_two", "tag_one_id")
        };
        let sql = format!("SELECT id,name,color,{parent_column} AS parent_id FROM {table} WHERE name=$1 AND ($2::integer IS NULL OR {parent_column}=$2) ORDER BY id LIMIT 2{}", if lock { " FOR SHARE" } else { "" });
        let values: Vec<Value> = vec![name.into(), parent.into()];
        for r in db
            .query_all(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                values,
            ))
            .await?
        {
            hits.push(Tag {
                id: Some(r.try_get("", "id")?),
                level: tier,
                name: r.try_get("", "name")?,
                parent_id: r.try_get("", "parent_id")?,
                color: r.try_get("", "color")?,
            });
        }
    }
    if hits.len() > 1 {
        return Err(failure("标签同名不唯一，请指定一级或二级及父标签"));
    }
    Ok(hits.pop())
}

async fn resolve<C: ConnectionTrait>(
    db: &C,
    name: &str,
    intent: &Intent,
    parent: Option<i32>,
    create: bool,
    lock: bool,
) -> Result<Tag, DbErr> {
    if let Some(tag) = named(db, name, intent.level, parent, lock).await? {
        return Ok(tag);
    }
    if !create {
        return Err(failure("未找到要移除的标签，请核对名称与层级"));
    }
    let level = intent.level.unwrap_or(if parent.is_some() { 2 } else { 1 });
    if level == 2 && parent.is_none() {
        return Err(failure("新建二级标签需要指定已有的一级父标签"));
    }
    Ok(Tag {
        id: None,
        level,
        name: name.to_owned(),
        parent_id: parent,
        color: intent.color.clone(),
    })
}

pub(super) async fn prepare<C: ConnectionTrait>(
    db: &C,
    id: i32,
    intent: &Intent,
    lock: bool,
) -> Result<Prepared, DbErr> {
    intent.validate()?;
    let article = article_actions::read(db, id, lock).await?;
    let parent = match &intent.parent_tag {
        Some(name) => Some(
            named(db, name, Some(1), None, lock)
                .await?
                .ok_or_else(|| failure("未找到指定的一级父标签"))?
                .id
                .unwrap(),
        ),
        None => None,
    };
    let before = current(db, id).await?;
    let mut after = if intent.replace.is_some() {
        Vec::new()
    } else {
        before.clone()
    };
    for name in &intent.remove {
        let tag = resolve(db, name, intent, parent, false, lock).await?;
        after.retain(|row| (row.level, row.id) != (tag.level, tag.id));
    }
    let additions = intent.replace.as_ref().unwrap_or(&intent.add);
    for name in additions {
        let tag = resolve(db, name, intent, parent, true, lock).await?;
        if !after.iter().any(|row| row == &tag) {
            after.push(tag);
        }
    }
    if after.len() > 40 {
        return Err(failure("单篇文章最多支持40个标签，请在后台整理后重试"));
    }
    let frozen = serde_json::to_vec(&(&article.version, &before, &after, intent))
        .map_err(|_| failure("无法核对文章标签变更"))?;
    Ok(Prepared {
        id,
        title: article.title,
        version: hex::encode(Sha256::digest(&frozen)),
        before,
        after,
    })
}
