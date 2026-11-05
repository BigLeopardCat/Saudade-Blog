//! Approved scheduled publications use the existing announcement transaction and a durable run key.
use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DbErr, IsolationLevel, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Failure = (StatusCode, Json<ApiResponse<serde_json::Value>>);
fn failure(status: StatusCode, message: &str) -> Failure {
    (status, Json(ApiResponse::error(message)))
}
fn storage_error(error: DbErr) -> Failure {
    tracing::error!(%error, "scheduled announcement storage failed");
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "定时公告暂未确认发布，请查询执行结果",
    )
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publication {
    run_id: String,
    title: String,
    content: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    announcement_id: Option<i32>,
    notification_count: i64,
    payload_hash: String,
    replayed: bool,
}
fn intent(value: &Publication) -> super::announcement_actions::Intent {
    super::announcement_actions::Intent {
        action: super::announcement_actions::Action::Create,
        target: None,
        fields: super::announcement_actions::Fields {
            title: Some(value.title.clone()),
            content: Some(value.content.clone()),
        },
    }
}
fn validate(value: &Publication) -> Result<(), Failure> {
    if value.run_id.is_empty()
        || value.run_id.len() > 200
        || !value
            .run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(failure(StatusCode::UNPROCESSABLE_ENTITY, "执行编号无效"));
    }
    super::announcement_actions::validate_creation(&intent(value))
        .map_err(|_| failure(StatusCode::UNPROCESSABLE_ENTITY, "公告标题或正文无效"))
}
async fn apply<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    value: &Publication,
) -> Result<Receipt, Failure> {
    validate(value)?;
    super::automation_results::authorized(db, owner, true).await?;
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&(&value.title, &value.content)).unwrap(),
    ));
    let claim = db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO automation_announcement_delivery (owner_id,run_id,payload_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [owner.into(),value.run_id.clone().into(),digest.clone().into()])).await.map_err(storage_error)?;
    if claim.rows_affected() == 0 {
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "SELECT payload_hash,announcement_id,notification_count FROM automation_announcement_delivery WHERE owner_id=$1 AND run_id=$2",
            [owner.into(),value.run_id.clone().into()])).await.map_err(storage_error)?
            .ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE,"无法核对公告发布状态"))?;
        let previous: String = row.try_get("", "payload_hash").map_err(storage_error)?;
        if previous != digest {
            return Err(failure(StatusCode::CONFLICT, "执行编号已绑定其他公告内容"));
        }
        return Ok(Receipt {
            announcement_id: row.try_get("", "announcement_id").map_err(storage_error)?,
            notification_count: row
                .try_get("", "notification_count")
                .map_err(storage_error)?,
            payload_hash: digest,
            replayed: true,
        });
    }
    // Content is frozen at approval; recipients are explicitly all accounts present at execution.
    let outcome = super::announcement_actions::apply_current(db, intent(value))
        .await
        .map_err(storage_error)?;
    let announcement_id = outcome
        .state
        .after
        .and_then(|row| row.id)
        .ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE, "公告发布回执缺少编号"))?;
    let count = i64::try_from(outcome.state.notification_count)
        .map_err(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "公告通知计数无效"))?;
    db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "UPDATE automation_announcement_delivery SET announcement_id=$3,notification_count=$4 WHERE owner_id=$1 AND run_id=$2",
        [owner.into(),value.run_id.clone().into(),announcement_id.into(),count.into()])).await.map_err(storage_error)?;
    Ok(Receipt {
        announcement_id: Some(announcement_id),
        notification_count: count,
        payload_hash: digest,
        replayed: false,
    })
}
pub async fn publish(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Publication>,
) -> Result<Json<ApiResponse<Receipt>>, Failure> {
    let uid = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .map_err(storage_error)?;
    let result = apply(&txn, uid, &value).await?;
    txn.commit().await.map_err(storage_error)?;
    Ok(Json(ApiResponse::success(result)))
}
#[cfg(test)]
mod tests;
