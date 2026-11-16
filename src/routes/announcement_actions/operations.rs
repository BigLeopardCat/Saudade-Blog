//! Operation identity, announcement changes and receipts commit in one business transaction.

use super::{Change, Outcome};
use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseTransaction, DbErr, IsolationLevel, Statement,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Failure = (StatusCode, Json<ApiResponse<Value>>);

fn failure(status: StatusCode, message: &str) -> Failure {
    (status, Json(ApiResponse::error(message)))
}

fn storage(error: DbErr) -> Failure {
    tracing::error!(%error, "announcement operation storage failed");
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "公告操作结果暂时无法确认，请按原操作编号查询",
    )
}

fn validate_id(id: &str) -> Result<(), Failure> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "公告操作编号无效",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub change: Change,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub operation_id: String,
    pub request_hash: String,
    pub outcome: Outcome,
}

/// Fixed-position JSON avoids cross-language object-key ordering and omitted-null differences.
fn fingerprint(change: &Change) -> String {
    let target = change.intent.target.as_ref();
    let payload = json!([
        change.version,
        change.intent.action,
        target.and_then(|t| t.id),
        target.and_then(|t| t.title.as_deref()),
        change.intent.fields.title,
        change.intent.fields.content,
    ]);
    hex::encode(Sha256::digest(payload.to_string().as_bytes()))
}

async fn stored<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    id: &str,
) -> Result<Option<Receipt>, Failure> {
    let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT request_hash,outcome FROM announcement_operation WHERE owner_id=$1 AND operation_id=$2",
        [owner.into(), id.into()])).await.map_err(storage)?;
    row.map(|row| {
        let value: Option<Value> = row.try_get("", "outcome").map_err(storage)?;
        let outcome =
            serde_json::from_value(value.ok_or_else(|| {
                failure(StatusCode::SERVICE_UNAVAILABLE, "公告操作回执尚未完整保存")
            })?)
            .map_err(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "公告操作回执无法核对"))?;
        Ok(Receipt {
            operation_id: id.to_owned(),
            request_hash: row.try_get("", "request_hash").map_err(storage)?,
            outcome,
        })
    })
    .transpose()
}

pub(super) async fn apply(
    db: &DatabaseTransaction,
    owner: i32,
    value: &Request,
) -> Result<Receipt, Failure> {
    validate_id(&value.operation_id)?;
    crate::routes::automation_results::authorized(db, owner, true).await?;
    let digest = fingerprint(&value.change);
    let claimed = db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO announcement_operation(owner_id,operation_id,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [owner.into(), value.operation_id.clone().into(), digest.clone().into()]))
        .await.map_err(storage)?.rows_affected() == 1;
    if !claimed {
        let previous = stored(db, owner, &value.operation_id)
            .await?
            .ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE, "公告操作状态无法核对"))?;
        if previous.request_hash != digest {
            return Err(failure(StatusCode::CONFLICT, "公告操作编号已绑定其他请求"));
        }
        return Ok(previous);
    }
    let outcome = super::apply(db, &value.change)
        .await
        .map_err(|error| match error {
            DbErr::Custom(message) => failure(StatusCode::CONFLICT, &message),
            other => storage(other),
        })?;
    let encoded = serde_json::to_value(&outcome)
        .map_err(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "公告操作回执无法保存"))?;
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE announcement_operation SET outcome=$3 WHERE owner_id=$1 AND operation_id=$2",
        [
            owner.into(),
            value.operation_id.clone().into(),
            encoded.into(),
        ],
    ))
    .await
    .map_err(storage)?;
    Ok(Receipt {
        operation_id: value.operation_id.clone(),
        request_hash: digest,
        outcome,
    })
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Request>,
) -> Result<Json<ApiResponse<Receipt>>, Failure> {
    let owner = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .map_err(storage)?;
    let receipt = apply(&txn, owner, &value).await?;
    txn.commit().await.map_err(storage)?;
    Ok(Json(ApiResponse::success(receipt)))
}

pub async fn read(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<Value>>, Failure> {
    validate_id(&id)?;
    let owner = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let txn = state.db.begin().await.map_err(storage)?;
    crate::routes::automation_results::authorized(&txn, owner, true).await?;
    let value = match stored(&txn, owner, &id).await? {
        Some(receipt) => json!({"status":"completed", "receipt":receipt}),
        None => json!({"status":"absent", "operationId":id}),
    };
    txn.commit().await.map_err(storage)?;
    Ok(Json(ApiResponse::success(value)))
}

#[cfg(test)]
mod tests;
