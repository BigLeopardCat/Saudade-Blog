//! Human draft changes are re-signed by the Agent; the host supplies verified identity.
use crate::{auth_jwt, routes::AppState};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
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

async fn revision_assertion(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(i32, String), Response> {
    if auth_jwt::claims_from_headers(headers)
        .is_some_and(|claims| claims.aud.as_deref() == Some("blog-tools"))
    {
        return Err(failure(StatusCode::UNAUTHORIZED, "请使用有效的登录会话"));
    }
    let (uid, role, version) = super::task_manager::actor(state, headers).await?;
    if !crate::authz::can_access_console(&role) {
        return Err(failure(StatusCode::FORBIDDEN, "仅管理员可修改生图请求"));
    }
    let assertion = auth_jwt::create_tool_assertion(uid, Some(&role), version);
    if assertion.is_empty() {
        return Err(failure(StatusCode::SERVICE_UNAVAILABLE, "工具委托暂不可用"));
    }
    Ok((uid, assertion))
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<Revision>,
) -> Response {
    let (uid, assertion) = match revision_assertion(&state, &headers).await {
        Ok(actor) => actor,
        Err(response) => return response,
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
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(client) => client,
        Err(_) => return failure(StatusCode::BAD_GATEWAY, "Agent 暂不可用"),
    };
    let response=match client.post(format!("{}/confirmation/image-revision",crate::ai_services::agent_base_url()))
        .header("X-Agent-Assertion",assertion)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rate_limiter::LoginRateLimiter;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};

    #[tokio::test]
    async fn browser_revision_receives_delegation_bound_to_current_session_and_role() {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "CI requires explicit TEST_PG_URL"
            );
            return;
        };
        let db = Database::connect(url).await.unwrap();
        let uid:i32=db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",
            [format!("image_revision_actor_{}",uuid::Uuid::new_v4().simple()).into()]
        )).await.unwrap().unwrap().try_get("","id").unwrap();
        let state = AppState {
            db,
            rate_limiter: LoginRateLimiter::new(1, 60, 60),
            post_limiter: crate::risk::PostRateLimiter::default(),
            report_limiter: LoginRateLimiter::new(1, 60, 60),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {}", auth_jwt::create_token(uid, "admin", 0))
                .parse()
                .unwrap(),
        );
        let (_, assertion) = revision_assertion(&state, &headers)
            .await
            .unwrap_or_else(|_| panic!("valid admin session rejected"));
        let payload: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(assertion.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        let delegated = payload["delegation"]
            .as_str()
            .expect("tool capability missing");
        let grant =
            auth_jwt::delegation::verify(delegated).expect("delegation signature must verify");
        assert_eq!(grant.sub, uid);
        assert_eq!(grant.role, "admin");
        assert_eq!(grant.ver, 0);
        assert_eq!(grant.scope, auth_jwt::delegation::Scope::Tools);
        let mut recursive = HeaderMap::new();
        recursive.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {delegated}").parse().unwrap(),
        );
        assert_eq!(
            revision_assertion(&state, &recursive)
                .await
                .unwrap_err()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        state
            .db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "UPDATE \"user\" SET role='user',token_version=1 WHERE id=$1",
                [uid.into()],
            ))
            .await
            .unwrap();
        assert_eq!(
            revision_assertion(&state, &headers)
                .await
                .unwrap_err()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {}", auth_jwt::create_token(uid, "user", 1))
                .parse()
                .unwrap(),
        );
        assert_eq!(
            revision_assertion(&state, &headers)
                .await
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
        state
            .db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM \"user\" WHERE id=$1",
                [uid.into()],
            ))
            .await
            .unwrap();
    }
}
