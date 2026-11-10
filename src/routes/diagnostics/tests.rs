use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use sea_orm::{DatabaseConnection, MockDatabase};
use serde_json::{json, Value};
use tower::ServiceExt;

fn user(role: &str) -> crate::entity::user::Model {
    crate::entity::user::Model {
        id: 61,
        username: "fixture".into(),
        nickname: "fixture".into(),
        nickname_auto_renamed: 0,
        avatar: None,
        password: "unused".into(),
        role: role.into(),
        status: 0,
        token_version: 0,
        chat_quota_used: 0,
        muted_until: None,
    }
}

fn app(db: DatabaseConnection) -> Router {
    crate::routes::create_router(AppState {
        db,
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: crate::risk::PostRateLimiter::default(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

#[tokio::test]
async fn diagnostics_rejects_anonymous_and_nonadministrators_before_sampling() {
    let empty = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    let response = app(empty)
        .oneshot(
            Request::get("/api/protected/diagnostics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    for role in ["user", "zako", "unknown"] {
        let actor = user(role);
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![actor]])
            .into_connection();
        let token = crate::auth_jwt::create_token(61, role, 0);
        let response = app(db)
            .oneshot(
                Request::get("/api/protected/diagnostics")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn absent_agent_is_explicit_without_contacting_a_default_local_service() {
    assert!(matches!(
        agent_state(None).await,
        ServiceState::NotConfigured
    ));
}

#[tokio::test]
async fn database_failure_remains_unavailable_without_disclosing_its_error() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([sea_orm::DbErr::Custom(
            "postgres://private:secret@internal/db".into(),
        )])
        .into_connection();
    let state = AppState {
        db,
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: crate::risk::PostRateLimiter::default(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    };
    let status = serde_json::to_value(database_state(&state).await).unwrap();
    assert_eq!(status, json!("unavailable"));
}

#[tokio::test]
async fn valid_admin_receives_typed_host_facts_independent_of_agent_installation() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![user("admin")]])
        .append_query_results([vec![std::collections::BTreeMap::from([(
            "ready",
            1.into(),
        )])]])
        .into_connection();
    let token = crate::auth_jwt::create_token(61, "admin", 0);
    let response = app(db)
        .oneshot(
            Request::get("/api/protected/diagnostics")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = to_bytes(response.into_body(), 32768).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let data = &body["data"];
    assert_eq!(data["schemaVersion"], 1);
    assert_eq!(data["scope"], "blog_host");
    assert!(data["host"]["memory"]["totalBytes"].is_u64());
    assert!(data["host"]["disks"].as_array().unwrap().len() <= 16);
    assert!(data["services"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["name"] == "database" && row["state"] == "ready"));
    assert!(!String::from_utf8(bytes.to_vec())
        .unwrap()
        .contains("secret"));
}

#[test]
fn diagnostic_delegation_is_read_only() {
    use crate::auth_jwt::delegation::{allows, Scope};
    assert!(allows(
        Scope::Tools,
        &axum::http::Method::GET,
        "/api/protected/diagnostics"
    ));
    assert!(allows(
        Scope::Background,
        &axum::http::Method::GET,
        "/api/protected/diagnostics"
    ));
    for method in [
        axum::http::Method::POST,
        axum::http::Method::PUT,
        axum::http::Method::DELETE,
    ] {
        assert!(!allows(Scope::Tools, &method, "/api/protected/diagnostics"));
    }
}
