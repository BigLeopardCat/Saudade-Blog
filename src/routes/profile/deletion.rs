//! Idempotent removal from the caller's own list; never retract another user's copy.

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{sea_query::Expr, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};
use serde::Deserialize;
use std::sync::Arc;

use super::{message_reads::Folder, unread::unread_response, visibility, UnreadDto};
use crate::{
    entity::{user_message, user_notification},
    routes::AppState,
    utils::ApiResponse,
};

pub(super) async fn remove_notification<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    id: i32,
) -> Result<(), sea_orm::DbErr> {
    user_notification::Entity::update_many()
        .col_expr(
            user_notification::Column::DeletedAt,
            Expr::value(chrono::Local::now().naive_local()),
        )
        .filter(visibility::notifications(uid))
        .filter(user_notification::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub(super) async fn remove_message<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    id: i32,
    folder: Folder,
) -> Result<(), sea_orm::DbErr> {
    let (column, scope) = match folder {
        Folder::Inbox => (
            user_message::Column::RecipientDeletedAt,
            visibility::inbox(uid),
        ),
        Folder::Outbox => (
            user_message::Column::SenderDeletedAt,
            visibility::outbox(uid),
        ),
    };
    user_message::Entity::update_many()
        .col_expr(column, Expr::value(chrono::Local::now().naive_local()))
        .filter(scope)
        .filter(user_message::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn delete_notification(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<UnreadDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if id <= 0 {
        return Json(ApiResponse::error("通知编号无效"));
    }
    if let Err(error) = remove_notification(&state.db, uid, id).await {
        tracing::error!("remove notification uid={uid} id={id}: {error}");
        return Json(ApiResponse::error("删除失败，请稍后再试"));
    }
    unread_response(&state.db, uid).await
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteMessageQuery {
    #[serde(default)]
    folder: Folder,
}

pub async fn delete_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Query(query): Query<DeleteMessageQuery>,
) -> Json<ApiResponse<UnreadDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if id <= 0 {
        return Json(ApiResponse::error("信件编号无效"));
    }
    if let Err(error) = remove_message(&state.db, uid, id, query.folder).await {
        tracing::error!("remove message uid={uid} id={id}: {error}");
        return Json(ApiResponse::error("删除失败，请稍后再试"));
    }
    unread_response(&state.db, uid).await
}

#[cfg(test)]
mod tests;
