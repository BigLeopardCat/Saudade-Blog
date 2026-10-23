//! Exercise authentication through the complete production router.
use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use sea_orm::{DatabaseBackend, MockDatabase};
use tower::ServiceExt;

#[tokio::test]
async fn category_actions_require_authentication_before_reading_or_writing() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    let app = create_router(AppState {
        db,
        rate_limiter: LoginRateLimiter::new(5, 60, 300),
        post_limiter: crate::risk::PostRateLimiter::new(),
        report_limiter: LoginRateLimiter::new(120, 60, 300),
    });
    for path in [
        "/api/protected/category-actions/prepare",
        "/api/protected/category-actions",
        "/api/protected/tag-actions/prepare",
        "/api/protected/tag-actions",
        "/api/protected/announcement-actions/prepare",
        "/api/protected/announcement-actions",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"action":"create","fields":{"name":"must not write"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
    }
}
