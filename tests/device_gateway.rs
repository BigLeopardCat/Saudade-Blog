//! Device requests must cross host revocation checks before reaching the legacy service.
use axum::{
    body::{to_bytes, Body},
    extract::Json,
    http::{HeaderMap, Request, StatusCode},
    routing::get,
    Router,
};
use saudade_blog::{auth_jwt, create_router, entity::user, AppState};
use sea_orm::{DatabaseBackend, MockDatabase};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tower::ServiceExt;

fn application(status: i16, version: i32, role: &str) -> Router {
    let actor = user::Model {
        id: 7,
        username: "fixture".into(),
        nickname: "Fixture".into(),
        nickname_auto_renamed: 0,
        avatar: None,
        password: "unused".into(),
        role: role.into(),
        status,
        token_version: version,
        chat_quota_used: 0,
        muted_until: None,
    };
    create_router(AppState {
        db: MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![actor]])
            .into_connection(),
        rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

#[tokio::test]
async fn gateway_uses_current_actor_and_device_key_after_revocation_check() {
    std::env::set_var(
        "JWT_SECRET",
        "gateway-session-fixture-key-at-least-32-bytes",
    );
    std::env::set_var(
        "BLOG_DELEGATION_SECRET",
        "gateway-delegation-fixture-key-at-least-32-bytes",
    );
    let key = "gateway-device-fixture-key-at-least-32-bytes";
    std::env::set_var("DEVICE_SIGNING_SECRET", key);
    let calls = Arc::new(AtomicUsize::new(0));
    let received = calls.clone();
    let device = Router::new().route(
        "/api/devices",
        get(move |headers: HeaderMap| {
            let calls = received.clone();
            async move {
                let claims = jsonwebtoken::decode::<Value>(
                    headers["authorization"]
                        .to_str()
                        .unwrap()
                        .strip_prefix("Bearer ")
                        .unwrap(),
                    &jsonwebtoken::DecodingKey::from_secret(key.as_bytes()),
                    &jsonwebtoken::Validation::default(),
                )
                .unwrap()
                .claims;
                assert_eq!(claims["sub"], 7);
                assert_eq!(claims["role"], "user");
                assert!(claims.get("aud").is_none());
                assert_eq!(headers["x-request-id"], "gateway-fixture-request");
                calls.fetch_add(1, Ordering::SeqCst);
                Json(json!([]))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::env::set_var(
        "DEVICE_SERVICE_URL",
        format!("http://{}", listener.local_addr().unwrap()),
    );
    let server = tokio::spawn(async move { axum::serve(listener, device).await.unwrap() });
    let session = auth_jwt::create_token(7, "superadmin", 4);
    let grant = auth_jwt::delegation::issue(
        7,
        "superadmin",
        4,
        auth_jwt::delegation::Scope::Tools,
        chrono::Utc::now().timestamp() as usize,
    )
    .unwrap();
    for (token, status, version, expected) in [
        (&session, 0, 4, StatusCode::OK),
        (&grant, 0, 4, StatusCode::OK),
        (&grant, 1, 4, StatusCode::UNAUTHORIZED),
        (&grant, 0, 5, StatusCode::UNAUTHORIZED),
    ] {
        let response = application(status, version, "user")
            .oneshot(
                Request::builder()
                    .uri("/api/device-gateway/api/devices")
                    .header("authorization", format!("Bearer {token}"))
                    .header("x-request-id", "gateway-fixture-request")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        if expected == StatusCode::OK {
            assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), "[]");
        }
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.abort();
}
