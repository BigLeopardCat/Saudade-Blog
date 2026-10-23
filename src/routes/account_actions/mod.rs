//! Exact account actions: read-only plans and independently authorized, atomic changes.
mod model;
#[cfg(test)]
mod postgres_tests;
mod targets;
#[cfg(test)]
mod tests;
mod transaction;
pub use model::*;

use crate::{routes::AppState, utils::ApiResponse};
use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{DbErr, IsolationLevel, TransactionTrait};
use std::sync::Arc;

fn response<T: Default>(result: Result<T, DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            let message = match error {
                DbErr::Custom(value) => value,
                other => {
                    tracing::warn!(%other, "account action transaction failed");
                    "账号请求失败或结果未知，请重新查询，不要自动重复提交".to_owned()
                }
            };
            Json(ApiResponse::error(&message))
        }
    }
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(intent): Json<Intent>,
) -> Json<ApiResponse<Prepared>> {
    let result = async {
        let actor = crate::auth_jwt::claims_from_headers(&headers)
            .ok_or_else(|| targets::failure("未登录"))?;
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
            .await?;
        let (plan, _, _) = targets::prepare(&txn, actor.sub, actor.ver, &intent, false).await?;
        txn.commit().await?;
        Ok(plan)
    }
    .await;
    response(result)
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    response(execute(&state, &headers, &change.intent, Some(&change.version)).await)
}
/// Legacy handlers use the same locks, policy, update verification and mandatory notice transaction.
/// Only signed Agent confirmation uses an expected version; direct admin UI writes remain direct.
pub(super) async fn execute(
    state: &AppState,
    headers: &HeaderMap,
    intent: &Intent,
    version: Option<&str>,
) -> Result<Outcome, DbErr> {
    let actor =
        crate::auth_jwt::claims_from_headers(headers).ok_or_else(|| targets::failure("未登录"))?;
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await?;
    let outcome = transaction::apply(&txn, actor.sub, actor.ver, intent, version).await?;
    txn.commit().await?;
    tracing::info!(actor_id = actor.sub, target_id = outcome.state.after.id,
        action = ?intent.action, changed = outcome.changed,
        revoke_sessions = outcome.state.revoke_sessions, "account action committed");
    Ok(outcome)
}
