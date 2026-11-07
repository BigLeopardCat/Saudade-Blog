//! A prepared, fixed image collection is changed in one database transaction.
mod changes;
mod input;
mod plan;

pub use input::{Change, Intent, Item, Patch};
// JSON transports may escape each Unicode scalar; the decoded intent still has its own 8 KiB limit.
pub const MAX_BODY_BYTES: usize = input::MAX_INTENT_BYTES * 6 + 4096;
pub use plan::{Destination, Prepared, Preview};

use super::{actor, references};
use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{DatabaseConnection, DbErr, TransactionTrait};
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug)]
pub(crate) enum ActionError {
    Invalid,
    Unauthorized,
    Conflict,
    Expired,
    Referenced(references::Blocker),
    Storage,
    Database(DbErr),
}

impl From<DbErr> for ActionError {
    fn from(value: DbErr) -> Self {
        Self::Database(value)
    }
}

impl ActionError {
    fn response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                "图片操作范围或参数无效，请重新选择".to_string(),
            ),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "请重新登录后操作图库".to_string()),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "图片或目标目录已变化，请重新查看预览".to_string(),
            ),
            Self::Expired => (
                StatusCode::CONFLICT,
                "图片操作预览已过期，请重新查看预览".to_string(),
            ),
            Self::Referenced(v) => (
                StatusCode::CONFLICT,
                format!(
                    "图片 #{} 仍被 {} #{} 引用，未删除任何图片",
                    v.image_id, v.resource, v.resource_id
                ),
            ),
            Self::Storage => (
                StatusCode::CONFLICT,
                "图片存储目标不可确认，未删除任何图片".to_string(),
            ),
            Self::Database(_error) => {
                tracing::error!(
                    event = "gallery_action_failed",
                    reason = "database",
                    "gallery transaction failed"
                );
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "图库暂时不可用，请稍后重试".to_string(),
                )
            }
        };
        (
            status,
            Json(ApiResponse {
                code: i32::from(status.as_u16()),
                message,
                data: serde_json::Value::Null,
            }),
        )
            .into_response()
    }
}

fn respond<T: Serialize>(value: Result<T, ActionError>) -> Response {
    match value {
        Ok(value) => Json(ApiResponse::success(value)).into_response(),
        Err(error) => error.response(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub action: String,
    pub changed: bool,
    pub before_version: String,
    pub matched_ids: Vec<i32>,
    pub changed_ids: Vec<i32>,
    pub cleanup_pending_ids: Vec<i32>,
}

pub(crate) async fn prepare_change(
    db: &DatabaseConnection,
    uid: i32,
    intent: Intent,
) -> Result<Prepared, ActionError> {
    if uid <= 0 {
        return Err(ActionError::Unauthorized);
    }
    let intent = intent.normalize().map_err(|_| ActionError::Invalid)?;
    let txn = db.begin().await?;
    let expires_at = chrono::Utc::now().timestamp() + input::APPROVAL_SECONDS;
    let prepared = plan::build(&txn, uid, intent, expires_at, false)
        .await?
        .prepared;
    txn.commit().await?;
    Ok(prepared)
}

pub(crate) async fn execute_change(
    db: &DatabaseConnection,
    uid: i32,
    input: Change,
) -> Result<Outcome, ActionError> {
    if uid <= 0 {
        return Err(ActionError::Unauthorized);
    }
    let now = chrono::Utc::now().timestamp();
    if input.expires_at <= now || input.expires_at > now + input::APPROVAL_SECONDS {
        return Err(ActionError::Expired);
    }
    if !super::valid_version(&input.version) {
        return Err(ActionError::Invalid);
    }
    let intent = input.intent.normalize().map_err(|_| ActionError::Invalid)?;
    let txn = db.begin().await?;
    let planned = plan::build(&txn, uid, intent, input.expires_at, true).await?;
    if planned.prepared.version != input.version {
        return Err(ActionError::Conflict);
    }
    let outcome = changes::apply(&txn, uid, planned, &input.version).await?;
    txn.commit().await?;
    Ok(outcome)
}

pub async fn prepare(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(intent): Json<Intent>,
) -> Response {
    let value = async {
        let uid = actor(&state, &headers)
            .await
            .map_err(|_| ActionError::Unauthorized)?;
        prepare_change(&state.db, uid, intent).await
    }
    .await;
    respond(value)
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Change>,
) -> Response {
    let value = async {
        let uid = actor(&state, &headers)
            .await
            .map_err(|_| ActionError::Unauthorized)?;
        let outcome = execute_change(&state.db, uid, input).await?;
        if !outcome.cleanup_pending_ids.is_empty() {
            super::deletions::wake(state.clone());
        }
        Ok(outcome)
    }
    .await;
    respond(value)
}

#[cfg(test)]
mod tests;
