//! Authenticate browser/delegated actors before the legacy device verifier.
use crate::{auth_jwt, authz, entity::user, routes::AppState};
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use jsonwebtoken::{encode, EncodingKey, Header};
use sea_orm::EntityTrait;
use serde::Serialize;
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

fn device_api(method: &Method, path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    let identifier = |s: &str| {
        !s.is_empty()
            && s.len() <= 120
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    match parts.as_slice() {
        ["api", "devices"] => method == Method::GET || method == Method::POST,
        ["api", "devices", id] => identifier(id) && method == Method::DELETE && *id != "auth",
        ["api", "devices", id, "config" | "cmd"] => identifier(id) && method == Method::PUT,
        ["api", "devices", id, "config", "rollback"] => identifier(id) && method == Method::PUT,
        ["api", "devices", id, "cmd", request] => {
            identifier(id) && identifier(request) && method == Method::GET
        }
        ["api", "devices", id, "telemetry"] => identifier(id) && method == Method::GET,
        ["api", "ota", "versions"] => method == Method::GET,
        ["api", "ota", "firmware" | "rollback"] => method == Method::PUT,
        _ => false,
    }
}

pub async fn proxy(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers: HeaderMap = request.headers().clone();
    if !device_api(&method, &path) || uri.query().is_some_and(|q| q.len() > 2048) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(claims) = auth_jwt::claims_from_headers(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let uid = claims.sub;
    let actor = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(actor)) => actor,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };
    if authz::check_token(actor.status, actor.token_version, claims.ver).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(body) = to_bytes(request.into_body(), 2 * 1024 * 1024).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    if path.starts_with("api/ota/")
        && method != Method::GET
        && !authz::can_access_console(&actor.role)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(secret) = std::env::var("DEVICE_SIGNING_SECRET")
        .ok()
        .filter(|s| s.len() >= 32)
    else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    #[derive(Serialize)]
    struct DeviceClaims {
        sub: i32,
        role: String,
        exp: usize,
    }
    let claims = DeviceClaims {
        sub: uid,
        role: if authz::can_access_console(&actor.role) {
            "admin".into()
        } else {
            "user".into()
        },
        exp: chrono::Utc::now().timestamp() as usize + 30,
    };
    let Ok(token) = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    ) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap()
    });
    let base =
        std::env::var("DEVICE_SERVICE_URL").unwrap_or_else(|_| "http://127.0.0.1:3100".into());
    let mut url = format!("{}/{path}", base.trim_end_matches('/'));
    if let Some(query) = uri.query() {
        url.push('?');
        url.push_str(query);
    }
    let mut request = client.request(method, url).bearer_auth(token).body(body);
    if let Some(value) = headers.get("content-type") {
        request = request.header("content-type", value);
    }
    if let Some(value) = headers
        .get("x-request-id")
        .filter(|v| v.as_bytes().len() <= 128)
    {
        request = request.header("x-request-id", value);
    }
    let Ok(mut upstream) = request.send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let status = upstream.status();
    let content_type = upstream.headers().get("content-type").cloned();
    let mut bytes = Vec::new();
    loop {
        match upstream.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 2 * 1024 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return StatusCode::BAD_GATEWAY.into_response(),
        }
    }
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    if let Some(value) = content_type {
        response.headers_mut().insert("content-type", value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_excludes_broker_auth_and_unbounded_urls() {
        assert!(device_api(&Method::GET, "api/devices"));
        assert!(device_api(&Method::PUT, "api/devices/dev-1/cmd"));
        for path in [
            "api/devices/auth",
            "http://localhost/",
            "api/devices/../config",
            "api/ota/fw/../../.env",
        ] {
            assert!(!device_api(&Method::POST, path));
            assert!(!device_api(&Method::GET, path));
        }
    }
}
