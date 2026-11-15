//! Human draft changes are re-signed by the Agent; the host supplies verified identity.
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    conversation_id: i32,
    token: String,
    draft: Draft,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    prompt: String,
    model: String,
    size: String,
    quality: String,
}
fn failure(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"detail":message}))).into_response()
}
pub async fn handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<Revision>,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(_) => return failure(StatusCode::UNAUTHORIZED, "请重新登录"),
    };
    if req.token.is_empty()
        || req.token.len() > super::approval::MAX_CONFIRM_TOKEN_CHARS
        || req.draft.prompt.chars().count() > 32000
        || req.draft.model.len() > 200
        || req.draft.size.len() > 30
        || req.draft.quality.len() > 30
    {
        return failure(StatusCode::BAD_REQUEST, "生图参数无效");
    }
    if !matches!(
        super::resolve_conversation_id(&state.db, uid, Some(req.conversation_id), false).await,
        Ok(Some(_))
    ) {
        return failure(StatusCode::NOT_FOUND, "会话不存在");
    }
    let role = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(row)) if crate::authz::can_access_console(&row.role) => row.role,
        _ => return failure(StatusCode::FORBIDDEN, "仅管理员可修改生图请求"),
    };
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(client) => client,
        Err(_) => return failure(StatusCode::BAD_GATEWAY, "Agent 暂不可用"),
    };
    let response=match client.post(format!("{}/confirmation/image-revision",crate::ai_services::agent_base_url()))
        .header("X-Agent-Assertion",auth_jwt::create_agent_assertion(uid,Some(&role)))
        .json(&json!({"user_id":uid,"conversation_id":req.conversation_id,"token":req.token,"draft":req.draft}))
        .timeout(Duration::from_secs(30)).send().await {
        Ok(response)=>response,Err(_)=>return failure(StatusCode::BAD_GATEWAY,"未能核对修改结果，请刷新当前卡片"),
    };
    let status = response.status();
    let mut body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(_) => return failure(StatusCode::BAD_GATEWAY, "修改结果不可读取"),
    };
    if status.is_success() {
        if body["source_turn_id"]
            .as_str()
            .is_none_or(|value| value.is_empty())
            || body["event"]["jti"] != super::approval::token_jti(&req.token)
            || body["confirmation"]["token"].as_str().is_none()
            || !super::pending::cancel(&state.db, uid, req.conversation_id, &body["event"]).await
            || !super::pending::save_pending_action(
                &state.db,
                uid,
                req.conversation_id,
                body["source_turn_id"].as_str().unwrap_or(""),
                &body["pending_action"],
            )
            .await
        {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "卡片状态同步未完成，请刷新后核对",
            );
        }
    }
    if let Some(object) = body.as_object_mut() {
        object.remove("pending_action");
        object.remove("event");
        object.remove("source_turn_id");
    }
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response
}
