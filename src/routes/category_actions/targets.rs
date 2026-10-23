use super::{Action, Category, Fields, Intent, Prepared};
use crate::entity::{category, note};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use sha2::{Digest, Sha256};

pub(super) fn failure(message: &str) -> DbErr {
    DbErr::Custom(message.to_owned())
}

fn name_valid(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.chars().count() <= limit
        && !value.chars().any(char::is_control)
}
fn path_valid(value: &str) -> bool {
    name_valid(value, 255)
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_whitespace() || "/?#%\\".contains(c))
}

pub(super) fn validate(intent: &Intent) -> Result<(), DbErr> {
    let fields = &intent.fields;
    let valid_target = intent.target.as_ref().is_some_and(|t| {
        (t.id.is_some_and(|id| id > 0) && t.name.is_none())
            || (t.id.is_none() && t.name.as_ref().is_some_and(|v| name_valid(v, 255)))
    });
    if (intent.action == Action::Create && (intent.target.is_some() || fields.name.is_none()))
        || (intent.action != Action::Create && !valid_target)
        || (intent.action == Action::Delete && *fields != Fields::default())
        || (intent.action == Action::Update && *fields == Fields::default())
    {
        return Err(failure(
            "创建需填写名字；修改和删除需唯一编号或完整名字，修改至少指定一项",
        ));
    }
    if fields.name.as_ref().is_some_and(|v| !name_valid(v, 40))
        || fields.path_name.as_ref().is_some_and(|v| !path_valid(v))
        || [&fields.introduce, &fields.icon]
            .iter()
            .any(|v| v.as_ref().is_some_and(|v| v.chars().count() > 255))
        || fields.color.as_ref().is_some_and(|v| {
            !v.is_empty()
                && (v.len() != 7
                    || !v.starts_with('#')
                    || !v[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        })
    {
        return Err(failure(
            "分类名字、路径或显示字段无效；颜色需#RRGGBB，简介、图标和颜色可用空串清空",
        ));
    }
    Ok(())
}

pub(super) async fn references<C: ConnectionTrait>(
    db: &C,
    id: i32,
) -> Result<Vec<(i32, Option<i32>)>, DbErr> {
    note::Entity::find()
        .select_only()
        .columns([note::Column::Id, note::Column::DraftOf])
        .filter(note::Column::CategoryId.eq(id))
        .order_by_asc(note::Column::Id)
        .into_tuple::<(i32, Option<i32>)>()
        .all(db)
        .await
}

pub(super) async fn prepare<C: ConnectionTrait>(
    db: &C,
    intent: &Intent,
    lock: bool,
) -> Result<Prepared, DbErr> {
    validate(intent)?;
    let before = if let Some(target) = &intent.target {
        let mut query = category::Entity::find();
        query = if let Some(id) = target.id {
            query.filter(category::Column::Id.eq(id))
        } else {
            query.filter(category::Column::Name.eq(target.name.clone().unwrap()))
        };
        if lock {
            query = query.lock_exclusive();
        }
        let rows = query.limit(2).all(db).await?;
        if rows.len() != 1 {
            return Err(failure(
                "分类不存在或名字不唯一，请查询分类清单并指定唯一编号",
            ));
        }
        Some(Category::from(rows.into_iter().next().unwrap()))
    } else {
        None
    };
    let mut after = before.clone();
    if intent.action == Action::Delete {
        after = None;
    } else {
        let row = after.get_or_insert(Category {
            id: None,
            name: String::new(),
            path_name: None,
            introduce: None,
            icon: None,
            color: None,
        });
        let fields = &intent.fields;
        if let Some(value) = &fields.name {
            row.name = value.clone();
        }
        if let Some(value) = &fields.path_name {
            row.path_name = Some(value.clone());
        } else if intent.action == Action::Create {
            row.path_name = Some(row.name.clone());
        }
        if intent.action == Action::Create && !path_valid(row.path_name.as_deref().unwrap_or("")) {
            return Err(failure(
                "分类名不能直接作路径，请另外填写不含空格和路径保留字符的pathName",
            ));
        }
        if let Some(value) = &fields.introduce {
            row.introduce = Some(value.clone());
        }
        if let Some(value) = &fields.icon {
            row.icon = Some(value.clone());
        }
        if let Some(value) = &fields.color {
            row.color = Some(value.clone());
        }
        let mut condition = Condition::any().add(category::Column::Name.eq(row.name.clone()));
        if let Some(path) = &row.path_name {
            if !path.is_empty() {
                condition = condition.add(category::Column::PathName.eq(path.clone()));
            }
        }
        let mut conflict = category::Entity::find().filter(condition);
        if let Some(id) = row.id {
            conflict = conflict.filter(category::Column::Id.ne(id));
        }
        if conflict.one(db).await?.is_some() {
            return Err(failure("分类名或路径已存在，本次未改动"));
        }
    }
    let refs = if let Some(id) = before.as_ref().and_then(|row| row.id) {
        references(db, id).await?
    } else {
        vec![]
    };
    let article_count = refs
        .iter()
        .filter(|(_, revision)| revision.is_none())
        .count() as u64;
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(intent, &before, &after, &refs))
            .map_err(|_| failure("无法计算分类确认版本"))?,
    ));
    Ok(Prepared {
        version,
        before,
        after,
        article_count,
        revision_count: refs.len() as u64 - article_count,
    })
}
