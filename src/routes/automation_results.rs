//! Owner-only, idempotent delivery of background task results.

use crate::{authz, entity::user, routes::AppState, utils::ApiResponse};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Failure = (StatusCode, Json<ApiResponse<serde_json::Value>>);
fn failure(status: StatusCode, message: &str) -> Failure {
    (status, Json(ApiResponse::error(message)))
}
fn storage_error(error: DbErr) -> Failure {
    tracing::error!("automation result storage failed: {error}");
    failure(StatusCode::SERVICE_UNAVAILABLE, "任务结果服务暂不可用")
}
#[derive(Serialize)]
pub struct Actor {
    id: i32,
    role: String,
}

async fn authorized<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    lock: bool,
) -> Result<user::Model, Failure> {
    let mut query = user::Entity::find_by_id(owner);
    if lock {
        query = query.lock(sea_orm::sea_query::LockType::Share);
    }
    let actor = query
        .one(db)
        .await
        .map_err(storage_error)?
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "账号已失效"))?;
    if authz::is_frozen(actor.status) || !authz::can_access_console(&actor.role) {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "仅有效管理员可以使用后台计划任务",
        ));
    }
    Ok(actor)
}
pub async fn actor(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<Actor>>, Failure> {
    let uid = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let row = authorized(&state.db, uid, false).await?;
    Ok(Json(ApiResponse::success(Actor {
        id: row.id,
        role: row.role,
    })))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delivery {
    run_id: String,
    title: String,
    content: String,
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    notification_id: Option<i32>,
    replayed: bool,
}

fn validate(value: &Delivery) -> Result<(), Failure> {
    if value.run_id.is_empty()
        || value.run_id.len() > 200
        || !value
            .run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || value.title.trim().is_empty()
        || value.title.chars().count() > 80
        || value.content.trim().is_empty()
        || value.content.chars().count() > 1000
        || value.title.contains('\0')
        || value.content.contains('\0')
    {
        return Err(failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "执行编号、标题或正文无效",
        ));
    }
    Ok(())
}
async fn apply<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    value: &Delivery,
) -> Result<Receipt, Failure> {
    validate(value)?;
    authorized(db, owner, true).await?;
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&(&value.title, &value.content)).unwrap(),
    ));
    let claim = db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO automation_result_delivery (owner_id,run_id,payload_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [owner.into(), value.run_id.clone().into(), digest.clone().into()])).await.map_err(storage_error)?;
    if claim.rows_affected() == 0 {
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "SELECT payload_hash,notification_id FROM automation_result_delivery WHERE owner_id=$1 AND run_id=$2",
            [owner.into(), value.run_id.clone().into()])).await.map_err(storage_error)?
            .ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE, "无法核对任务投递状态"))?;
        let previous: String = row.try_get("", "payload_hash").map_err(storage_error)?;
        if previous != digest {
            return Err(failure(StatusCode::CONFLICT, "执行编号已对应其他结果"));
        }
        return Ok(Receipt {
            notification_id: row.try_get("", "notification_id").map_err(storage_error)?,
            replayed: true,
        });
    }
    let notification_id = super::notice::push_notice_checked(
        db,
        owner,
        &value.title,
        Some(value.content.clone()),
        None,
    )
    .await
    .map_err(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "任务结果通知未能保存"))?;
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE automation_result_delivery SET notification_id=$3 WHERE owner_id=$1 AND run_id=$2",
        [
            owner.into(),
            value.run_id.clone().into(),
            notification_id.into(),
        ],
    ))
    .await
    .map_err(storage_error)?;
    Ok(Receipt {
        notification_id: Some(notification_id),
        replayed: false,
    })
}

pub async fn deliver(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Delivery>,
) -> Result<Json<ApiResponse<Receipt>>, Failure> {
    let uid = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let txn = state.db.begin().await.map_err(storage_error)?;
    let result = apply(&txn, uid, &value).await?;
    txn.commit().await.map_err(storage_error)?;
    Ok(Json(ApiResponse::success(result)))
}

#[cfg(test)]
mod tests;
