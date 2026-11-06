//! Request boundaries use synthetic identities and MockDatabase, never paid services.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    routing::post,
    Json, Router,
};
use saudade_blog::{
    auth_jwt,
    entity::user,
    routes::{chat, notes, profile},
    AppState,
};
use sea_orm::{DatabaseBackend, MockDatabase};
use serde_json::json;
use std::sync::Arc;
use tower::ServiceExt;

fn actor(id: i32) -> user::Model {
    user::Model {
        id,
        username: format!("boundary-{id}"),
        nickname: "Fixture".into(),
        nickname_auto_renamed: 0,
        avatar: None,
        password: "unused".into(),
        role: "user".into(),
        status: 0,
        token_version: 0,
        chat_quota_used: 0,
        muted_until: None,
    }
}
fn state(db: sea_orm::DatabaseConnection) -> Arc<AppState> {
    Arc::new(AppState {
        db,
        rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}
fn headers(uid: i32) -> HeaderMap {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| std::env::set_var("JWT_SECRET", "audit-priority-test-signing-key-32-bytes"));
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        format!("Bearer {}", auth_jwt::create_token(uid, "user", 0))
            .parse()
            .unwrap(),
    );
    headers
}

#[tokio::test]
async fn invalid_chat_content_never_creates_conversations_or_consumes_quota() {
    for body in [
        json!({"message":"字".repeat(32769)}),
        json!({"message":"hello", "image":["data:image/png;base64,%%%"]}),
        json!({"message":"hello", "image":["http://127.0.0.1/private"]}),
        json!({"message":"hello", "image":vec!["x"; 7]}),
    ] {
        let state = state(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results([vec![actor(700)]])
                .into_connection(),
        );
        let app = Router::new()
            .route("/chat", post(chat::chat_handler))
            .with_state(state.clone());
        let mut request = Request::builder()
            .method("POST")
            .uri("/chat")
            .header("content-type", "application/json");
        *request.headers_mut().unwrap() = headers(700);
        request = request.header("content-type", "application/json");
        let response = app
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let log = Arc::try_unwrap(state)
            .ok()
            .unwrap()
            .db
            .into_transaction_log();
        assert_eq!(log.len(), 1, "only the authentication read may run");
        assert!(!format!("{log:?}").contains("INSERT"));
        assert!(!format!("{log:?}").contains("UPDATE"));
    }
}

#[tokio::test]
async fn private_message_budget_is_per_sender_and_precedes_recipient_reads() {
    for (uid, attempts) in [(701, 21), (702, 1)] {
        let mut db = MockDatabase::new(DatabaseBackend::Postgres);
        for attempt in 0..attempts {
            db = db.append_query_results([vec![actor(uid)]]);
            if attempt < 20 {
                db = db.append_query_results([Vec::<user::Model>::new()]);
            }
        }
        let state = state(db.into_connection());
        for attempt in 0..attempts {
            let payload = serde_json::from_value(
                json!({"toUsername":format!("recipient-{attempt}"), "content":"hello"}),
            )
            .unwrap();
            let response =
                profile::send_message(State(state.clone()), headers(uid), Json(payload)).await;
            let limited = response.0.message.contains("过于频繁");
            assert_eq!(limited, attempt >= 20);
        }
        let log = Arc::try_unwrap(state)
            .ok()
            .unwrap()
            .db
            .into_transaction_log();
        assert_eq!(log.len(), attempts + attempts.min(20));
    }
}

#[tokio::test]
async fn oversized_search_filters_fail_before_any_database_query() {
    let state = state(MockDatabase::new(DatabaseBackend::Postgres).into_connection());
    let payload = serde_json::from_value(json!({"keyword":"x".repeat(129)})).unwrap();
    let response = notes::search_notes(State(state.clone()), HeaderMap::new(), Json(payload)).await;
    assert_ne!(response.0.code, 200);
    assert!(Arc::try_unwrap(state)
        .ok()
        .unwrap()
        .db
        .into_transaction_log()
        .is_empty());
}

#[tokio::test]
async fn legacy_search_body_limit_applies_before_json_or_database_work() {
    let app = saudade_blog::create_router(AppState {
        db: MockDatabase::new(DatabaseBackend::Postgres).into_connection(),
        rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    });
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/public/notes/search")
                .header("content-type", "application/json")
                .body(Body::from(json!({"keyword":"x".repeat(5000)}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let _ = to_bytes(response.into_body(), 10000).await.unwrap();
}
