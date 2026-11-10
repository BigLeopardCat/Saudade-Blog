//! Browser task management delegates to the Agent's checkpoint and DBOS services.
use crate::{auth_jwt, entity::user, routes::AppState};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

fn failure(status: StatusCode, error: &str) -> Response {
    (
        status,
        [("Cache-Control", "no-store")],
        Json(json!({"error":error})),
    )
        .into_response()
}
fn success(value: Value) -> Response {
    ([("Cache-Control", "no-store")], Json(value)).into_response()
}
async fn actor(state: &AppState, headers: &HeaderMap) -> Result<(i32, String, i32), Response> {
    let uid = auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let row = user::Entity::find_by_id(uid)
        .one(&state.db)
        .await
        .ok()
        .flatten()
        .filter(|row| crate::authz::is_known_role(&row.role))
        .ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE, "identity_unavailable"))?;
    let version = auth_jwt::claims_from_headers(headers).and_then(|c| c.ver);
    crate::authz::check_token(row.status, row.token_version, version)
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    Ok((uid, row.role, row.token_version))
}
async fn call(
    path: &str,
    uid: i32,
    role: &str,
    version: i32,
    body: Option<Value>,
) -> Result<Value, Response> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|_| failure(StatusCode::BAD_GATEWAY, "agent_unavailable"))?;
    let url = format!("{}/{}", super::super::graph::agent_base_url(), path);
    let req = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    let mut response = req
        .header(
            "X-Agent-Assertion",
            auth_jwt::create_tool_assertion(uid, Some(role), version),
        )
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| failure(StatusCode::BAD_GATEWAY, "agent_unavailable"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(failure(status, "task_service_rejected"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| failure(StatusCode::BAD_GATEWAY, "invalid_agent_response"))?
    {
        if bytes.len() + chunk.len() > 128 * 1024 {
            return Err(failure(StatusCode::BAD_GATEWAY, "agent_response_too_large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| failure(StatusCode::BAD_GATEWAY, "invalid_agent_response"))
}

pub async fn service_status() -> Response {
    let ready = match reqwest::Client::builder().no_proxy().build() {
        Ok(client) => match client
            .get(format!("{}/ready", super::super::graph::agent_base_url()))
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        },
        Err(_) => false,
    };
    (
        [("Cache-Control", "public, max-age=10")],
        Json(json!({"ready":ready})),
    )
        .into_response()
}

pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let (uid, role, version) = match actor(&state, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let paused = match call(
        &format!("tasks/paused?user_id={uid}&limit=20"),
        uid,
        &role,
        version,
        None,
    )
    .await
    {
        Ok(v) => v,
        Err(_) => json!({"items":[],"unavailable":true}),
    };
    let schedules = if crate::authz::can_access_console(&role) {
        // The scheduling service is optional; a failure is exposed, never an empty success.
        match call(
            "automations?limit=20&active_only=true",
            uid,
            &role,
            version,
            None,
        )
        .await
        {
            Ok(v) => v,
            Err(_) => json!({"items":[],"unavailable":true}),
        }
    } else {
        json!({"items":[]})
    };
    let images = if crate::authz::can_access_console(&role) {
        match crate::routes::image_generation::tasks::list(&state, uid).await {
            Ok(mut items) => {
                let has_more = items.len() > 20;
                items.truncate(20);
                json!({"items":items,"has_more":has_more})
            }
            Err(error) => {
                tracing::warn!(%error, uid, "image task list unavailable");
                json!({"items":[],"unavailable":true})
            }
        }
    } else {
        json!({"items":[]})
    };
    success(
        json!({"paused":paused,"schedules":schedules,"images":images,
                   "server_time":chrono::Utc::now().to_rfc3339()}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelPaused {
    conversation_id: i32,
    task_id: String,
}
pub async fn cancel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CancelPaused>,
) -> Response {
    let (uid, role, version) = match actor(&state, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if req.task_id.is_empty()
        || req.task_id.len() > 100
        || !req
            .task_id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_' || v == b'-')
    {
        return failure(StatusCode::BAD_REQUEST, "invalid_task");
    }
    if !matches!(
        super::resolve_conversation_id(&state.db, uid, Some(req.conversation_id), false).await,
        Ok(Some(_))
    ) {
        return failure(StatusCode::NOT_FOUND, "conversation_not_found");
    }
    match call(
        "tasks/cancel",
        uid,
        &role,
        version,
        Some(json!({"user_id":uid,"conversation_id":req.conversation_id,"task_id":req.task_id})),
    )
    .await
    {
        Ok(v) => success(v),
        Err(r) => r,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleControl {
    schedule_id: String,
    version: String,
}
pub async fn cancel_schedule(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ScheduleControl>,
) -> Response {
    let (uid, role, version) = match actor(&state, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !crate::authz::can_access_console(&role) {
        return failure(StatusCode::FORBIDDEN, "administrator_required");
    }
    if req.schedule_id.len() != 35
        || !req.schedule_id.starts_with("sc_")
        || !req.schedule_id[3..].bytes().all(|v| v.is_ascii_hexdigit())
        || req.version.len() != 64
        || !req.version.bytes().all(|v| v.is_ascii_hexdigit())
    {
        return failure(StatusCode::BAD_REQUEST, "invalid_schedule");
    }
    match call(
        "automations/control",
        uid,
        &role,
        version,
        Some(json!({"schedule_id":req.schedule_id,"action":"cancel","version":req.version})),
    )
    .await
    {
        Ok(v) => success(v),
        Err(r) => r,
    }
}
