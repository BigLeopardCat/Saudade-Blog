//! Blog-owned optional vector visualization and current-source lookup.

use crate::{article_graph, routes::AppState};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub struct GraphQueryReq {
    pub q: String,
    pub version: Option<String>,
}

async fn current_source() -> Result<(Value, article_graph::Source), &'static str> {
    let bytes = tokio::fs::read(article_graph::artifact_dir().join("manifest.json"))
        .await
        .map_err(|_| "artifact_missing")?;
    if bytes.len() > 4096 {
        return Err("artifact_invalid");
    }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| "artifact_invalid")?;
    let version = manifest
        .get("v")
        .and_then(Value::as_str)
        .ok_or("artifact_invalid")?;
    if manifest.get("file").and_then(Value::as_str) != Some(format!("graph-{version}.js").as_str())
    {
        return Err("artifact_invalid");
    }
    let source = article_graph::load(version).await?;
    Ok((manifest, source))
}

fn unavailable(reason: &str) -> Json<Value> {
    Json(json!({"ok":false,"reason":reason,"mode":"unavailable","words":[]}))
}

pub async fn graph_query(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<GraphQueryReq>,
) -> Response {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(_) => return (StatusCode::UNAUTHORIZED, unavailable("login_required")).into_response(),
    };
    let actor = crate::entity::user::Entity::find_by_id(uid)
        .one(&state.db)
        .await;
    if !actor.ok().flatten().is_some_and(|user| {
        matches!(
            user.role.as_str(),
            crate::authz::ROLE_USER | crate::authz::ROLE_ADMIN | crate::authz::ROLE_SUPERADMIN
        )
    }) {
        return (StatusCode::FORBIDDEN, unavailable("permission_denied")).into_response();
    }
    static ADMISSION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
    let Ok(_permit) = ADMISSION.try_acquire() else {
        return (StatusCode::SERVICE_UNAVAILABLE, unavailable("busy")).into_response();
    };
    let query = request.q.trim();
    if query.is_empty() || query.chars().count() > 64 {
        return unavailable("invalid_query").into_response();
    }
    let (_, source) = match current_source().await {
        Ok(value) => value,
        Err(reason) => return unavailable(reason).into_response(),
    };
    if request
        .version
        .is_some_and(|version| version != source.version)
    {
        return unavailable("artifact_changed").into_response();
    }
    if !article_graph::visible(&state.db, &source).await {
        return unavailable("visibility_changed").into_response();
    }
    let result = article_graph::query(&source, query).await;
    if !article_graph::visible(&state.db, &source).await {
        return unavailable("visibility_changed").into_response();
    }
    Json(result).into_response()
}

pub async fn graph_manifest(State(state): State<Arc<AppState>>) -> Response {
    let manifest = match current_source().await {
        Ok((manifest, source)) if article_graph::visible(&state.db, &source).await => manifest,
        _ => json!({}),
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(manifest)).into_response()
}

fn valid_artifact_name(file: &str) -> bool {
    file.strip_prefix("graph-")
        .and_then(|value| value.strip_suffix(".js"))
        .is_some_and(article_graph::valid_version)
}

pub async fn graph_artifact(
    State(state): State<Arc<AppState>>,
    Path(file): Path<String>,
) -> Response {
    if !valid_artifact_name(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let version = file.trim_start_matches("graph-").trim_end_matches(".js");
    let source = match article_graph::load(version).await {
        Ok(source) => source,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if !article_graph::visible(&state.db, &source).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(article_graph::artifact_dir().join(file)).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header("X-Content-Type-Options", "nosniff")
            .body(Body::from(bytes))
            .unwrap(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn an_unconfigured_optional_graph_has_a_successful_empty_manifest() {
        use sea_orm::{DatabaseBackend, MockDatabase};
        let state = crate::routes::AppState {
            db: MockDatabase::new(DatabaseBackend::Postgres).into_connection(),
            rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
            post_limiter: crate::risk::PostRateLimiter::new(),
            report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
        };
        let response =
            super::graph_manifest(axum::extract::State(std::sync::Arc::new(state))).await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(bytes.as_ref(), b"{}");
    }

    #[test]
    fn only_content_addressed_public_modules_are_served() {
        for bad in [
            "../../.env",
            "source-12345678.json",
            "graph-12345678.js/../.env",
            "graph-short.js",
            "graph-12345678.js.js",
            "manifest.json",
        ] {
            assert!(!super::valid_artifact_name(bad));
        }
        assert!(super::valid_artifact_name("graph-1234abcd.js"));
    }
}
