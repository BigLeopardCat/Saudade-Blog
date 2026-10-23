//! Exact, versioned single-recipient notices. Preparation never writes.
mod targets;
#[cfg(test)]
mod tests;

use crate::{routes::AppState, utils::ApiResponse};
use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{ConnectionTrait, EntityTrait, IsolationLevel, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: Option<i32>,
    pub username: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub target: Target,
    pub title: Option<String>,
    pub content: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Recipient {
    pub id: i32,
    pub username: String,
    pub role: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub version: String,
    pub recipient: Recipient,
    pub title: String,
    pub content: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub intent: Intent,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub notification_id: i32,
    pub delivered: bool,
    pub state: Prepared,
}

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    actor: i32,
    change: &Change,
) -> Result<Outcome, sea_orm::DbErr> {
    let plan = targets::prepare(db, actor, &change.intent, true).await?;
    if change.version.len() != 64 || plan.version != change.version {
        return Err(targets::failure("收件人或操作权限已变化，请重新核对并确认"));
    }
    let id = super::notice::push_notice_checked(
        db,
        plan.recipient.id,
        &plan.title,
        Some(plan.content.clone()),
        None,
    )
    .await
    .map_err(|_| targets::failure("通知发送失败，请先查询实际状态"))?;
    let row = crate::entity::user_notification::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| targets::failure("通知写入结果无法核对"))?;
    if row.user_id != plan.recipient.id
        || row.kind != super::notice::KIND_NOTICE
        || row.title != plan.title
        || row.content.as_deref() != Some(plan.content.as_str())
        || row.link.is_some()
        || row.announcement_id.is_some()
    {
        return Err(targets::failure("实际通知与确认内容不一致"));
    }
    Ok(Outcome {
        notification_id: id,
        delivered: true,
        state: plan,
    })
}
fn response<T: Default>(result: Result<T, sea_orm::DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(e) => {
            tracing::warn!("notice action failed: {e}");
            let message = match e {
                sea_orm::DbErr::Custom(m) => m,
                _ => "通知请求失败，请先核对实际状态".to_owned(),
            };
            Json(ApiResponse::error(&message))
        }
    }
}
async fn actor(state: &AppState, headers: &HeaderMap) -> Result<i32, sea_orm::DbErr> {
    crate::auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| targets::failure("未登录"))
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(intent): Json<Intent>,
) -> Json<ApiResponse<Prepared>> {
    response(
        async {
            let uid = actor(&state, &headers).await?;
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
                .await?;
            let plan = targets::prepare(&txn, uid, &intent, false).await?;
            txn.commit().await?;
            Ok(plan)
        }
        .await,
    )
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    response(
        async {
            let uid = actor(&state, &headers).await?;
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::Serializable), None)
                .await?;
            let result = apply(&txn, uid, &change).await?;
            txn.commit().await?;
            Ok(result)
        }
        .await,
    )
}

/// Legacy forms normalize their fields, then use the same exact transaction service.
pub(super) async fn legacy_send(
    state: &AppState,
    headers: &HeaderMap,
    id: i32,
    title: Option<String>,
    content: String,
) -> Json<ApiResponse<String>> {
    response(
        async {
            let uid = actor(state, headers).await?;
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::Serializable), None)
                .await?;
            let intent = Intent {
                target: Target {
                    id: Some(id),
                    username: None,
                },
                title: title.map(|v| v.trim().to_owned()),
                content: content.trim().to_owned(),
            };
            let prepared = targets::prepare(&txn, uid, &intent, true).await?;
            let result = apply(
                &txn,
                uid,
                &Change {
                    version: prepared.version,
                    intent,
                },
            )
            .await?;
            txn.commit().await?;
            Ok(format!(
                "已把通知发给「{}」",
                result.state.recipient.username
            ))
        }
        .await,
    )
}
