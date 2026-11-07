//! Notification lists and the latest announcement share per-user deletion state.

use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter,
    QueryOrder,
};
use std::sync::Arc;

use super::{
    unread::unread_response, visibility, NotificationDto, ReadRequest,
    UnreadDto,
};
use crate::{entity::user_notification, routes::AppState, utils::ApiResponse};

fn dto(row: user_notification::Model) -> NotificationDto {
    NotificationDto {
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content.unwrap_or_default(),
        link: row.link,
        is_read: row.is_read,
        content_truncated: false,
        created_at: row.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

pub(super) async fn pending<C: ConnectionTrait>(
    db: &C,
    uid: i32,
) -> Result<Option<NotificationDto>, sea_orm::DbErr> {
    // Look at the newest source even if removed; removing it must not resurrect older notices.
    let latest = user_notification::Entity::find()
        .filter(user_notification::Column::UserId.eq(uid))
        .filter(user_notification::Column::Kind.eq("announcement"))
        .order_by_desc(user_notification::Column::CreatedAt)
        .order_by_desc(user_notification::Column::Id)
        .one(db)
        .await?;
    Ok(latest
        .filter(|row| !row.is_read && row.deleted_at.is_none())
        .map(dto))
}

pub async fn pending_announcement(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Option<NotificationDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    match pending(&state.db, uid).await {
        Ok(item) => Json(ApiResponse::success(item)),
        Err(error) => {
            tracing::error!("pending announcement uid={uid}: {error}");
            Json(ApiResponse::error("公告查询失败，请稍后再试"))
        }
    }
}

mod queries;
pub use queries::{list_notifications, notification_detail, notification_state};

pub async fn read_notifications(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ReadRequest>,
) -> Json<ApiResponse<UnreadDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let mut query = user_notification::Entity::update_many()
        .col_expr(user_notification::Column::IsRead, Expr::value(true))
        .col_expr(
            user_notification::Column::ReadAt,
            Expr::value(Some(chrono::Local::now().naive_local())),
        )
        .filter(visibility::notifications(uid))
        .filter(user_notification::Column::IsRead.eq(false));
    if !payload.all {
        if payload.ids.is_empty() {
            return unread_response(&state.db, uid).await;
        }
        query = query.filter(user_notification::Column::Id.is_in(payload.ids));
    }
    if let Err(error) = query.exec(&state.db).await {
        tracing::error!("read notifications uid={uid}: {error}");
        return Json(ApiResponse::error("操作失败，请稍后再试"));
    }
    unread_response(&state.db, uid).await
}
