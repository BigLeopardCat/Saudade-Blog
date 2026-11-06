//! Independent signing keys and purpose restrictions, without production credentials.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    middleware,
    routing::any,
    Router,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use saudade_blog::auth_jwt::{
    self,
    delegation::{self, Scope},
};
use serde_json::json;
use tower::ServiceExt;

fn history_application(status: i16, version: i32, owned: bool) -> Router {
    use saudade_blog::{create_router, entity::user, AppState};
    use sea_orm::{DatabaseBackend, MockDatabase, Value};
    use std::collections::BTreeMap;
    let actor = user::Model {
        id: 7,
        username: "history-fixture".into(),
        nickname: "History".into(),
        nickname_auto_renamed: 0,
        avatar: None,
        password: "unused".into(),
        role: "user".into(),
        status,
        token_version: version,
        chat_quota_used: 0,
        muted_until: None,
    };
    let owners: Vec<BTreeMap<&str, Value>> = if owned {
        vec![BTreeMap::from([("id", 9.into())])]
    } else {
        vec![]
    };
    let row: BTreeMap<&str, Value> = BTreeMap::from([
        ("id", 31.into()),
        ("role", "user".into()),
        ("content", "owned-history".into()),
        ("content_length", 13.into()),
        ("created_at", chrono::NaiveDateTime::default().into()),
    ]);
    create_router(AppState {
        db: MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![actor]])
            .append_query_results([owners])
            .append_query_results([vec![row]])
            .into_connection(),
        rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

#[tokio::test]
async fn keys_audiences_expiry_and_scope_are_independent() {
    let login = "isolated-session-signing-key-at-least-32";
    let assertion = "isolated-assertion-signing-key-at-least-32";
    let delegated = "isolated-delegation-signing-key-at-least-32";
    std::env::set_var("JWT_SECRET", login);
    std::env::set_var("AGENT_ASSERTION_SECRET", assertion);
    std::env::set_var("BLOG_DELEGATION_SECRET", delegated);
    let now = chrono::Utc::now().timestamp() as usize;
    let session = auth_jwt::create_token(7, "user", 4);
    assert_eq!(auth_jwt::verify_token(&session).unwrap().ver, Some(4));
    assert!(delegation::verify(&session).is_none());
    assert!(auth_jwt::verify_token(&auth_jwt::create_agent_assertion(7, Some("admin"))).is_none());
    let mint = |key: &str, value: serde_json::Value| {
        encode(
            &Header::default(),
            &value,
            &EncodingKey::from_secret(key.as_bytes()),
        )
        .unwrap()
    };
    for key in [login, assertion] {
        let forged = mint(
            key,
            json!({"sub":7,"role":"admin","ver":4,"scope":"tools","aud":"blog-tools","exp":now+300}),
        );
        assert!(delegation::verify(&forged).is_none());
        assert!(auth_jwt::verify_token(&forged).is_none());
    }
    // Old Agent tokens omitted ver; legacy browser sessions carried ver and remain valid until expiry.
    assert!(
        auth_jwt::verify_token(&mint(login, json!({"sub":7,"role":"admin","exp":now+300})))
            .is_none()
    );
    assert!(auth_jwt::verify_token(&mint(
        login,
        json!({"sub":7,"role":"user","ver":4,"exp":now+300})
    ))
    .is_some());
    let expired = delegation::issue(7, "user", 4, Scope::Tools, now - 301).unwrap();
    assert!(auth_jwt::verify_token(&expired).is_none());
    let background = delegation::issue(7, "admin", 4, Scope::Background, now).unwrap();
    let tools = delegation::issue(7, "user", 4, Scope::Tools, now).unwrap();
    assert_eq!(auth_jwt::verify_token(&tools).unwrap().ver, Some(4));
    let app = Router::new()
        .route("/{*path}", any(|| async { StatusCode::OK }))
        .layer(middleware::from_fn(delegation::boundary));
    for token in [&tools, &background] {
        for path in ["/api/chat/history", "/api/chat/history/text"] {
            for method in [Method::GET, Method::POST, Method::DELETE, Method::PATCH] {
                let expected = if token == &tools && method == Method::GET {
                    StatusCode::OK
                } else {
                    StatusCode::FORBIDDEN
                };
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method.clone())
                            .uri(format!("{path}?conversation_id=9"))
                            .header("authorization", format!("Bearer {token}"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), expected, "{method} {path}");
            }
        }
    }
    for (token, method, path, expected) in [
        (
            &background,
            Method::GET,
            "/api/protected/profile",
            StatusCode::OK,
        ),
        (
            &background,
            Method::POST,
            "/api/protected/catalog/search",
            StatusCode::OK,
        ),
        (
            &background,
            Method::DELETE,
            "/api/protect/delImg",
            StatusCode::FORBIDDEN,
        ),
        (
            &background,
            Method::GET,
            "/api/device-gateway/api/devices",
            StatusCode::FORBIDDEN,
        ),
        (
            &tools,
            Method::GET,
            "/api/protected/agent/delegation",
            StatusCode::FORBIDDEN,
        ),
        (
            &tools,
            Method::POST,
            "/api/chat/conversations",
            StatusCode::FORBIDDEN,
        ),
        (
            &tools,
            Method::GET,
            "/api/chat/conversations",
            StatusCode::FORBIDDEN,
        ),
        (
            &tools,
            Method::GET,
            "/api/chat/search",
            StatusCode::FORBIDDEN,
        ),
        (
            &tools,
            Method::GET,
            "/api/chat/stream",
            StatusCode::FORBIDDEN,
        ),
        (&tools, Method::POST, "/api/chat", StatusCode::FORBIDDEN),
        (
            &tools,
            Method::GET,
            "/api/chat/history/text/extra",
            StatusCode::FORBIDDEN,
        ),
        (
            &tools,
            Method::POST,
            "/api/protected/auth/password",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{path}");
    }
    assert!(saudade_blog::authz::check_token(0, 5, Some(4)).is_err());
    assert!(saudade_blog::authz::check_token(-1, 4, Some(4)).is_err());
    for (status, version, owned, allowed) in [
        (0, 4, true, true),
        (0, 4, false, false),
        (1, 4, true, false),
        (0, 5, true, false),
    ] {
        let response = history_application(status, version, owned)
            .oneshot(
                Request::builder()
                    .uri("/api/chat/history/text?conversation_id=9&limit=5")
                    .header("authorization", format!("Bearer {tools}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["code"] == 200, allowed, "{body}");
        if allowed {
            assert_eq!(body["data"]["ownerId"], 7);
            assert_eq!(body["data"]["conversationId"], 9);
            assert_eq!(body["data"]["items"][0]["content"], "owned-history");
        } else {
            assert!(body["data"].is_null());
        }
    }
}
