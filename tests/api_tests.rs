use saudade_blog::rate_limiter::LoginRateLimiter;
use saudade_blog::{create_router, AppState};
use sea_orm::{DatabaseBackend, MockDatabase};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt; // for `oneshot`

fn test_state(db: sea_orm::DatabaseConnection) -> AppState {
    AppState {
        db,
        rate_limiter: LoginRateLimiter::new(5, 60, 300),
        // 内容风控的发布间隔刹车（20261002）：路由结构测试不碰这条链路，
        // 给一个空计数器即可（阈值由 risk::load_config 每请求现读）。
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
    }
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

/// 同 `req_api_code`，但**把信封里那句话也带回来**（有些判据只能靠它区分——
/// 例如点赞那族「未登录」与「这篇文章不存在」都是 HTTP 200 + code≠200，
/// 状态码完全一样，只有文案分得出卡在哪一关），并且可以额外带一个请求头。
async fn req_api_envelope(
    app: axum::Router,
    method: &str,
    uri: &str,
    header: Option<(&str, &str)>,
) -> (StatusCode, i64, String) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some((k, v)) = header {
        builder = builder.header(k, v);
    }
    let res = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or(serde_json::Value::Null);
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
    (status, code, msg)
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

// ---- 文章阅读量 / 点赞量（20260930）：两个族故意不同 ----
//
// **读**（stats/view）不需要登录，因此"无 token"这件事在这里根本不是错误分支：
// 访客照样拿得到 `{views,likes,liked:false}`。所以这两条**没有**"未登录"用例可写
// ——它们的形状由 MockDatabase 的零查询预期顶着（handler 在查到文章之前不会成功，
// 这里只断言路由存在且没被守卫误伤）。
//
// **写**（like/unlike）**20261001 起也不再要求登录**（用户第 2 条：点赞改为非登录
// 用户也可以点赞）：身份 = 登录账号，或浏览器自报的 `X-Visitor-Key`（`identify`）。
// 但**仍然不是 401**：它挂 `public_routes` + handler 内自身鉴权，走的是上面 profile
// 那一族的信封错误契约。判据写死在这里，防后人"顺手挪进 protected_routes"——那会把
// 普通用户全部 403 掉（auth_guard 判的是管理员）。
#[tokio::test]
async fn test_点赞取消点赞走信封错误而不是401() {
    for (method, uri) in [("POST", "/api/public/notes/1/like"), ("DELETE", "/api/public/notes/1/like")] {
        let (status, code, _) = req_api_envelope(mock_app(), method, uri, None).await;
        assert_eq!(status, StatusCode::OK, "{} {} 应返回 HTTP 200 信封", method, uri);
        assert_ne!(code, 200, "{} {} 没有身份不该成功", method, uri);
    }
}

/// 匿名点赞（20261001）：这道门是**访客标识**开的，不是把鉴权放宽了。
///
/// 判据靠**信封里的那句话**区分走到了哪一关（两个分支都是 HTTP 200 + code≠200，
/// 只看状态码分不出来）：
///   · 「未登录」      = 身份这一关没过；
///   · 「这篇文章不存在」= 身份过了，卡在"文章可见性"那一关（MockDatabase 没有任何
///     查询预期 ⇒ `visible_note_id` 恒 false）。**这就是"门真的开了"的证据。**
#[tokio::test]
async fn test_匿名点赞靠访客标识开门而不是放宽鉴权() {
    const OK_KEY: (&str, &str) = ("x-visitor-key", "0123456789abcdef");

    // ① 两样都没有 ⇒ 「未登录」
    let (status, code, msg) = req_api_envelope(mock_app(), "POST", "/api/public/notes/1/like", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(code, 200);
    assert_eq!(msg, "未登录", "没身份时应当被拦在身份这一关");

    // ② 合法标识 ⇒ 不再是「未登录」（门开了）
    let (status, _, msg) = req_api_envelope(mock_app(), "POST", "/api/public/notes/1/like", Some(OK_KEY)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(msg, "这篇文章不存在", "有标识就该走到可见性判定，而不是被当成未登录");

    // ③ 标识不合格（太短 / 字符集越界 / 超长）⇒ 一律当"没有标识"
    for bad in ["short", "abc", "has space here", "0123456789abc!@#$%^&*()", &"a".repeat(65)] {
        let (_, _, msg) = req_api_envelope(
            mock_app(), "POST", "/api/public/notes/1/like", Some(("x-visitor-key", bad)),
        ).await;
        assert_eq!(msg, "未登录", "非法标识 {:?} 不该被当成身份", bad);
    }

    // ④ 带着令牌（哪怕是坏的）也**绝不能**变成 401：前端 axios 对任何 401 都清 token
    //    并跳 /login——"浏览器里躺着一枚过期令牌"正是匿名访客最常见的形态，被一脚
    //    踢去登录页就等于这个功能白做。
    //
    // `verify_token` 每次都从环境里读 `JWT_SECRET`、读不到直接 panic（不是返回 None）。
    // 本套件里只有这一条用例会走到验签（其余用例连 Authorization 头都不带），
    // 所以在用例内设一枚测试密钥即可：它不参与任何真实签名，只为让"坏令牌 ⇒
    // 验签失败 ⇒ 退回访客身份"这条路径跑得通。
    std::env::set_var("JWT_SECRET", "test-secret-not-used-for-anything-real");
    let (status, _, msg) = {
        let res = mock_app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/public/notes/1/like")
                    .header("authorization", "Bearer not-a-real-token")
                    .header(OK_KEY.0, OK_KEY.1)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let st = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (
            st,
            v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
            v.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string(),
        )
    };
    assert_eq!(status, StatusCode::OK, "坏令牌 + 好标识不该是 401");
    assert_eq!(msg, "这篇文章不存在", "坏令牌应当**退回访客身份**，而不是当成未登录");
}

/// 后台文章报表挂守卫域 ⇒ 无 token 是 **401**（与 `/api/protected/stats/users` 同族）。
#[tokio::test]
async fn test_文章报表需要管理员() {
    assert_eq!(
        req_status(mock_app(), "GET", "/api/protected/stats/notes").await,
        StatusCode::UNAUTHORIZED
    );
}

/// 周报/月报/年报（`/stats/notes/periods`）也在守卫域内 ⇒ 无 token 同样是 401。
///
/// 这条判据不是"顺手复制上面那条"：它是**路由挂载位置**的回归锁。期报这条路径
/// 与 `.../notes` 只差一个后缀，将来有人把它挪到 `public_routes`（比如想给
/// 前端未登录预览）就会当场变红——而它整表是运营数据，不该有匿名读法。
#[tokio::test]
async fn test_分期报表需要管理员() {
    for kind in ["week", "month", "year"] {
        assert_eq!(
            req_status(
                mock_app(),
                "GET",
                &format!("/api/protected/stats/notes/periods?kind={kind}")
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "kind={kind} 无 token 应返回 401"
        );
    }
}

/// 阅读求和（`SUM(cnt)`）**必须**走 `note_stats::sum_views()`——它是唯一一处
/// `CAST(... AS SIGNED)`。理由是**真解码出来的**教训，不是风格洁癖：
/// MySQL 的 `SUM(<整数列>)` 返回 `DECIMAL`，sea-orm 按 `i64` 解会当场报
/// "not compatible with SQL type DECIMAL"。这条错**编译期发现不了**（本套件的
/// MockDatabase 根本不经过 MySQL 的类型回传），20260930 实测症状是"卡片上三个数
/// 一个都不显示、`GET .../stats` 直接 500"，而日志里只有一行 WARN ⇒ 得有人盯着才看得见。
/// 所以这里锁的是**"别再写第二处裸 `.sum()`"**：全文件只允许出现一次，
/// 且那一次必须在 `sum_views()` 里（`.count()` 不受影响，COUNT 本来就是 BIGINT）。
#[test]
fn test_阅读求和不许绕开_sum_views_那一手_cast() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes/note_stats.rs"),
    )
    .expect("读不到 src/routes/note_stats.rs");

    // 只看**走 SQL 构造器的**那些行：`.sum()` 在 Rust 迭代器上（`map(..).sum()`）
    // 也合法，那是本文件里另外两处，与 MySQL 类型无关。
    let sql_sums: Vec<(usize, &str)> = src
        .lines()
        .enumerate()
        .filter(|(_, l)| l.contains(".sum()") && l.contains("Expr::"))
        .map(|(i, l)| (i + 1, l.trim()))
        .collect();

    assert!(!sql_sums.is_empty(), "没找到任何 SQL 求和——判据空了，改成实际写法再锁");
    for (line, text) in &sql_sums {
        assert!(
            text.contains("cast_as"),
            "note_stats.rs:{} 的求和没带 CAST（{}）——MySQL 的 SUM(<整数列>) 是 DECIMAL，\
             i64 解不出来。把它挪进 sum_views()",
            line,
            text
        );
    }
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

// ---- 站内聚合搜索（20261006）----
//
// 这一节只钉三件事，都是 MockDatabase（**没有任何查询预期**）下能确定的：
//   ① 路由真的挂上了，且体解析在碰库之前（拿非法 JSON 探，见下）；
//   ② 「没给关键词 / 给了但切不出可用 term」这两条路**根本不查库**——所以它们能在
//      零预期的 MockDatabase 上跑通。handler 只要把任何一次查询提到短路之前，这组立刻 panic；
//   ③ 信封的形状（total / counts / 四个数组），前端就是按它渲染的。
//
// ⚠️ **真库上的命中口径（谁该出现、谁不许出现）不在这里**——MockDatabase 只会比对一个
// 字符串、不会真的执行 LIKE，可见性谓词（is_public / approved / is_deleted / 父文章可见）
// 在它面前全是"通过"。那些判据在 `tests/mysql_integration.rs`，两半合起来才算数。

/// 与 `req_api_code` 同源，但把整个信封带回来（聚合搜索的判据要看 `data` 里的数）。
async fn req_api_json(app: axum::Router, body: &str) -> (StatusCode, serde_json::Value) {
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/public/search")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or(serde_json::Value::Null);
    (status, v)
}

/// 路由存在性 + 体解析早于碰库：非法 JSON 必须死在 extractor 层（400），
/// **不是** 404（路由没挂）/ 405（方法不对），也**不是** 500（跑到查询里去了）。
#[tokio::test]
async fn test_聚合搜索路由已挂载且体解析在碰库之前() {
    let (status, _) = req_api_json(mock_app(), "{ 这不是 JSON").await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "非 400 说明要么路由没挂（404）、要么请求已经跑到查询里去了（500）"
    );
}

/// 「没给关键词 / 全空白 / 切不出 term」三条路都回**空信封**，且都不查库。
///
/// 第三条（`第1章`）是本组里最有价值的一条：它锁住"非空关键词切完一无所剩 ⇒ 回空、
/// **不要**落进任何'无关键词就返回全部'的分支"。若哪天有人给聚合搜索加上"空查询返回
/// 最新内容"这类兜底，这条会因为 MockDatabase panic 而红——正是我们要它红的地方。
#[tokio::test]
async fn test_聚合搜索空关键词与不可用关键词都回空且不查库() {
    let cases: [&str; 4] = [
        "{}",                      // 字段缺席
        r#"{"keyword":null}"#,     // 显式 null
        r#"{"keyword":"   "}"#,    // 全空白
        r#"{"keyword":"第1章"}"#,  // 非空，但切完一个可用 term 都不剩
    ];
    for body in cases {
        let (status, v) = req_api_json(mock_app(), body).await;
        assert_eq!(status, StatusCode::OK, "{body} 不该在 HTTP 层失败");
        assert_eq!(v["code"], 200, "{body} 该是成功信封（空结果是结果，不是错误）");
        assert_eq!(v["data"]["total"], 0, "{body} 命中总数必须是 0");
        for k in ["note", "talk", "board", "comment"] {
            assert_eq!(v["data"]["counts"][k], 0, "{body} 的 {k} 计数必须是 0");
        }
        for k in ["notes", "talks", "board", "comments"] {
            assert_eq!(
                v["data"][k].as_array().map(|a| a.len()),
                Some(0),
                "{body} 的 {k} 必须是空数组（不是 null——前端直接 .map 它）"
            );
        }
    }
}
