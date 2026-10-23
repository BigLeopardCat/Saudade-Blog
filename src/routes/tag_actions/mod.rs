//! Explicit tag identities and versioned dictionary changes.
mod targets;
#[cfg(test)]
mod tests;

use crate::{routes::AppState, utils::ApiResponse};
use axum::{extract::State, Json};
use sea_orm::{IsolationLevel, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Update,
    Delete,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: Option<i32>,
    pub name: Option<String>,
    pub level: Option<i16>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<i32>,
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fields {
    pub name: Option<String>,
    pub color: Option<String>,
    pub level: Option<i16>,
    pub parent: Option<Target>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub action: Action,
    pub target: Option<Target>,
    #[serde(default)]
    pub fields: Fields,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tag {
    pub id: Option<i32>,
    pub level: i16,
    pub name: String,
    pub color: Option<String>,
    pub parent_id: Option<i32>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: String,
    pub before: Option<Tag>,
    pub after: Option<Tag>,
    pub parent: Option<Tag>,
    pub child_count: u64,
    pub article_count: u64,
    pub revision_count: u64,
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
    pub changed: bool,
    pub before_version: String,
    pub state: Prepared,
}

async fn apply<C: sea_orm::ConnectionTrait>(
    db: &C,
    change: &Change,
) -> Result<Outcome, sea_orm::DbErr> {
    let mut snapshot = targets::snapshot(db, &change.intent, true).await?;
    if change.version.len() != 64 || change.version != snapshot.plan.version {
        return Err(targets::failure(
            "标签、父级或文章引用已变化，请重新核对并确认",
        ));
    }
    let changed = snapshot.plan.before != snapshot.plan.after;
    if changed {
        targets::apply(db, &mut snapshot).await?;
    }
    Ok(Outcome {
        changed,
        before_version: change.version.clone(),
        state: snapshot.plan,
    })
}
fn response<T: Default>(result: Result<T, sea_orm::DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("tag action failed: {error}");
            let message = match error {
                sea_orm::DbErr::Custom(v) => v,
                _ => "标签请求失败，可能存在并发修改；请先查询实际状态".to_owned(),
            };
            Json(ApiResponse::error(&message))
        }
    }
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    Json(intent): Json<Intent>,
) -> Json<ApiResponse<Prepared>> {
    response(
        async {
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
                .await?;
            let plan = targets::snapshot(&txn, &intent, false).await?.plan;
            txn.commit().await?;
            Ok(plan)
        }
        .await,
    )
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    response(
        async {
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::Serializable), None)
                .await?;
            let result = apply(&txn, &change).await?;
            txn.commit().await?;
            Ok(result)
        }
        .await,
    )
}
