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

/// 带 JSON body 的请求。**带 `Json<T>` 提取器的路由必须走这个**：axum 的提取器在
/// handler 之前执行，空 body + 无 content-type 会先被拒成 415，handler 里那行鉴权根本
/// 轮不到（20260923 质量闸首次跑就撞上：`PATCH /api/chat/conversations/1` 断言 401 实得 415
/// ——此前 CI 只 `cargo build`，这个目标从没被编译运行过）。
async fn req_status_json(app: axum::Router, method: &str, uri: &str, body: &str) -> StatusCode {
    app.oneshot(
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
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
    // PATCH /api/chat/conversations/:id 重命名/置顶（体是 `Json<UpdateConversationReq>`：
    // `{}` 合法且可反序列化——只是缺 token，所以判据仍是"鉴权发生在碰 DB 之前"）
    assert_eq!(req_status_json(app, "PATCH", "/api/chat/conversations/1", "{}").await, StatusCode::UNAUTHORIZED);
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
        // 对话额度（20260929）用户侧两条：查的/写的都是本人那一行（没有 uid 参数可传），
        // 所以它们同样是"public_routes + handler 自身鉴权"，**不是** 401
        ("GET", "/api/protected/quota", ""),
        ("POST", "/api/protected/quota/apply", r#"{"reason":"想接着问"}"#),
    ];
    for (method, uri, body) in cases {
        let (status, code) = req_api_code(mock_app(), method, uri, body).await;
        assert_eq!(status, StatusCode::OK, "{} {} 应返回 HTTP 200 信封", method, uri);
        assert_ne!(code, 200, "{} {} 未登录不该成功", method, uri);
    }
}

// ---- 对话额度（20260929）管理员三条 ----
// 这一族与上面**故意不同**：它们挂在守卫域内（`protected_routes` 的
// `route_layer(auth_guard)`），无 token 时是 **401**，且鉴权发生在任何查询之前
// （MockDatabase 零查询预期 ⇒ handler 只要先查库再鉴权，这个测试就会 panic 失败）。
//
// 三条判据的分工写在这里，免得后人以为"测过了"：
//   · **鉴权在哪一层** = 本文件；
//   · **算术、角色表、C1 形状** = `src/quota.rs` 的 `#[cfg(test)] mod tests`（纯函数）；
//   · **那条条件 UPDATE 真的会拦人**（并发下最后一格不超发）= 只有真机探针验得了，
//     mock 的 `rows_affected` 是喂进去的。
#[tokio::test]
async fn test_quota_admin_routes_require_console() {
    let app = mock_app();
    assert_eq!(
        req_status(app.clone(), "GET", "/api/protected/quota/requests").await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req_status_json(
            app.clone(),
            "POST",
            "/api/protected/quota/requests/1/review",
            r#"{"approved":true}"#,
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req_status_json(app, "POST", "/api/temp-users/1/quota-reset", "{}").await,
        StatusCode::UNAUTHORIZED
    );
}

/// 扣一轮的判据**就是 `rows_affected`**——三态各一条，外加两条 SQL 断言。
///
/// 那两条 SQL 断言不是"源码文本锁"的软判据，是**语义前提**：`rows_affected` 之所以
/// 能当结论用，全靠语句自己带 `WHERE chat_quota_used < ?`（少了它，超限那一轮也匹配
/// 到行、`rows_affected` 恒为 1 ⇒ "0 = 用完了"这句判据当场失效，额度变成无限），
/// 且靠 `SET = 列 + 1` 是**原地递增**（改成写一个算好的值，两轮并发就互相抹掉）。
/// 这两点离线只有这里验得了，改法若变了，红在这里而不是红在"额度怎么多扣了"。
#[tokio::test]
async fn test_额度扣减的判据是_rows_affected_而不是猜的() {
    use saudade_blog::quota::{self, ConsumeOutcome};
    use sea_orm::MockExecResult;

    let cases: [(u64, ConsumeOutcome); 2] =
        [(1, ConsumeOutcome::Consumed), (0, ConsumeOutcome::Exhausted)];
    for (rows, want) in cases {
        let db = MockDatabase::new(DatabaseBackend::MySql)
            .append_exec_results([MockExecResult { last_insert_id: 0, rows_affected: rows }])
            .into_connection();
        assert_eq!(quota::try_consume(&db, 126, 500).await, want, "rows_affected={rows}");
    }

    // DB 故障 ⇒ fail-open（放行、不计数），**不是**当成"用完了"——
    // 后者会让数据库抖一下就把全站普通用户挡在门外
    let boom = MockDatabase::new(DatabaseBackend::MySql)
        .append_exec_errors([sea_orm::DbErr::Custom("模拟 DB 故障".into())])
        .into_connection();
    assert_eq!(quota::try_consume(&boom, 126, 500).await, ConsumeOutcome::Degraded);

    // 语句本身：原地 +1，且带"还没到上限"这道条件
    let db = MockDatabase::new(DatabaseBackend::MySql)
        .append_exec_results([MockExecResult { last_insert_id: 0, rows_affected: 1 }])
        .into_connection();
    let _ = quota::try_consume(&db, 126, 500).await;
    // 整条语句连同绑定值一起断言（`+ 1` 是以绑定参数下发的，不是字面量）
    let log = format!("{:?}", db.into_transaction_log()).replace('`', "");
    assert!(
        log.contains("chat_quota_used = chat_quota_used + ?"),
        "扣一轮必须是原地递增（写一个算好的值会在并发下互相抹掉）：{log}"
    );
    assert!(
        log.contains("chat_quota_used < ?"),
        "少了这道条件，rows_affected 恒为 1、额度变成无限：{log}"
    );
    assert!(log.contains("id = ?"), "必须按 uid 定位到那一行：{log}");
    // 绑定值顺序 = 递增 1 / 定位 uid / 上限。三个都对上，上面三条断言才真的在说这件事
    assert!(
        log.contains("Values([Int(Some(1)), Int(Some(126)), Int(Some(500))])"),
        "绑定值必须是「+1、uid=126、上限=500」这个顺序：{log}"
    );
}
