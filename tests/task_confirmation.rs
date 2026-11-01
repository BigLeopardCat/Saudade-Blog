//! Host ownership and HTTP projection contract; no PostgreSQL or production Agent needed.
use axum::{
    body::Body,
    extract::Json,
    http::{HeaderMap, Request, StatusCode},
    routing::post,
    Router,
};
use saudade_blog::{
    auth_jwt, create_router,
    entity::{conversation, user},
    AppState,
};
use sea_orm::{DatabaseBackend, MockDatabase};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn app(owned: bool) -> Router {
    let actor = user::Model {
        id: 7,
        username: "fixture".into(),
        nickname: "Fixture".into(),
        nickname_auto_renamed: 0,
        avatar: None,
        password: "unused".into(),
        role: "user".into(),
        status: 0,
        token_version: 0,
        chat_quota_used: 0,
        muted_until: None,
    };
    let now = chrono::Utc::now().naive_utc();
    let conversations = if owned {
        vec![conversation::Model {
            id: 42,
            user_id: 7,
            title: None,
            created_at: now,
            updated_at: now,
            pinned: false,
        }]
    } else {
        vec![]
    };
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![actor.clone()]])
        .append_query_results([conversations])
        .append_query_results([vec![actor]])
        .into_connection();
    create_router(AppState {
        db,
        rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

async fn request(router: Router, body: Value, authenticated: bool) -> axum::response::Response {
    let mut req = Request::builder()
        .method("POST")
        .uri("/api/chat/task/confirmation")
        .header("content-type", "application/json");
    if authenticated {
        req = req.header(
            "authorization",
            format!("Bearer {}", auth_jwt::create_token(7, "admin", 0)),
        );
    }
    router
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn confirmation_status_authenticates_ownership_and_proxies_without_executing() {
    // This integration target has one test: its private endpoint cannot race other targets' env.
    std::env::set_var("JWT_SECRET", "task-confirmation-isolated-fixture-secret");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let received = calls.clone();
    let agent = Router::new().route("/tasks/confirmation", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let received = received.clone();
        async move {
            let mut validation = jsonwebtoken::Validation::default(); validation.set_audience(&["agent"]);
            let claims = jsonwebtoken::decode::<Value>(headers["x-agent-assertion"].to_str().unwrap(),
                &jsonwebtoken::DecodingKey::from_secret(b"task-confirmation-isolated-fixture-secret"), &validation).unwrap().claims;
            assert_eq!(claims["sub"], 7); assert_eq!(claims["role"], "user");
            received.lock().unwrap().push(body);
            Json(json!({"task_id":"task", "confirmation":{"id":"operation", "task_id":"task", "token":"fixture-grant"}}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::env::set_var(
        "AGENT_URL",
        format!("http://{}/chat", listener.local_addr().unwrap()),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, agent).await.unwrap();
    });
    let body = json!({"conversation_id":42,"user_id":999});
    assert_eq!(
        request(app(true), body.clone(), false).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(app(false), body.clone(), true).await.status(),
        StatusCode::NOT_FOUND
    );
    assert!(calls.lock().unwrap().is_empty());
    let response = request(app(true), body.clone(), true).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let result: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 16384)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["confirmation"]["id"], "operation");
    assert_eq!(
        calls.lock().unwrap()[0],
        json!({"user_id":7,"conversation_id":42})
    );
    assert_eq!(
        request(
            app(true),
            json!({"conversation_id":42,"task_id":"wrong"}),
            true
        )
        .await
        .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(
        request(
            app(true),
            json!({"conversation_id":42,"task_id":"../wrong"}),
            true
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(calls.lock().unwrap().len(), 2);
    server.abort();
}
