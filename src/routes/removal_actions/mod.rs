//! Frozen deletion batches: global announcements and caller-owned notification copies.
mod targets;
#[cfg(test)]
mod tests;

use crate::{routes::AppState, utils::ApiResponse};
use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{ConnectionTrait, IsolationLevel, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_ITEMS: usize = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Resource {
    Announcements,
    Notifications,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    #[default]
    All,
    Notice,
    Announcement,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Selected,
    All,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub scope: Scope,
    #[serde(default)]
    pub ids: Vec<i32>,
    #[serde(default)]
    pub kind: Kind,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub ids: Vec<i32>,
    #[serde(default)]
    pub kind: Kind,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Preview {
    pub id: i32,
    pub title: String,
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: String,
    pub ids: Vec<i32>,
    pub items: Vec<Preview>,
    pub count: usize,
    pub associated_notifications: u64,
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub version: String,
    pub deleted_ids: Vec<i32>,
    pub associated_notifications: u64,
}

fn failure(message: &str) -> sea_orm::DbErr {
    sea_orm::DbErr::Custom(message.into())
}
fn validate(selection: &Selection, resource: Resource) -> Result<(), sea_orm::DbErr> {
    if selection.ids.len() > MAX_ITEMS
        || selection.ids.iter().any(|id| *id <= 0)
        || selection
            .ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != selection.ids.len()
        || (selection.scope == Scope::All && !selection.ids.is_empty())
        || (selection.scope == Scope::Selected && selection.ids.is_empty())
        || (resource == Resource::Announcements && selection.kind != Kind::All)
    {
        return Err(failure(
            "删除范围无效；请选择全部或1至1000个不同的正整数编号",
        ));
    }
    Ok(())
}

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    resource: Resource,
    change: &Change,
) -> Result<Outcome, sea_orm::DbErr> {
    let request = Selection {
        scope: Scope::Selected,
        ids: change.ids.clone(),
        kind: change.kind,
    };
    let snapshot = targets::snapshot(db, uid, resource, &request, true).await?;
    if change.version.len() != 64 || snapshot.plan.version != change.version {
        return Err(failure("删除目标或内容已变化，请重新核对并确认"));
    }
    match resource {
        Resource::Announcements => {
            for (id, version) in snapshot.announcement_versions {
                super::announcement_actions::apply_deletion(db, id, version).await?;
            }
        }
        Resource::Notifications => {
            targets::remove_notifications(db, uid, &snapshot.plan.ids).await?
        }
    }
    Ok(Outcome {
        version: change.version.clone(),
        deleted_ids: snapshot.plan.ids,
        associated_notifications: snapshot.plan.associated_notifications,
    })
}
fn response<T: Default>(result: Result<T, sea_orm::DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("removal action failed: {error}");
            let message = match error {
                sea_orm::DbErr::Custom(text) => text,
                _ => "删除请求失败或发生并发修改，请先查询实际状态".into(),
            };
            Json(ApiResponse::error(&message))
        }
    }
}
async fn prepare(
    state: &AppState,
    headers: &HeaderMap,
    resource: Resource,
    request: Selection,
) -> Result<Prepared, sea_orm::DbErr> {
    let uid = crate::auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| failure("未登录"))?;
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
        .await?;
    let snapshot = targets::snapshot(&txn, uid, resource, &request, false).await?;
    txn.commit().await?;
    Ok(snapshot.plan)
}
async fn change(
    state: &AppState,
    headers: &HeaderMap,
    resource: Resource,
    request: Change,
) -> Result<Outcome, sea_orm::DbErr> {
    let uid = crate::auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| failure("未登录"))?;
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await?;
    let outcome = apply(&txn, uid, resource, &request).await?;
    txn.commit().await?;
    Ok(outcome)
}
pub async fn prepare_announcements(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Selection>,
) -> Json<ApiResponse<Prepared>> {
    response(prepare(&state, &headers, Resource::Announcements, request).await)
}
pub async fn change_announcements(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    response(change(&state, &headers, Resource::Announcements, request).await)
}
pub async fn prepare_notifications(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Selection>,
) -> Json<ApiResponse<Prepared>> {
    response(prepare(&state, &headers, Resource::Notifications, request).await)
}
pub async fn change_notifications(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    response(change(&state, &headers, Resource::Notifications, request).await)
}
