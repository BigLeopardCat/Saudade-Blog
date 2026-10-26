use super::{Action, Announcement, Fields, Intent, Prepared};
use crate::entity::{announcement, user, user_notification};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use sha2::{Digest, Sha256};

pub(super) fn failure(message: &str) -> DbErr {
    DbErr::Custom(message.to_owned())
}

pub(super) fn validate(intent: &Intent) -> Result<(), DbErr> {
    let valid_target = intent.target.as_ref().is_some_and(|target| {
        (target.id.is_some() || target.title.is_some())
            && target.id.is_none_or(|id| id > 0)
            && target.title.as_ref().is_none_or(|v| {
                !v.trim().is_empty() && v.chars().count() <= 80 && !v.chars().any(char::is_control)
            })
    });
    if intent.action == Action::Create
        && (intent.target.is_some()
            || intent.fields.title.is_none()
            || intent.fields.content.is_none())
        || intent.action != Action::Create && !valid_target
        || intent.action == Action::Delete && intent.fields != Fields::default()
        || intent.action == Action::Update && intent.fields == Fields::default()
        || intent.fields.title.as_ref().is_some_and(|v| {
            v.trim().is_empty() || v.chars().count() > 80 || v.chars().any(char::is_control)
        })
        || intent.fields.content.as_ref().is_some_and(|v| {
            v.trim().is_empty()
                || v.chars().count() > 2000
                || v.chars()
                    .any(|c| c.is_control() && !['\n', '\r', '\t'].contains(&c))
        })
    {
        return Err(failure(
            "创建需标题和正文；修改或删除需唯一编号或完整原标题，标题至多80字，正文至多2000字",
        ));
    }
    Ok(())
}

pub(super) async fn recipients<C: ConnectionTrait>(db: &C) -> Result<Vec<i32>, DbErr> {
    user::Entity::find()
        .select_only()
        .column(user::Column::Id)
        .order_by_asc(user::Column::Id)
        .into_tuple::<i32>()
        .all(db)
        .await
}

pub(super) async fn notifications<C: ConnectionTrait>(
    db: &C,
    id: i32,
) -> Result<Vec<(i32, i32)>, DbErr> {
    user_notification::Entity::find()
        .select_only()
        .columns([
            user_notification::Column::Id,
            user_notification::Column::UserId,
        ])
        .filter(user_notification::Column::AnnouncementId.eq(id))
        .order_by_asc(user_notification::Column::Id)
        .into_tuple::<(i32, i32)>()
        .all(db)
        .await
}

pub(super) async fn prepare<C: ConnectionTrait>(
    db: &C,
    intent: &Intent,
    lock: bool,
) -> Result<Prepared, DbErr> {
    validate(intent)?;
    let original = if let Some(target) = &intent.target {
        let mut query = announcement::Entity::find();
        query = if let Some(id) = target.id {
            query.filter(announcement::Column::Id.eq(id))
        } else {
            query.filter(announcement::Column::Title.eq(target.title.clone().unwrap()))
        };
        if lock {
            query = query.lock_exclusive();
        }
        let rows = query.limit(2).all(db).await?;
        if rows.len() != 1 {
            return Err(failure(
                "公告不存在或标题不唯一，请查询公告清单并指定唯一编号",
            ));
        }
        let row = rows.into_iter().next().unwrap();
        if target
            .title
            .as_ref()
            .is_some_and(|title| title != &row.title)
        {
            return Err(failure("公告id与title不一致，请重新查询公告"));
        }
        Some(row)
    } else {
        None
    };
    if let Some(row) = &original {
        let mut unlinked = user_notification::Entity::find()
            .filter(user_notification::Column::AnnouncementId.is_null())
            .filter(user_notification::Column::Kind.eq("announcement"))
            .filter(user_notification::Column::Title.eq(row.title.clone()));
        unlinked = match row.created_at {
            Some(time) => unlinked.filter(user_notification::Column::CreatedAt.eq(time)),
            None => unlinked.filter(user_notification::Column::CreatedAt.is_null()),
        };
        if unlinked.one(db).await?.is_some() {
            return Err(failure(
                "历史公告通知关联不明确，请先修复关联后再修改或删除",
            ));
        }
    }
    let before = original.clone().map(Announcement::from);
    let mut after = before.clone();
    if intent.action == Action::Delete {
        after = None;
    } else {
        let row = after.get_or_insert(Announcement {
            id: None,
            title: String::new(),
            content: String::new(),
        });
        if let Some(title) = &intent.fields.title {
            row.title = title.clone();
        }
        if let Some(content) = &intent.fields.content {
            row.content = content.clone();
        }
    }
    let refs = if let Some(row) = &before {
        notifications(db, row.id.unwrap()).await?
    } else {
        vec![]
    };
    let recipient_ids = if intent.action == Action::Create {
        recipients(db).await?
    } else {
        vec![]
    };
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(intent, &original, &after, &refs, &recipient_ids))
            .map_err(|_| failure("无法计算公告确认版本"))?,
    ));
    Ok(Prepared {
        version,
        before,
        after,
        notification_count: if intent.action == Action::Create {
            recipient_ids.len() as u64
        } else {
            refs.len() as u64
        },
    })
}
