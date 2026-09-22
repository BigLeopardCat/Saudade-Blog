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

// ---- 个人中心一期（20260922）自助接口的未登录行为 ----
// 这一族与上面 chat 系**故意不同**：它们挂 `public_routes`（面向任意登录用户，不能进
// admin 守卫域）+ handler 内自身鉴权，无 token 时返回的是**信封错误**
// （HTTP 200 + code=500「未登录」），与同族的 `GET /api/protected/profile`、
// `/api/protect/board/mine` 完全一致——**不是 401**。契约写死在这里，防后人"顺手改成 401"
// 而把前端（按 code 判）打穿。
// 断言本身仍在验证"鉴权发生在碰 DB 之前"：MockDatabase 没有任何查询预期，
// handler 只要先查库再鉴权，这个测试就会以 panic 失败。
async fn req_api_code(app: axum::Router, method: &str, uri: &str, body: &str) -> (StatusCode, i64) {
    let res = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let code = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("code").and_then(|c| c.as_i64()))
        .unwrap_or(-1);
    (status, code)
}

#[tokio::test]
async fn test_profile_center_requires_login() {
    // 请求体一律填**合法形状**：字段不合法会在 extractor 层先返回 422，
    // 那样测到的就不是鉴权分支了。
    let cases: Vec<(&str, &str, &str)> = vec![
        ("PUT", "/api/protected/profile", r#"{"nickname":"n"}"#),
        (
            "PUT",
            "/api/protected/profile/password",
            r#"{"oldPassword":"a","newPassword":"bbbbbbbb"}"#,
        ),
        ("GET", "/api/protected/favorites", ""),
        ("POST", "/api/protected/favorites", r#"{"noteId":1}"#),
        ("DELETE", "/api/protected/favorites/1", ""),
        ("GET", "/api/protected/notifications", ""),
        ("GET", "/api/protected/notifications/summary", ""),
        ("POST", "/api/protected/notifications/read", r#"{"ids":[1]}"#),
        ("GET", "/api/protected/messages", ""),
        (
            "POST",
            "/api/protected/messages",
            r#"{"toUsername":"x","content":"y"}"#,
        ),
        ("POST", "/api/protected/messages/read", r#"{"ids":[1]}"#),
        ("GET", "/api/protected/my/talks", ""),
    ];
    for (method, uri, body) in cases {
        let (status, code) = req_api_code(mock_app(), method, uri, body).await;
        assert_eq!(status, StatusCode::OK, "{} {} 应返回 HTTP 200 信封", method, uri);
        assert_ne!(code, 200, "{} {} 未登录不该成功", method, uri);
    }
}
