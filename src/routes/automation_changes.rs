//! Immutable scheduled changes reuse domain transactions and commit their receipt atomically.
use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseTransaction, DbErr, IsolationLevel, Statement,
    TransactionTrait,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Failure = (StatusCode, Json<ApiResponse<Value>>);
fn failure(status: StatusCode, message: &str) -> Failure {
    (status, Json(ApiResponse::error(message)))
}
fn storage(error: DbErr) -> Failure {
    match error {
        DbErr::Custom(message) => failure(StatusCode::CONFLICT, &message),
        other => {
            tracing::error!(%other, "scheduled business transaction failed");
            failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "无法确认定时变更结果，请查询执行记录",
            )
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    content = "change",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Change {
    Categories(super::category_actions::Change),
    Talks(super::talk_actions::Change),
    GalleryFolders(super::gallery::folder_actions::Change),
    ArticleDeletions(super::article_deletions::Change),
    AccountActions(super::account_actions::Change),
    Notices(super::notice_actions::Change),
    ArticleState(super::article_actions::batch::BatchChange),
    ArticleTags(super::article_tag_actions::batch::Change),
    Tags(super::tag_actions::Change),
    Announcements(super::announcement_actions::Change),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub(super) run_id: String,
    pub(super) write: Value,
}

async fn execute(
    db: &DatabaseTransaction,
    owner: i32,
    actor_version: i32,
    value: Change,
) -> Result<Value, DbErr> {
    let result = match value {
        Change::Talks(change) => {
            serde_json::to_value(super::talk_actions::apply(db, owner, &change).await?)
        }
        Change::GalleryFolders(change) => {
            serde_json::to_value(super::gallery::folder_actions::apply(db, &change).await?)
        }
        Change::ArticleDeletions(change) => {
            serde_json::to_value(super::article_deletions::apply(db, &change).await?)
        }
        Change::AccountActions(change) => serde_json::to_value(
            super::account_actions::apply_in(db, owner, Some(actor_version), &change).await?,
        ),
        Change::Notices(change) => {
            serde_json::to_value(super::notice_actions::apply(db, owner, &change).await?)
        }
        Change::ArticleState(change) => {
            serde_json::to_value(super::article_actions::batch::apply(db, &change).await?)
        }
        Change::ArticleTags(change) => {
            serde_json::to_value(super::article_tag_actions::batch::apply(db, &change).await?)
        }
        Change::Categories(change) => {
            serde_json::to_value(super::category_actions::apply(db, &change).await?)
        }
        Change::Tags(change) => serde_json::to_value(super::tag_actions::apply(db, &change).await?),
        Change::Announcements(change) => {
            serde_json::to_value(super::announcement_actions::apply(db, &change).await?)
        }
    };
    result.map_err(|error| DbErr::Custom(error.to_string()))
}
pub(super) async fn apply(
    db: &DatabaseTransaction,
    owner: i32,
    request: &Request,
) -> Result<Value, Failure> {
    if request.run_id.is_empty()
        || request.run_id.len() > 200
        || !request
            .run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(failure(StatusCode::UNPROCESSABLE_ENTITY, "执行编号无效"));
    }
    let change = serde_json::from_value::<Change>(request.write.clone())
        .map_err(|_| failure(StatusCode::UNPROCESSABLE_ENTITY, "定时变更格式无效"))?;
    let actor = super::automation_results::authorized(db, owner, true).await?;
    let digest = hex::encode(Sha256::digest(request.write.to_string().as_bytes()));
    let claimed = db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO automation_change_delivery(owner_id,run_id,payload_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [owner.into(),request.run_id.clone().into(),digest.clone().into()])).await.map_err(storage)?;
    if claimed.rows_affected() == 0 {
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "SELECT payload_hash,outcome FROM automation_change_delivery WHERE owner_id=$1 AND run_id=$2",
            [owner.into(),request.run_id.clone().into()])).await.map_err(storage)?
            .ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE,"无法核对定时执行状态"))?;
        let previous: String = row.try_get("", "payload_hash").map_err(storage)?;
        if previous != digest {
            return Err(failure(StatusCode::CONFLICT, "执行编号已绑定其他变更"));
        }
        let outcome: Value = row.try_get("", "outcome").map_err(storage)?;
        if outcome.is_null() {
            return Err(failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "执行结果未确认，请先查询",
            ));
        }
        return Ok(json!({"payloadHash":digest,"replayed":true,"outcome":outcome}));
    }
    let outcome = execute(db, owner, actor.token_version, change)
        .await
        .map_err(storage)?;
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE automation_change_delivery SET outcome=$3 WHERE owner_id=$1 AND run_id=$2",
        [
            owner.into(),
            request.run_id.clone().into(),
            outcome.clone().into(),
        ],
    ))
    .await
    .map_err(storage)?;
    Ok(json!({"payloadHash":digest,"replayed":false,"outcome":outcome}))
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<Json<ApiResponse<Value>>, Failure> {
    let owner = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .map_err(storage)?;
    let receipt = apply(&txn, owner, &request).await?;
    txn.commit().await.map_err(storage)?;
    Ok(Json(ApiResponse::success(receipt)))
}
#[cfg(test)]
mod tests;
