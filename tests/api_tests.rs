use saudade_blog::rate_limiter::LoginRateLimiter;
use saudade_blog::{create_router, AppState};
use sea_orm::{DatabaseBackend, MockDatabase};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt; // for `oneshot`

fn test_state(db: sea_orm::DatabaseConnection) -> AppState {
    AppState { db, rate_limiter: LoginRateLimiter::new(5, 60, 300) }
}

#[tokio::test]
async fn test_404_not_found() {
    let db = MockDatabase::new(DatabaseBackend::MySql).into_connection();
    let app = create_router(test_state(db));

    let response = app
        .oneshot(Request::builder().uri("/api/wrong_path").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_public_notes_route_structure() {
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .into_connection();

    let app = create_router(test_state(db));

    let response = app
        .oneshot(Request::builder().uri("/api/public/notes").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_ne!(response.status(), StatusCode::NOT_FOUND);
}

// ---- 会话管理端点（20260903 会话化）401 用例 ----
// 全部 handler 内 auth_jwt::auth_uid 在碰 DB 之前返回 401，
// MockDatabase（无预期）下不触发任何查询，纯鉴权路径断言。

fn mock_app() -> axum::Router {
    let db = MockDatabase::new(DatabaseBackend::MySql).into_connection();
    create_router(test_state(db))
}

async fn req_status(app: axum::Router, method: &str, uri: &str) -> StatusCode {
    app.oneshot(
        Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap()
    .status()
}

#[tokio::test]
async fn test_conversations_require_auth() {
    let app = mock_app();
    // GET /api/chat/conversations 列表
    assert_eq!(req_status(app.clone(), "GET", "/api/chat/conversations").await, StatusCode::UNAUTHORIZED);
    // POST /api/chat/conversations 新建
    assert_eq!(req_status(app.clone(), "POST", "/api/chat/conversations").await, StatusCode::UNAUTHORIZED);
    // DELETE /api/chat/conversations/:id 删除
    assert_eq!(req_status(app.clone(), "DELETE", "/api/chat/conversations/1").await, StatusCode::UNAUTHORIZED);
    // PATCH /api/chat/conversations/:id 重命名/置顶
    assert_eq!(req_status(app, "PATCH", "/api/chat/conversations/1").await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_tag_move_requires_auth() {
    // 换层级/换父级（20260921）：挂 protected_routes ⇒ auth_guard 全 admin，
    // handler 内 auth_uid 在碰 DB 之前就返回 401（MockDatabase 零查询预期）。
    let app = mock_app();
    assert_eq!(
        req_status(app, "POST", "/api/protected/tag/move").await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn test_chat_history_requires_auth() {
    let app = mock_app();
    assert_eq!(req_status(app, "GET", "/api/chat/history").await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_chat_discard_requires_auth() {
    let app = mock_app();
    assert_eq!(req_status(app, "POST", "/api/chat/discard").await, StatusCode::UNAUTHORIZED);
}
