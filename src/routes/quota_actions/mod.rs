//! Stable quota targets and guarded actions shared with legacy administrator APIs.

use crate::{
    entity::{quota_request, user},
    routes::AppState,
    utils::ApiResponse,
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use sea_orm::{ConnectionTrait, EntityTrait, FromQueryResult, QuerySelect};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) mod service;

#[derive(Clone, Debug, FromQueryResult)]
pub(super) struct Account {
    pub id: i32,
    pub username: String,
    pub role: String,
    pub status: i16,
    pub chat_quota_used: i32,
}

pub(super) async fn account<C: ConnectionTrait>(
    db: &C,
    id: i32,
    lock: bool,
) -> Result<Account, String> {
    let mut query = user::Entity::find_by_id(id).select_only().columns([
        user::Column::Id,
        user::Column::Username,
        user::Column::Role,
        user::Column::Status,
        user::Column::ChatQuotaUsed,
    ]);
    if lock {
        query = query.lock_exclusive();
    }
    query
        .into_model::<Account>()
        .one(db)
        .await
        .map_err(|e| {
            tracing::error!("quota account read failed id={id}: {e}");
            "账号读取失败".to_string()
        })?
        .ok_or_else(|| "账号不存在".to_string())
}

fn digest(value: serde_json::Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub(super) fn account_version(account: &Account) -> String {
    digest(serde_json::json!([
        account.id,
        account.username,
        account.role,
        account.status,
        account.chat_quota_used,
        super::quota::limit_of(&account.role)
    ]))
}

pub(super) fn request_version(row: &quota_request::Model, account: &Account) -> String {
    digest(serde_json::json!([
        row.id,
        row.user_id,
        row.reason,
        row.created_at.to_string(),
        row.status,
        row.note,
        row.handled_at.map(|at| at.to_string()),
        row.handled_by,
        account.id,
        account.username,
        account.role,
        account.status,
        super::quota::limit_of(&account.role)
    ]))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub user_id: i32,
    pub name: String,
    pub role: String,
    pub version: String,
    pub used: i32,
    pub limit: i32,
    pub unlimited: bool,
    pub unit: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSnapshot {
    pub id: i32,
    pub reason: Option<String>,
    pub status: i16,
    pub note: Option<String>,
    pub created_at: String,
    pub handled_at: Option<String>,
    pub handled_by: Option<i32>,
}

pub(super) fn snapshot(target: &Account, row: Option<&quota_request::Model>) -> Snapshot {
    let unlimited = crate::quota::is_unlimited(Some(&target.role));
    let view = crate::quota::view(target.chat_quota_used, crate::quota::limit(), unlimited);
    Snapshot {
        user_id: target.id,
        name: target.username.clone(),
        role: target.role.clone(),
        version: row
            .map(|row| request_version(row, target))
            .unwrap_or_else(|| account_version(target)),
        used: view.used,
        limit: view.limit,
        unlimited,
        unit: "conversation_turns",
        request: row.map(|row| RequestSnapshot {
            id: row.id,
            reason: row.reason.clone(),
            status: row.status,
            note: row.note.clone(),
            created_at: row.created_at.to_string(),
            handled_at: row.handled_at.map(|at| at.to_string()),
            handled_by: row.handled_by,
        }),
    }
}

pub(super) async fn request<C: ConnectionTrait>(
    db: &C,
    id: i32,
    lock: bool,
) -> Result<quota_request::Model, String> {
    let mut query = quota_request::Entity::find_by_id(id);
    if lock {
        query = query.lock_exclusive();
    }
    query
        .one(db)
        .await
        .map_err(|e| {
            tracing::error!("quota request read failed id={id}: {e}");
            "额度申请读取失败".to_string()
        })?
        .ok_or_else(|| "额度申请不存在".to_string())
}

pub async fn request_target(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<Snapshot>> {
    if crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .is_err()
    {
        return Json(ApiResponse::error("请先登录"));
    }
    let result = async {
        let row = request(&state.db, id, false).await?;
        let target = account(&state.db, row.user_id, false).await?;
        Ok::<_, String>(snapshot(&target, Some(&row)))
    }
    .await;
    Json(match result {
        Ok(value) => ApiResponse::success(value),
        Err(e) => ApiResponse::error(&e),
    })
}

pub async fn account_target(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<Snapshot>> {
    if crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .is_err()
    {
        return Json(ApiResponse::error("请先登录"));
    }
    Json(match account(&state.db, id, false).await {
        Ok(target) if crate::authz::is_listable_role(&target.role) => {
            ApiResponse::success(snapshot(&target, None))
        }
        Ok(_) => ApiResponse::error("该账号不能重置额度"),
        Err(e) => ApiResponse::error(&e),
    })
}

#[derive(Deserialize)]
pub struct Review {
    pub version: String,
    pub approved: bool,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct Reset {
    pub version: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub state: Snapshot,
    pub changed: bool,
}

pub async fn review(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(body): Json<Review>,
) -> Json<ApiResponse<Outcome>> {
    let operator = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(_) => return Json(ApiResponse::error("请先登录")),
    };
    let payload = super::quota::ReviewQuotaReq {
        approved: body.approved,
        reason: body.reason,
    };
    Json(
        match service::review(&state.db, operator, id, payload, Some(&body.version)).await {
            Ok(value) => ApiResponse::success(value),
            Err(e) => ApiResponse::error(&e),
        },
    )
}

pub async fn reset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(body): Json<Reset>,
) -> Json<ApiResponse<Outcome>> {
    if crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .is_err()
    {
        return Json(ApiResponse::error("请先登录"));
    }
    Json(
        match service::reset(&state.db, id, Some(&body.version)).await {
            Ok(value) => ApiResponse::success(value),
            Err(e) => ApiResponse::error(&e),
        },
    )
}

#[cfg(test)]
mod tests;
