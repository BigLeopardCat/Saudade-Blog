//! Independent signing keys and purpose restrictions, without production credentials.
use axum::{
    body::Body,
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
}
