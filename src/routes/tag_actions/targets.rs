use super::{Action, Fields, Intent, Prepared, Tag, Target};
use crate::{
    entity::{tag_one, tag_two},
    routes::{note_tags, tags},
};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, Set, Statement,
};
use sha2::{Digest, Sha256};

pub(super) fn failure(message: &str) -> DbErr {
    DbErr::Custom(message.to_owned())
}
fn valid_name(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.chars().count() <= limit
        && !value.chars().any(char::is_control)
}
fn valid_target(t: &Target) -> bool {
    ((t.id.is_some_and(|id| id > 0) && t.level.is_some())
        || (t.id.is_none() && t.name.as_ref().is_some_and(|n| valid_name(n, 255))))
        && t.name.as_ref().is_none_or(|n| valid_name(n, 255))
        && t.level.is_none_or(|l| matches!(l, 1 | 2))
        && t.parent_id.is_none_or(|id| id > 0)
        && !(t.level == Some(1) && t.parent_id.is_some())
}
pub(super) fn validate(i: &Intent) -> Result<(), DbErr> {
    if (i.action == Action::Create && (i.target.is_some() || i.fields.name.is_none()))
        || (i.action != Action::Create && !i.target.as_ref().is_some_and(valid_target))
        || (i.action == Action::Update && i.fields == Fields::default())
        || (i.action == Action::Delete && i.fields != Fields::default())
        || i.fields.name.as_ref().is_some_and(|n| !valid_name(n, 40))
        || i.fields.level.is_some_and(|l| !matches!(l, 1 | 2))
        || i.fields.parent.as_ref().is_some_and(|p| {
            !valid_target(p) || p.level.is_some_and(|l| l != 1) || p.parent_id.is_some()
        })
        || i.fields.color.as_ref().is_some_and(|c| {
            !c.is_empty()
                && (c.len() != 7
                    || !c.starts_with('#')
                    || !c[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        })
    {
        return Err(failure(
            "创建需名字；修改或删除以完整名字或层级和编号定位；颜色需#RRGGBB或空串",
        ));
    }
    Ok(())
}

pub(super) async fn resolve<C: ConnectionTrait>(
    db: &C,
    t: &Target,
    lock: bool,
) -> Result<Tag, DbErr> {
    let mut hits = Vec::new();
    for level in [1, 2] {
        if t.level.is_some_and(|l| l != level) || (level == 1 && t.parent_id.is_some()) {
            continue;
        }
        let (table, parent) = if level == 1 {
            ("tag_one", "NULL::integer")
        } else {
            ("tag_two", "tag_one_id")
        };
        let sql=format!("SELECT id,name,color,{parent} AS parent_id FROM {table} WHERE ($1::integer IS NULL OR id=$1) AND ($2::text IS NULL OR name=$2) AND ($3::integer IS NULL OR {parent}=$3) ORDER BY id LIMIT 2{}",if lock {" FOR UPDATE"}else{""});
        for row in db
            .query_all(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                vec![t.id.into(), t.name.clone().into(), t.parent_id.into()],
            ))
            .await?
        {
            hits.push(Tag {
                id: Some(row.try_get("", "id")?),
                level,
                name: row.try_get("", "name")?,
                color: row.try_get("", "color")?,
                parent_id: row.try_get("", "parent_id")?,
            });
        }
    }
    if hits.len() != 1 {
        return Err(failure(
            "标签不存在或同名不唯一，请从标签清单提供层级和编号，二级同名可补父编号",
        ));
    }
    Ok(hits.pop().unwrap())
}

pub(super) struct Snapshot {
    pub plan: Prepared,
    children: Vec<Tag>,
    refs: Vec<(i32, i16, i16, i32, Option<i32>)>,
}
async fn children<C: ConnectionTrait>(db: &C, id: i32) -> Result<Vec<Tag>, DbErr> {
    db.query_all(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id,name,color,tag_one_id FROM tag_two WHERE tag_one_id=$1 ORDER BY id",
        vec![id.into()],
    ))
    .await?
    .into_iter()
    .map(|r| {
        Ok(Tag {
            id: Some(r.try_get("", "id")?),
            level: 2,
            name: r.try_get("", "name")?,
            color: r.try_get("", "color")?,
            parent_id: r.try_get("", "tag_one_id")?,
        })
    })
    .collect()
}
async fn references<C: ConnectionTrait>(
    db: &C,
    tag: &Tag,
    children: &[Tag],
) -> Result<Vec<(i32, i16, i16, i32, Option<i32>)>, DbErr> {
    let child_ids: Vec<i32> = children.iter().filter_map(|t| t.id).collect();
    let sql="SELECT r.note_id,r.seq,CASE WHEN r.tag_one_id IS NOT NULL THEN 1 ELSE 2 END::smallint AS level,COALESCE(r.tag_one_id,r.tag_two_id) AS tag_id,n.draft_of FROM note_tag r JOIN note n ON n.id=r.note_id WHERE ($1=1 AND r.tag_one_id=$2) OR ($1=2 AND r.tag_two_id=$2) OR r.tag_two_id=ANY($3::integer[]) ORDER BY r.note_id,r.seq";
    db.query_all(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        vec![tag.level.into(), tag.id.into(), child_ids.into()],
    ))
    .await?
    .into_iter()
    .map(|r| {
        Ok((
            r.try_get("", "note_id")?,
            r.try_get("", "seq")?,
            r.try_get("", "level")?,
            r.try_get("", "tag_id")?,
            r.try_get("", "draft_of")?,
        ))
    })
    .collect()
}

pub(super) async fn snapshot<C: ConnectionTrait>(
    db: &C,
    i: &Intent,
    lock: bool,
) -> Result<Snapshot, DbErr> {
    validate(i)?;
    let before = if let Some(t) = &i.target {
        Some(resolve(db, t, lock).await?)
    } else {
        None
    };
    let children = if let Some(b) = &before {
        if b.level == 1 {
            children(db, b.id.unwrap()).await?
        } else {
            vec![]
        }
    } else {
        vec![]
    };
    let previous_parent = if let Some(id) = before.as_ref().and_then(|b| b.parent_id) {
        Some(
            resolve(
                db,
                &Target {
                    id: Some(id),
                    level: Some(1),
                    name: None,
                    parent_id: None,
                },
                lock,
            )
            .await?,
        )
    } else {
        None
    };
    let mut after = before.clone();
    let mut parent = previous_parent.clone();
    if i.action == Action::Delete {
        after = None;
        parent = None;
    } else {
        let a = after.get_or_insert(Tag {
            id: None,
            level: 1,
            name: String::new(),
            color: None,
            parent_id: None,
        });
        if let Some(n) = &i.fields.name {
            a.name = n.clone();
        }
        if let Some(c) = &i.fields.color {
            a.color = Some(c.clone());
        }
        if let Some(p) = &i.fields.parent {
            let p = Target {
                level: Some(1),
                ..p.clone()
            };
            parent = Some(resolve(db, &p, lock).await?);
            if i.fields.level == Some(1) {
                return Err(failure("一级标签不能设置父标签"));
            }
            a.level = 2;
            a.parent_id = parent.as_ref().and_then(|p| p.id);
        }
        if let Some(l) = i.fields.level {
            a.level = l;
        }
        if a.level == 1 {
            a.parent_id = None;
            parent = None;
        } else if a.parent_id.is_none() {
            return Err(failure("创建或移动到二级标签需指定一级父标签"));
        }
        if let Some(b) = &before {
            if b.level != a.level {
                if b.level == 1 && (!children.is_empty() || a.parent_id == b.id) {
                    return Err(failure("带子标签的一级标签不能降级，也不能挂到自身"));
                }
                // Cross-table moves may allocate a new id; the receipt returns the actual identity.
                a.id = None;
            }
        }
    }
    let refs = if let Some(b) = &before {
        references(db, b, &children).await?
    } else {
        vec![]
    };
    let articles: std::collections::HashSet<_> =
        refs.iter().filter(|r| r.4.is_none()).map(|r| r.0).collect();
    let revisions: std::collections::HashSet<_> =
        refs.iter().filter(|r| r.4.is_some()).map(|r| r.0).collect();
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            i,
            &before,
            &after,
            &previous_parent,
            &parent,
            &children,
            &refs,
        ))
        .map_err(|_| failure("无法计算标签确认版本"))?,
    ));
    Ok(Snapshot {
        plan: Prepared {
            version,
            before,
            after,
            parent,
            child_count: children.len() as u64,
            article_count: articles.len() as u64,
            revision_count: revisions.len() as u64,
        },
        children,
        refs,
    })
}

pub(super) async fn apply<C: ConnectionTrait>(db: &C, s: &mut Snapshot) -> Result<(), DbErr> {
    match (&s.plan.before, &s.plan.after) {
        (None, Some(after)) => {
            let id = if after.level == 1 {
                tag_one::ActiveModel {
                    name: Set(after.name.clone()),
                    color: Set(after.color.clone()),
                    level: Set(Some(1)),
                    ..Default::default()
                }
                .insert(db)
                .await?
                .id
            } else {
                tag_two::ActiveModel {
                    name: Set(after.name.clone()),
                    color: Set(after.color.clone()),
                    level: Set(Some(2)),
                    tag_one_id: Set(after.parent_id),
                    ..Default::default()
                }
                .insert(db)
                .await?
                .id
            };
            let saved = resolve(
                db,
                &Target {
                    id: Some(id),
                    name: None,
                    level: Some(after.level),
                    parent_id: None,
                },
                false,
            )
            .await?;
            let mut expected = after.clone();
            expected.id = Some(id);
            if saved != expected {
                return Err(failure("新标签写入结果与确认内容不一致"));
            }
            s.plan.after = Some(saved);
        }
        (Some(before), Some(after)) => {
            let moved = tags::move_in_transaction(
                db,
                &tags::MoveTagRequest {
                    level: if before.level == 1 { "one" } else { "two" }.to_owned(),
                    id: before.id.unwrap(),
                    to_level: Some(if after.level == 1 { "one" } else { "two" }.to_owned()),
                    father_id: after.parent_id,
                    title: Some(after.name.clone()),
                    color: after.color.clone(),
                },
            )
            .await
            .map_err(|e| failure(&e))?;
            let saved = resolve(
                db,
                &Target {
                    id: Some(moved.to_id),
                    name: None,
                    level: Some(after.level),
                    parent_id: None,
                },
                false,
            )
            .await?;
            let mut expected = after.clone();
            expected.id = Some(moved.to_id);
            if saved != expected {
                return Err(failure("标签移动结果与确认内容不一致"));
            }
            if before.level != after.level && moved.rewritten_notes != s.refs.len() as u64 {
                return Err(failure("标签引用未完整迁移"));
            }
            s.plan.after = Some(saved);
        }
        (Some(before), None) => {
            let id = before.id.unwrap();
            let removed = if before.level == 1 {
                tag_one::Entity::delete_by_id(id)
                    .exec(db)
                    .await?
                    .rows_affected
            } else {
                tag_two::Entity::delete_by_id(id)
                    .exec(db)
                    .await?
                    .rows_affected
            };
            if removed != 1 || !references(db, before, &s.children).await?.is_empty() {
                return Err(failure("标签或关联引用删除不完整"));
            }
            let ids: Vec<i32> = s
                .refs
                .iter()
                .map(|r| r.0)
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            note_tags::resync_tags_column(db, &ids).await?;
        }
        _ => return Err(failure("标签变更计划无效")),
    }
    Ok(())
}
