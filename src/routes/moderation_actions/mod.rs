//! Version-bound administrator moderation with atomic notification delivery.

use crate::{entity::user, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{EntityTrait, QuerySelect};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

mod mutations;
mod targets;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Resource {
    Boards,
    Comments,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Pass,
    Reject,
    Delete,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    action: Action,
    version: String,
}

async fn operator(state: &AppState, headers: &HeaderMap) -> Result<i32, &'static str> {
    let uid = crate::auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|error| error.message())?;
    let role = user::Entity::find_by_id(uid)
        .select_only()
        .column(user::Column::Role)
        .into_tuple::<String>()
        .one(&state.db)
        .await
        .map_err(|_| "无法核对管理员身份")?;
    if !role
        .as_deref()
        .is_some_and(crate::authz::can_access_console)
    {
        return Err("当前身份无权管理审核内容");
    }
    Ok(uid)
}

pub async fn target(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((resource, id)): Path<(Resource, i32)>,
) -> Json<ApiResponse<targets::View>> {
    if let Err(error) = operator(&state, &headers).await {
        return Json(ApiResponse::error(error));
    }
    if id <= 0 {
        return Json(ApiResponse::error("内容编号无效"));
    }
    match targets::load(&state.db, resource, id, false).await {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::error!("moderation target failed id={id}: {error}");
            Json(ApiResponse::error("无法核对审核目标，请稍后再试"))
        }
    }
}

pub async fn apply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((resource, id)): Path<(Resource, i32)>,
    Json(change): Json<Change>,
) -> Json<ApiResponse<mutations::Receipt>> {
    let uid = match operator(&state, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error)),
    };
    if id <= 0
        || change.version.len() != 64
        || !change.version.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Json(ApiResponse::error("内容编号或版本无效"));
    }
    match mutations::apply(&state.db, uid, resource, id, &change).await {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("conditional moderation failed id={id}: {error}");
            Json(ApiResponse::error(
                "目标已变化或审核事务失败，请重新读取并确认",
            ))
        }
    }
}
