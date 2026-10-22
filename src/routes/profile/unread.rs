//! Unread aggregation, separate from notification and mailbox contents.

use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use std::sync::Arc;

use super::{board_pending_count, comment_pending_count, is_console_user, UnreadDto};
use crate::{
    entity::{user_message, user_notification},
    routes::AppState,
    utils::ApiResponse,
};

async fn unread_counts(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
) -> Result<UnreadDto, sea_orm::DbErr> {
    let n = user_notification::Entity::find()
        .filter(user_notification::Column::UserId.eq(uid))
        .filter(user_notification::Column::IsRead.eq(false))
        .count(db)
        .await? as i64;
    let m = user_message::Entity::find()
        .filter(user_message::Column::ToUserId.eq(uid))
        .filter(user_message::Column::IsRead.eq(false))
        .count(db)
        .await? as i64;
    // Console counts are included only for users who can access the console.
    let console_user = is_console_user(db, uid).await;
    let pending_review = if console_user {
        board_pending_count(db).await
    } else {
        0
    };
    let pending_quota = if console_user {
        crate::routes::quota::quota_pending_count(db).await
    } else {
        0
    };
    let pending_comments = if console_user {
        comment_pending_count(db).await
    } else {
        0
    };
    Ok(UnreadDto {
        notifications: n,
        messages: m,
        total: n + m,
        pending_review,
        pending_quota,
        pending_comments,
    })
}

/// GET /api/protected/notifications/summary: counts only, without notification contents.
pub async fn notification_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<UnreadDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    unread_response(&state.db, uid).await
}

pub(super) async fn unread_response(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
) -> Json<ApiResponse<UnreadDto>> {
    match unread_counts(db, uid).await {
        Ok(counts) => Json(ApiResponse::success(counts)),
        Err(e) => {
            tracing::error!("[profile] 未读计数查询失败 uid={}: {}", uid, e);
            Json(ApiResponse::error("未读计数查询失败，请稍后再试"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{DatabaseBackend, DbErr, MockDatabase};

    #[tokio::test]
    async fn unread_query_failure_does_not_become_zero() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors([DbErr::Custom("synthetic count failure".into())])
            .into_connection();
        assert!(unread_counts(&db, 7).await.is_err());
    }
}
