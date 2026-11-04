use super::{failure, validate, Kind, Prepared, Preview, Resource, Scope, Selection, MAX_ITEMS};
use crate::entity::{announcement, user, user_notification};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use sha2::{Digest, Sha256};

pub(super) struct Snapshot {
    pub plan: Prepared,
    pub announcement_versions: Vec<(i32, String)>,
}

pub(super) async fn snapshot<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    resource: Resource,
    request: &Selection,
    lock: bool,
) -> Result<Snapshot, sea_orm::DbErr> {
    validate(request, resource)?;
    let mut versions = Vec::new();
    let mut notification_versions = Vec::new();
    let mut rows = Vec::new();
    let mut associated_notifications = 0;
    match resource {
        Resource::Announcements => {
            let actor = user::Entity::find_by_id(uid)
                .one(db)
                .await?
                .ok_or_else(|| failure("账号不存在"))?;
            if !crate::authz::can_access_console(&actor.role) {
                return Err(failure("仅管理员可删除全站公告"));
            }
            let mut query = announcement::Entity::find()
                .order_by_asc(announcement::Column::Id)
                .limit((MAX_ITEMS + 1) as u64);
            if request.scope == Scope::Selected {
                query = query.filter(announcement::Column::Id.is_in(request.ids.clone()));
            }
            if lock {
                query = query.lock_exclusive();
            }
            let items = query.all(db).await?;
            if items.len() > MAX_ITEMS {
                return Err(failure("本次目标超过1000条，请指定编号分批处理"));
            }
            for item in items {
                // Reuse the authoritative announcement rules, including linked-notification safety.
                let plan =
                    super::super::announcement_actions::prepare_deletion(db, item.id, lock).await?;
                associated_notifications += plan.notification_count;
                versions.push((item.id, plan.version));
                rows.push(Preview {
                    id: item.id,
                    title: item.title,
                });
            }
        }
        Resource::Notifications => {
            let mut query = user_notification::Entity::find()
                .filter(user_notification::Column::UserId.eq(uid))
                .filter(user_notification::Column::DeletedAt.is_null())
                .order_by_asc(user_notification::Column::Id)
                .limit((MAX_ITEMS + 1) as u64);
            if request.scope == Scope::Selected {
                query = query.filter(user_notification::Column::Id.is_in(request.ids.clone()));
            }
            let kind = match request.kind {
                Kind::All => None,
                Kind::Notice => Some("notice"),
                Kind::Announcement => Some("announcement"),
            };
            if let Some(kind) = kind {
                query = query.filter(user_notification::Column::Kind.eq(kind));
            }
            if lock {
                query = query.lock_exclusive();
            }
            let items = query.all(db).await?;
            if items.len() > MAX_ITEMS {
                return Err(failure("本次目标超过1000条，请指定编号分批处理"));
            }
            for item in items {
                // Read markers do not change deletion identity; content/ownership changes do.
                notification_versions.push(serde_json::json!([
                    item.id,
                    item.user_id,
                    item.announcement_id,
                    item.kind,
                    item.title,
                    item.content,
                    item.link,
                    item.created_at
                ]));
                rows.push(Preview {
                    id: item.id,
                    title: item.title,
                });
            }
        }
    }
    let ids: Vec<i32> = rows.iter().map(|row| row.id).collect();
    let mut requested = request.ids.clone();
    requested.sort_unstable();
    if request.scope == Scope::Selected && requested != ids {
        return Err(failure("部分目标不存在、已删除或不属于本人，本次未改动"));
    }
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            uid,
            resource,
            request.kind,
            &ids,
            &versions,
            &notification_versions,
        ))
        .map_err(|_| failure("无法计算删除确认版本"))?,
    ));
    let count = ids.len();
    Ok(Snapshot {
        plan: Prepared {
            version,
            ids,
            items: rows.into_iter().take(20).collect(),
            count,
            associated_notifications,
        },
        announcement_versions: versions,
    })
}
pub(super) async fn remove_notifications<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    ids: &[i32],
) -> Result<(), sea_orm::DbErr> {
    let removed = user_notification::Entity::update_many()
        .col_expr(
            user_notification::Column::DeletedAt,
            Expr::value(chrono::Local::now().naive_local()),
        )
        .filter(user_notification::Column::UserId.eq(uid))
        .filter(user_notification::Column::DeletedAt.is_null())
        .filter(user_notification::Column::Id.is_in(ids.iter().copied()))
        .exec(db)
        .await?;
    if removed.rows_affected != ids.len() as u64 {
        return Err(failure("通知删除范围未完整执行"));
    }
    Ok(())
}
