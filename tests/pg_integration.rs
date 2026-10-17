//! 真 PG 集成测（20261003；20261018 从 MySQL 迁到 PostgreSQL）：把 `counts_for` 的四条
//! 聚合语句放到**真库**上跑一遍。
//!
//! ## 为什么非要有这一层
//!
//! 仓里原有的 `tests/api_tests.rs` 走 `MockDatabase`——它**不连接数据库、也不解码返回行**
//! （mock 返回的是我们喂进去的值，模拟不了服务端真实的类型）。于是一整类事故对它完全
//! 隐形：真库返回的 SQL 类型与 sea-orm 期望的 Rust 类型对不上时，**只有真连接 + 真解码**
//! 才会现形——`cargo check` 与 mock 都全绿。
//!
//! 历史锚点（切库前）：20260930 线上那次 500，根因是 **MySQL 的 `SUM(<整数列>)` 返回
//! `DECIMAL` 而不是 `BIGINT`**，sea-orm 按 `Option<i64>` 解码当场报
//!
//! ```text
//! mismatched types; Rust type Option<i64> (as SQL type BIGINT)
//! is not compatible with SQL type DECIMAL
//! ```
//!
//! ——文章列表卡片三个数一个都不显示、`GET /stats` 直接 500；当时修法是所有求和都过
//! [`sum_views`](saudade_blog::routes::note_stats) 那一手的 `CAST(... AS SIGNED)`。
//!
//! **切到 PG 之后这条判据的理由变了**：PG 的 `SUM(<整数列>)` 本来就返回 `bigint`，
//! 所以"求和拿得回一个整数"在 PG 上不再是"防 DECIMAL 陷阱"，而是**把"真连接上 `SUM`
//! 读回来的确实是 i64、且值就是那几个数"钉死**——它是这一层里唯一在真库上跑 `SUM`
//! 并核对返回值（而非只核对其类型）的用例。`sum_views` 那手 `CAST(... AS BIGINT)` 在
//! PG 上**冗余但无害**，留着是为了"所有 `SUM(cnt)` 都从一处出去"不出现一个只在旧库上
//! 才需要的例外分支（见 `note_stats.rs::sum_views` 头注）。谁把真库读回来的数弄歪了，
//! 本文件第一个用例立刻红。
//!
//! 顺带钉住的还有三件 MockDatabase 永远证明不了的事：
//!   · `COUNT(*)`/`SUM` 在**零行**时是 NULL（`null → 0` 的折零逻辑真的走过一遍）；
//!   · 空 id 列表必须**短路**——`IN ()` 是语法错误（PG 与 MySQL 同），不短路就是一条真报错；
//!   · 讨论数的两条过滤（`approved = 1 AND is_deleted = 0`）在真 SQL 下的取舍，
//!     以及 `note_view`/`note_like`/`user_favorite` 上那几条**外键**真的能插得进去。
//!
//! ## 第二半（20261004）：额度 / 会话 / 申请认领
//!
//! 同一个理由往下推——那三块的核心判据**全部是 DB 语义**，MockDatabase 一行都证明不了：
//!
//! · ⑥ **`quota::try_consume` 的边界**：它靠 `rows_affected == 1` 认"抢到了这一轮"，
//!   靠 `WHERE chat_quota_used < limit` 挡超限。这两件事都是**真 UPDATE 的语义**，
//!   mock 里喂一个 `rows_affected` 进去只是把答案抄了一遍。这里真跑：**最后一格
//!   恰好扣一次、被挡住的那一轮一个数都不许动**——"最后一格被扣两次"的直接判据。
//! · ⑦⑧ **会话搜索与列表**：`LIKE` 的 `%`/`_` 转义（不转义就是用户输入注入面）、
//!   `pinned` 优先 + `updated_at` 倒序的**三键排序**、以及命中锚"每会话取最新命中消息"。
//!   这三条都要求库真的按行返回，且都要真 JWT 走完 `create_router` 的中间件。
//! · ⑨ **额度申请的原子认领**：`UPDATE ... WHERE id = $1 AND status = 0` 认领到才清零、
//!   才发通知。重复点通过时第二次必须**一行都不改**——判据是"清零没再发生"（把
//!   计数器在两刀之间推到 5，第二刀若生效就会把它抹成 0）与"通知没多出第二条"。
//!
//! ## 第三半（20261006）：站内聚合搜索
//!
//! ⑩ 站内聚合搜索一次把**四张表**倒给访客（文章 / 说说 / 留言 / 评论），所以它的核心判据
//!   全是**可见性谓词**——`is_public` / `status <> 'draft'` / `approved` / `is_deleted`，
//!   外加"评论的父文章必须可见"。这些在 `MockDatabase` 面前**一律显示为通过**（mock 既不
//!   执行 SQL 也不解码返回行），所以唯一的真判据就是：播一条**不该出现**的行进去，
//!   再断言它**没有**出现。断言一律写成**精确 id 集合**而非"包含"——漏掉任何一条谓词，
//!   结果都是**多出几行**，而"包含"型断言对多出来的行照样绿。
//!   另外两件只有真库能证明：留言那一行的 `title` 列存的是**印章不是标题**（只许搜 content），
//!   以及 `like_escape` 的反斜杠那一面——不转义时 `\p` 会被 LIKE 读成 `p`，**丢的是命中**
//!   （与 `%` 变通配符只会多捞的方向相反），只有夹具里真放一条含字面量 `c:\path` 的行才抓得住。
//!
//! ## 第四半（20261014）：后台留言列表的服务端筛选与分页
//!
//! ⑪ `GET /api/protect/board` 在这一批之前是"整表拉回前端、前端再筛再切页"，现在
//!   筛选/搜索/排序/分页都在服务端做。这里的判据几乎全是 **JOIN 语义**，对 `MockDatabase`
//!   完全隐形：
//!   · 关键词要能命中**用户名/昵称**（在 user 表上）⇒ 查询带 `LEFT JOIN user`。LEFT 还是
//!     INNER，唯一的分界线是**发布者已经不在了**的那些留言（`user_id` 指向一个查不到的
//!     用户）：INNER 会把它们从管理员眼前静默摘掉，而它们恰恰是最该被看见的行；
//!   · 列表与计数**共用同一条未执行的查询**（`board_admin_filter`）⇒「共 N 条」必须等于
//!     实际翻得出来的条数，且**同秒多行**要靠 id 参与排序才不重不漏；
//!   · `like_escape` 在 `%` 那一面：不转义时搜 `qqzz%boardkw` 会把 `qqzzboardkw` 一起捞
//!     回来（**多取行**——与 ⑩ 反斜杠那面"丢命中"的方向相反，所以那一面抓不住这一面）。
//!
//!   夹具的所有行 `created_at` **取同一个字面量**：分页要验的正是"同秒多行"这个最难的情形，
//!   用 `NOW()` 播种会让每行的秒数各不相同 ⇒ 分页断言恰好退化成最容易通过的那种。
//!
//! ⑦⑧ 起要签真令牌、走真路由：`create_router` + 真 JWT（`create_token` 自会读
//! `JWT_SECRET`，本文件自己把它设上）。夹具一律用 `9000000xx` 高位 id，且**按用户隔离**
//! ——⑦⑧ 只在 `CONV_UID` 名下建会话、⑨ 只在 `APPLY_UID` 名下建申请，
//! 所以"另一个用例留下的行"不会污染断言（⑥ 连用户都是自己的）。
//!
//! ## 门控（务必看清，别把它改宽）
//!
//! · `TEST_PG_URL` **没设** ⇒ 打印一行"跳过"然后返回（本地 `cargo test`、
//!   贡献者的机器上都不受影响——他们大多没有现成的库）。
//! · 设了但连不上 ⇒ **响亮失败**，绝不静默跳过。跳过的那些"绿"是这道闸唯一的敌人：
//!   CI 里库没起来（服务容器没健康、口令写错）时如果也是绿的，那它就成了一道装饰。
//! · 库必须有**结构**：由 `scripts/migration/pg/0000_schema.sql` 建出来的那种（它是
//!   **库级**脚本）。缺表时第一件事是带着提示失败，而不是抛一句
//!   `relation "x" does not exist` 让人猜。
//!
//! 用法（本机，**不要指向生产库**）：
//!
//! ```bash
//! # 结构由一个**库级**脚本建（scripts/migration/pg/0000_schema.sql）。⚠️ 它头注里
//! # 写死了库名 `saudade_blog`（脚本内有一句 `ALTER DATABASE "saudade_blog" …`）——
//! # 建一个另名的测库时，要么把那一句改成新库名，要么就按它头注那样把库也建成
//! # `saudade_blog`（那种情况务必用**独立实例**，别撞上生产库）。
//! psql -c "CREATE DATABASE saudade_it ENCODING 'UTF8'"
//! psql -d saudade_it -v ON_ERROR_STOP=1 -f scripts/migration/pg/0000_schema.sql
//! TEST_PG_URL="postgres://saudade_app:密码@127.0.0.1:5432/saudade_it" cargo test --test pg_integration
//! ```
//!
//! ## 夹具数据用高位 id
//!
//! 每个用例各占自己的一小段 `9000000xx` id，互不干扰（`cargo test` 默认多线程并发跑）。
//! 用高位是为了**在一份不干净的开发库上也能跑**：这些 id 不会撞上任何真实内容。
//! 每个用例开头先清一遍自己的残留（上次跑挂了留下的），结尾不强制清理——残留也只影响
//! 它自己那几行，且下次开头会清掉。
//!
//! ⚠️ ⑩ 的**关键词**也必须是"真实内容里不可能出现的怪串"（`qqzz聚合夹具`）。它跨四张表
//! 断言**精确 id 集合**，关键词一旦撞上库里任何一条真实内容，红的理由会看着像"搜索坏了"。
//! 这条要求只对本用例成立：别的用例关键字面 id，不关键字面命中。

use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use saudade_blog::auth_jwt;
use saudade_blog::quota::{self, ConsumeOutcome};
use saudade_blog::routes::note_stats::counts_for;
use saudade_blog::routes::quota::{NO_REASON_FALLBACK, NOTICE_APPROVED_TITLE};
use saudade_blog::{create_router, AppState};
use tower::ServiceExt; // for `oneshot`

/// 前五个用例各占一个 note id（见文件头注）
const NOTE_SUM: i32 = 900000001;
const NOTE_EMPTY: i32 = 900000002;
const NOTE_COMMENTS: i32 = 900000003;
const NOTE_LIKES: i32 = 900000004;

/// 后五个用例各占一个**用户** id。**每个用例一个**：`cargo test` 默认多线程并发，
/// 两个用例共用 uid 时，其中一个的 `make_user`（先 DELETE 再 INSERT）会把另一个
/// 正在用的那一行抽走——症状是随机红，且只在并发时出现。
const QUOTA_UID: i32 = 900000011;
const QUOTA_UID2: i32 = 900000016;
const CONV_SEARCH_UID: i32 = 900000012;
const CONV_LIST_UID: i32 = 900000013;
const ADMIN_UID: i32 = 900000014;
const APPLY_UID: i32 = 900000015;

/// 打开被测库。`None` = 没设 `TEST_PG_URL`（调用方直接返回，即"跳过"）。
///
/// 这里**不做 `unwrap_or_else` 之类的兜底**：环境变量在场时任何一步不成功都必须 panic
/// （见文件头注的门控那一段）。
async fn connect() -> Option<DatabaseConnection> {
    let url = match std::env::var("TEST_PG_URL") {
        Ok(u) if !u.trim().is_empty() => u,
        _ => {
            eprintln!(
                "⏭  跳过：TEST_PG_URL 没设（真库集成测，本地默认不跑；\
                 见 tests/pg_integration.rs 头注）"
            );
            return None;
        }
    };
    assert!(
        url.starts_with("postgres://"),
        "TEST_PG_URL 必须以 postgres:// 开头（现在拿到的是 `{}…`）。\
         这里只打印前缀，因为串里有口令。",
        &url[..url.len().min(12)]
    );

    // `ConnectOptions::new` 对畸形 URL 会直接 panic（它内部 `Url::parse(...).unwrap()`），
    // 上面那条前缀断言把最常见的一种畸形挡在了它前面。
    let mut opt = ConnectOptions::new(url);
    // 连不上时别等 30 秒——5 秒足够，且会让失败信息出现在 CI 日志里显眼的位置。
    opt.connect_timeout(Duration::from_secs(5)).max_connections(4);
    let db = Database::connect(opt).await.unwrap_or_else(|e| {
        panic!(
            "TEST_PG_URL 在场但连不上库：{e}\n\
             这条**不是跳过、是失败**——设了这个变量就意味着这道闸必须真跑起来。"
        )
    });

    ensure_schema(&db).await;
    Some(db)
}

/// 库里的结构得像 `scripts/migration/pg/0000_schema.sql` 建出来的那套。
/// 缺表就带着"怎么补"的提示失败，别让它退化成一个看不出前因后果的 SQL 报错。
async fn ensure_schema(db: &DatabaseConnection) {
    // ⑥–⑨ 起还要 `user`（签真令牌要有行才行）+ 会话两张 + 申请与通知两张
    let want = [
        "note",
        "note_view",
        "note_like",
        "user_favorite",
        "note_comment",
        "user",
        "conversation",
        "chat_history",
        "quota_request",
        "user_notification",
    ];
    let list = want.map(|t| format!("'{t}'")).join(",");
    // `current_schema()` 是 MySQL `DATABASE()` 的**忠实对物**：两者都读作"这条连接当前把
    // 不带限定的表名解析到哪个命名空间"。写死 `'public'` 只在 search_path 恰好是默认值时
    // 等价——换个 schema 就会静默查空、误报"库结构不全"。
    let row = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            format!(
                "SELECT COUNT(*) FROM information_schema.tables \
                 WHERE table_schema = current_schema() AND table_name IN ({list})"
            ),
        ))
        .await
        .expect("查 information_schema 失败")
        .expect("information_schema 一行都没有（库名写了？）");
    let got: i64 = row.try_get_by_index(0).expect("COUNT(*) 不是整数");
    assert_eq!(
        got,
        want.len() as i64,
        "库结构不全（要 {} 张表，只找到 {got} 张）。先建结构：\n\
         psql -d <库名> -v ON_ERROR_STOP=1 -f scripts/migration/pg/0000_schema.sql",
        want.len()
    );
}

/// 跑一条写语句（原生 SQL——这里要验的正是**真 SQL 的语义**，不走 entity 更贴近现场）。
async fn exec(db: &DatabaseConnection, sql: &str) {
    db.execute(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap_or_else(|e| panic!("SQL 失败：{e}\n  {sql}"));
}

/// 建一篇最小文章（`note` 的必填列只有 title/content/created_at/updated_at）。
async fn make_note(db: &DatabaseConnection, id: i32) {
    exec(db, &format!("DELETE FROM note WHERE id = {id}")).await;
    exec(
        db,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at) \
             VALUES ({id}, '集成测夹具', 'x', NOW(), NOW())"
        ),
    )
    .await;
}

/// 建一个夹具账号（`user` 的必填列只有 username/password/role，其余走默认）。
/// `username` 与 `nickname` 都带 id，避开那两个唯一键。
async fn make_user(db: &DatabaseConnection, id: i32, role: &str) {
    // 先删干净：`user_notification` 有外键 ON DELETE CASCADE，上次跑挂留下的通知会跟着走
    exec(db, &format!("DELETE FROM user WHERE id = {id}")).await;
    exec(
        db,
        &format!(
            "INSERT INTO user (id, username, nickname, password, role) \
             VALUES ({id}, 'it_fixture_{id}', 'it-{id}', 'x', '{role}')"
        ),
    )
    .await;
}

/// 取一个 `bigint` 标量（`COUNT(*)`、`SUM` 这一类）。
///
/// ⚠️ PG 与 MySQL 在这层有个**必须分宽**的差别：sqlx-postgres 的整数解码按 **OID 精确**
/// 匹配（`i64` 只认 `int8`、`i32` 只认 `int4`），不像 sqlx-mysql 那样一个 `i64` 通吃所有
/// 整数宽度。所以读 `int4` 列（`id` / `chat_quota_used` 那一族，`src/entity/` 里也是 `i32`）
/// 要用 [`one_i32`]，读 `int8`（`COUNT(*)`）才用这里——用错宽度会当场报
/// `Rust type i64 (as SQL type INT8) is not compatible with SQL type INT4`。
/// 夹具的每一处断言都要绕开 `try_get_by_index` 的类型报错，收进这里免得每条用例各写一遍。
async fn one_i64(db: &DatabaseConnection, sql: &str) -> Option<i64> {
    let row = db
        .query_one(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap_or_else(|e| panic!("SQL 失败：{e}\n  {sql}"))
        .expect("这道查询连一行都没回来");
    row.try_get_by_index(0).expect("这一列不是整数")
}

/// 同上，取一个 `int4` 标量（`id` / `chat_quota_used` 那一族——PG 侧它们是 `integer`，
/// 实体也是 `i32`）。分宽的理由见 [`one_i64`]。
async fn one_i32(db: &DatabaseConnection, sql: &str) -> Option<i32> {
    let row = db
        .query_one(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap_or_else(|e| panic!("SQL 失败：{e}\n  {sql}"))
        .expect("这道查询连一行都没回来");
    row.try_get_by_index(0).expect("这一列不是整数")
}

/// 同上，取 TEXT/VARCHAR 列（可空）。
async fn one_text(db: &DatabaseConnection, sql: &str) -> Option<String> {
    let row = db
        .query_one(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap_or_else(|e| panic!("SQL 失败：{e}\n  {sql}"))
        .expect("这道查询连一行都没回来");
    row.try_get_by_index::<Option<String>>(0).expect("这一列不是文本")
}

async fn count_of(db: &DatabaseConnection, sql: &str) -> i64 {
    one_i64(db, sql).await.expect("COUNT(*) 不可能是 NULL")
}

/// 某个账号当前的额度计数器（`used_of` 的名字直说它读的是哪一列）。
async fn used_of(db: &DatabaseConnection, uid: i32) -> i32 {
    one_i32(
        db,
        &format!("SELECT chat_quota_used FROM user WHERE id = {uid}"),
    )
    .await
    .expect("夹具账号不在库里（`make_user` 没跑？）")
}

// ── 真链路（create_router + 真 JWT）用的小工具 ────────────────────────────────

/// `create_token` / `verify_token` 都从进程环境读 `JWT_SECRET`（没设就 panic）。
/// `OnceLock` 保证只写一次——多个用例并发时后来的直接复用，不会互相覆盖。
fn jwt_secret() {
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        std::env::set_var(
            "JWT_SECRET",
            "pg-integration-test-secret-not-for-production",
        );
    });
}

/// 真库 + 真链路要**两个句柄**：`sea_orm::DatabaseConnection` 在 0.12 里**不是 `Clone`**
/// （它是 enum，真正的共享在 sqlx 自己的 Arc 里，没暴露到这一层），所以"给路由一个、
/// 自己留一个做直接 SQL 断言"只能各开一个池。两个池指向同一个库，语义上无差别。
///
/// 跳过的那次打印只发生一遍：第一个 `connect()` 返回 `None` 时 `?` 就已经把整个函数
/// 短路掉了（第二个根本不会被调用）。
async fn connect_pair() -> Option<(DatabaseConnection, DatabaseConnection)> {
    let db = connect().await?;
    let db_app = connect().await?;
    Some((db, db_app))
}

/// 带真库的应用（与 `tests/api_tests.rs::test_state` 同形，只是 db 换成真的）。
fn test_app(db: DatabaseConnection) -> axum::Router {
    jwt_secret();
    create_router(AppState {
        db,
        rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        // 错误上报的每 IP 计数闸（20261015）：与上面那条同形、照抄生产口径（本文件不打
        // `/api/monitor/log`）。
        report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

/// 发一条请求并取回 `(状态码, JSON 体)`。
///
/// **不是绕过路由直接调 handler**：要验的正是"经中间件判过身份之后"的行为
/// （⑦⑧ 的 `auth_uid`、⑨ 的 `auth_guard` 都在链路上）。
/// 非 JSON 的响应（401/403 的空体）解析失败时回 `Null`，调用方按状态码断言。
async fn call(
    app: axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let mut b = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let body = match body {
        Some(j) => {
            b = b.header(header::CONTENT_TYPE, "application/json");
            Body::from(j.to_string())
        }
        None => Body::empty(),
    };
    let res = app.oneshot(b.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

/// 建一个会话（`title` = NULL 是合法状态：标题由首条用户消息派生），回它的 id。
async fn make_conversation(db: &DatabaseConnection, uid: i32, title: Option<&str>) -> i32 {
    let t = match title {
        Some(t) => format!("'{t}'"),
        None => "NULL".to_string(),
    };
    exec(
        db,
        &format!(
            "INSERT INTO conversation (user_id, title, created_at, updated_at) \
             VALUES ({uid}, {t}, NOW(), NOW())"
        ),
    )
    .await;
    one_i32(
        db,
        &format!("SELECT MAX(id) FROM conversation WHERE user_id = {uid}"),
    )
    .await
    .expect("刚才插进去的会话不见得查不到")
}

/// 往会话里塞一条消息，回它的 id（`chat_history.id` 全局自增 ⇒ 消息 id 的大小
/// 就是"谁更新"的判据，命中锚取的就是最大值）。
async fn add_msg(db: &DatabaseConnection, uid: i32, cid: i32, content: &str) -> i32 {
    exec(
        db,
        &format!(
            "INSERT INTO chat_history (user_id, conversation_id, role, content, created_at) \
             VALUES ({uid}, {cid}, 'user', '{content}', NOW())"
        ),
    )
    .await;
    one_i32(
        db,
        &format!("SELECT MAX(id) FROM chat_history WHERE conversation_id = {cid}"),
    )
    .await
    .expect("刚插进去的消息查不到")
}

/// 清掉某个 uid 名下的会话与消息（两个会话用例共用一个 uid 也要各清各的）。
async fn clear_conversations(db: &DatabaseConnection, uid: i32) {
    exec(
        db,
        &format!("DELETE FROM chat_history WHERE user_id = {uid}"),
    )
    .await;
    exec(
        db,
        &format!("DELETE FROM conversation WHERE user_id = {uid}"),
    )
    .await;
}

/// 会话响应里的 id 列表，按返回顺序。
fn conv_ids(j: &serde_json::Value) -> Vec<i32> {
    j["conversations"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| c["id"].as_i64().map(|v| v as i32))
                .collect()
        })
        .unwrap_or_default()
}

/// 某个会话在响应里的 `hit_id`（未命中该会话时回 None）。
fn hit_id_of(j: &serde_json::Value, cid: i32) -> Option<i32> {
    j["conversations"]
        .as_array()?
        .iter()
        .find(|c| c["id"].as_i64() == Some(cid as i64))
        .and_then(|c| c["hit_id"].as_i64())
        .map(|v| v as i32)
}

// ─────────────────────────────────────────────────────────────────────────────
// ① `SUM(<整数列>)` 必须拿得回一个 Rust 的 i64，且值就是那几个数
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn sum_views_decodes_as_integer() {
    let Some(db) = connect().await else { return };
    make_note(&db, NOTE_SUM).await;
    // 两行（跨两天），合计 3 + 4 = 7 —— 多行求和才是 `SUM` 那条路
    exec(
        &db,
        &format!(
            "INSERT INTO note_view (note_id, view_date, cnt) VALUES \
             ({NOTE_SUM}, '2026-10-01', 3), ({NOTE_SUM}, '2026-10-02', 4)"
        ),
    )
    .await;

    // PG 上 `SUM(<整数列>)` 本来就返回 `bigint`，所以这条不再是"防 DECIMAL 陷阱"（那是
    // 切库前 MySQL 上的事故，历史锚点见文件头注），而是**在真连接上把 `SUM` 读回来并核对
    // 值**——`counts_for` 的四条里只有这一条在真库上跑聚合求和，谁把 `sum_views`
    // （src/routes/note_stats.rs）那一手弄歪、或让 sea-orm 解不回 `i64`，这里立刻红。
    let got = counts_for(&db, &[NOTE_SUM]).await.expect(
        "counts_for 报错了。所有 `SUM(cnt)` 都必须从 src/routes/note_stats.rs::sum_views \
         出去（它把结果 cast 成 `BIGINT`，sea-orm 才按 `Option<i64>` 解得回）——见该处头注 \
         与 tests/pg_integration.rs 的头注",
    );
    assert_eq!(got[&NOTE_SUM].views, 7, "3 + 4 要等于 7（多行求和走的是 SUM）");
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 零行 ⇒ 折零；没有人读过的文章也要在结果里（调用方靠它区分"0"与"取不到"）
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn counts_for_zero_fills_untouched_note() {
    let Some(db) = connect().await else { return };
    make_note(&db, NOTE_EMPTY).await;

    let got = counts_for(&db, &[NOTE_EMPTY]).await.expect("counts_for 报错");
    let c = got.get(&NOTE_EMPTY).expect(
        "传进去的 id 必须**一定有**一条（SQL 不会为没人读过的文章造行，折零是调用侧的责任）",
    );
    // SUM() 在零行时返回 NULL ⇒ `Option<i64>` 接住再折 0。四条路一起断言：
    assert_eq!(
        (c.views, c.likes, c.favorites, c.comments),
        (0, 0, 0, 0),
        "四个数都该是 0（不是缺失、不是 NULL 解码失败）"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 讨论数：只数公开看得见的（approved = 1 AND is_deleted = 0）
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn counts_for_comments_filters_visibility() {
    let Some(db) = connect().await else { return };
    make_note(&db, NOTE_COMMENTS).await;
    exec(
        &db,
        &format!("DELETE FROM note_comment WHERE note_id = {NOTE_COMMENTS}"),
    )
    .await;
    // 四行，只有一行该被数进去。**这四行的取法就是判据本身**：
    //   · approved=1 / is_deleted=0 → 数（读者点进去看得见的一条）
    //   · approved=0（待审/驳回）   → 不数（公开列表读不到）
    //   · is_deleted=1（软删）      → 不数
    // 前两条的取舍必须与 routes/comments.rs::list_comments 逐字相同，否则
    // 详情页胶囊上的数会大于点进去数出来的条数。
    exec(
        &db,
        &format!(
            "INSERT INTO note_comment (note_id, user_id, content, approved, is_deleted) VALUES \
             ({NOTE_COMMENTS}, 1, '看得见',   1, 0), \
             ({NOTE_COMMENTS}, 1, '待审',     0, 0), \
             ({NOTE_COMMENTS}, 1, '已驳回',   2, 0), \
             ({NOTE_COMMENTS}, 1, '已删',     1, 1)"
        ),
    )
    .await;

    let got = counts_for(&db, &[NOTE_COMMENTS]).await.expect("counts_for 报错");
    assert_eq!(
        got[&NOTE_COMMENTS].comments, 1,
        "四行里只该数那一行 approved=1 AND is_deleted=0 的"
    );
    // 同一个 id 上其它三个数仍是 0：证明四条查询各自独立、没有串行污染
    assert_eq!(got[&NOTE_COMMENTS].views, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 点赞与收藏：COUNT 那两条路 + 匿名点赞行（user_id NULL）+ 外键真的插得进
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn counts_for_likes_and_favorites_use_count() {
    let Some(db) = connect().await else { return };
    make_note(&db, NOTE_LIKES).await;
    exec(&db, &format!("DELETE FROM note_like WHERE note_id = {NOTE_LIKES}")).await;
    exec(
        &db,
        &format!("DELETE FROM user_favorite WHERE note_id = {NOTE_LIKES}"),
    )
    .await;

    // 一个真实账号（收藏的 user_id 是 NOT NULL + 外键 ⇒ 必须有这一行）
    const UID: i32 = 900000004;
    exec(&db, &format!("DELETE FROM user WHERE id = {UID}")).await;
    exec(
        &db,
        &format!(
            "INSERT INTO user (id, username, password) VALUES ({UID}, 'it_fixture_900000004', 'x')"
        ),
    )
    .await;

    // 登录态一票 + 匿名访客一票（`user_id IS NULL` 那条路，20261001 匿名点赞）
    exec(
        &db,
        &format!(
            "INSERT INTO note_like (note_id, user_id, visitor_key) VALUES \
             ({NOTE_LIKES}, {UID}, NULL), \
             ({NOTE_LIKES}, NULL, 'it-visitor-key-0004')"
        ),
    )
    .await;
    exec(
        &db,
        &format!("INSERT INTO user_favorite (user_id, note_id) VALUES ({UID}, {NOTE_LIKES})"),
    )
    .await;

    let got = counts_for(&db, &[NOTE_LIKES]).await.expect("counts_for 报错");
    let c = got[&NOTE_LIKES];
    assert_eq!(c.likes, 2, "登录一票 + 匿名一票，COUNT 都算（不按身份分）");
    assert_eq!(c.favorites, 1);
    assert_eq!(c.views, 0, "这篇没人读过");

    // 收尾：把夹具账号撤掉（有外键 ON DELETE CASCADE，两行计数会跟着走）
    exec(&db, &format!("DELETE FROM user WHERE id = {UID}")).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 空 id 列表必须短路（`IN ()` 是语法错误——PG 与 MySQL 同）
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn counts_for_empty_ids_never_reaches_sql() {
    let Some(db) = connect().await else { return };
    let got = counts_for(&db, &[]).await.expect(
        "空 id 列表必须**在发 SQL 之前**短路：`WHERE note_id IN ()` 在 PG 里同样是语法错误\
         （`syntax error at or near \")\"`），真发出去就是一条 ERROR",
    );
    assert!(got.is_empty(), "空进空出");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 额度：`try_consume` 的最后一格恰好扣一次，被挡住的那一轮一个数都不动
// ─────────────────────────────────────────────────────────────────────────────

/// 还剩一格时这一轮该被扣，扣完正好等于上限。
#[tokio::test]
async fn try_consume_charges_the_last_slot_exactly_once() {
    let Some(db) = connect().await else { return };
    make_user(&db, QUOTA_UID, "user").await;
    const LIMIT: i32 = 3;
    exec(
        &db,
        &format!("UPDATE user SET chat_quota_used = 2 WHERE id = {QUOTA_UID}"),
    )
    .await;

    assert_eq!(
        quota::try_consume(&db, QUOTA_UID, LIMIT).await,
        ConsumeOutcome::Consumed,
        "还剩一格（2/3），这一轮该被扣下来"
    );
    assert_eq!(
        used_of(&db, QUOTA_UID).await,
        LIMIT,
        "扣完正好等于上限（不是 2、不是 4——一轮就是一轮）"
    );

    // ★ 本文件最值钱的一条断言：配额用尽之后**计数器不许再动**。
    //
    // 判据住的正是 `try_consume` 头注 ① 那件事：`UPDATE ... WHERE used < limit`
    // 匹配不到行 ⇒ `rows_affected == 0` ⇒ Exhausted。谁把这条 SQL"优化"成
    // `CASE WHEN used < limit THEN used + 1 ELSE used END` 那种"匹配而不改变"的写法，
    // `rows_affected` 会变成 1（PG 的 `UPDATE` 报的是**匹配到并重写的行数**，不区分
    // "值到底变没变"——`WHERE` 只按 `id` 匹配就恒命中一行），0 的含义于是就在"没抢到"与
    // "抢到了但没变"之间漂移。真正的坑是反过来把判断搬到应用层。
    // 漂移的症状只有一个：**最后一格被扣两次** ⇒ 上限 500 的人实际只能聊 499 轮。
    for i in 0..2 {
        assert_eq!(
            quota::try_consume(&db, QUOTA_UID, LIMIT).await,
            ConsumeOutcome::Exhausted,
            "第 {} 次超限调用该被挡住",
            i + 1
        );
        assert_eq!(
            used_of(&db, QUOTA_UID).await,
            LIMIT,
            "★ 被挡住的那一轮**一个数都不许动**（第 {} 次超限调用把它推到了别处）",
            i + 1
        );
    }
}

/// "0 行"这个信号不区分"被上限挡住"与"人没了"——两条都落在 `Exhausted`。
/// `Degraded` 只留给 `Err`（DB 故障），这个分类边界必须钉住：它是 fail-open 的唯一入口。
#[tokio::test]
async fn try_consume_reports_zero_rows_as_exhausted_not_degraded() {
    let Some(db) = connect().await else { return };
    make_user(&db, QUOTA_UID2, "user").await;
    exec(
        &db,
        &format!("UPDATE user SET chat_quota_used = 0 WHERE id = {QUOTA_UID2}"),
    )
    .await;

    assert_eq!(
        quota::try_consume(&db, QUOTA_UID2, 5).await,
        ConsumeOutcome::Consumed
    );
    assert_eq!(
        used_of(&db, QUOTA_UID2).await,
        1,
        "一轮就是一轮（不是 0、不是 2）"
    );

    // 不存在的 uid：同样命中 0 行 ⇒ Exhausted。调用方只会在认证过的 uid 上调用它，
    // 这里只是把这条分类钉下来——**别把"0 行"改判成 Degraded**，那会让一个被删掉的
    // 账号在每轮对话里静默走 fail-open 那条路，而日志里一个告警都不会有。
    assert_eq!(
        quota::try_consume(&db, QUOTA_UID2 + 999, 5).await,
        ConsumeOutcome::Exhausted,
        "0 行一律读作 Exhausted；Degraded 只留给 Err（DB 故障，那是 fail-open 的唯一入口）"
    );

    // 上限为 0（`WHERE used < 0` 永不成立）：一次都不放行，而且**不动计数器**
    assert_eq!(
        quota::try_consume(&db, QUOTA_UID2, 0).await,
        ConsumeOutcome::Exhausted,
        "上限 0 ⇒ 一次都不放行"
    );
    assert_eq!(used_of(&db, QUOTA_UID2).await, 1, "被挡住的那次不许计数");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 会话搜索：`LIKE` 的 `%` 与 `_` 必须按**字面**匹配（用户输入注入面）
// ─────────────────────────────────────────────────────────────────────────────

/// 用户输入里的 `%` / `_` 不转义就是通配符：搜 "100%" 会连带命中任何含 "100" 的会话，
/// 搜 "a_b" 会连带命中 "aXb"。这条判据只有真库能出——LIKE 的语义在 SQL 里。
#[tokio::test]
async fn conversation_search_escapes_like_wildcards() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, CONV_SEARCH_UID, "user").await;
    clear_conversations(&db, CONV_SEARCH_UID).await;

    // 两对"字面命中 / 只被通配符命中"的标题。**右边那条就是判据本身**：
    // 不转义时它会一起冒出来。
    let pct = make_conversation(&db, CONV_SEARCH_UID, Some("rate_100%now")).await;
    let pct_decoy = make_conversation(&db, CONV_SEARCH_UID, Some("rateX100Ynow")).await;
    let und = make_conversation(&db, CONV_SEARCH_UID, Some("a_b")).await;
    let und_decoy = make_conversation(&db, CONV_SEARCH_UID, Some("aXb")).await;

    let app = test_app(db_app);
    let token = auth_jwt::create_token(CONV_SEARCH_UID, "user", 0);

    // `%` 走 URL 编码（%25），axum 的 Query 会解回字面 `%`
    let (st, j) = call(
        app.clone(),
        "GET",
        "/api/chat/conversations?q=100%25",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "带真令牌的列表请求不该 401/403：{j}");
    let ids = conv_ids(&j);
    assert_eq!(
        ids,
        vec![pct],
        "只有**字面**含 `100%` 的那条该被命中。拿到了 {ids:?}（含 {} 就说明 `%` 没转义、\
         退化成通配符了）",
        pct_decoy
    );

    // `_` 是 LIKE 的单字符通配符
    let (_, j) = call(
        app,
        "GET",
        "/api/chat/conversations?q=a_b",
        Some(&token),
        None,
    )
    .await;
    let ids = conv_ids(&j);
    assert_eq!(
        ids,
        vec![und],
        "只有**字面**含 `a_b` 的那条该被命中。拿到了 {ids:?}（含 {} 就说明 `_` 没转义）",
        und_decoy
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 会话列表：置顶优先 + 最后活动倒序；命中锚指"每会话最新那条命中消息"
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn conversation_list_pins_first_and_anchors_hits() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, CONV_LIST_UID, "user").await;
    clear_conversations(&db, CONV_LIST_UID).await;

    let pinned = make_conversation(&db, CONV_LIST_UID, Some("pinned old")).await;
    let mid = make_conversation(&db, CONV_LIST_UID, Some("mid")).await;
    let new = make_conversation(&db, CONV_LIST_UID, Some("spark title")).await;

    // 时间必须显式拨开：`NOW()` 的秒精度让三条落在同一秒，排序就退化成按 id 兜底，
    // 而"最后活动倒序"这条判据会**假绿**（id 顺序恰好与时间顺序一致）。
    // 置顶那条刻意拨到很老：证明它排第一靠的是 `pinned`，与时间无关。
    // `conversation.pinned` 在 PG 侧是**真 boolean**（不是 MySQL 的 tinyint）⇒ 写 `true`，
    // 写 `1` 会被 PG 拒绝（integer 不能隐式转 boolean）。`src/entity/conversation.rs` 里
    // 它也是 `bool`。
    exec(
        &db,
        &format!(
            "UPDATE conversation SET pinned = true, updated_at = '2020-01-01 00:00:00' \
             WHERE id = {pinned}"
        ),
    )
    .await;
    exec(
        &db,
        &format!("UPDATE conversation SET updated_at = '2026-01-02 00:00:00' WHERE id = {mid}"),
    )
    .await;
    exec(
        &db,
        &format!("UPDATE conversation SET updated_at = '2026-01-03 00:00:00' WHERE id = {new}"),
    )
    .await;

    // 消息：mid 里两条命中（要取**最新**那条），new 里一条不命中（走"仅标题命中"那一支）
    add_msg(&db, CONV_LIST_UID, pinned, "hello").await;
    add_msg(&db, CONV_LIST_UID, mid, "first").await;
    add_msg(&db, CONV_LIST_UID, mid, "spark second").await;
    let mid_newest_hit = add_msg(&db, CONV_LIST_UID, mid, "spark third").await;
    let new_first_msg = add_msg(&db, CONV_LIST_UID, new, "greeting").await;

    let app = test_app(db_app);
    let token = auth_jwt::create_token(CONV_LIST_UID, "user", 0);

    // 不搜索：置顶优先，组内按最后活动倒序
    let (st, j) = call(app.clone(), "GET", "/api/chat/conversations", Some(&token), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        conv_ids(&j),
        vec![pinned, new, mid],
        "置顶的排第一（虽然它的 updated_at 是 2020 年），其余按最后活动倒序"
    );
    assert!(
        hit_id_of(&j, mid).is_none(),
        "没搜索时 hit_id 一律 null（前端据此决定是否定位）"
    );

    // 搜索：命中锚 = 每会话最新那条命中消息；仅标题命中的回落成该会话首条消息
    let (_, j) = call(
        app,
        "GET",
        "/api/chat/conversations?q=spark",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        conv_ids(&j),
        vec![new, mid],
        "置顶那条不含这个词，不该出现"
    );
    assert_eq!(
        hit_id_of(&j, mid),
        Some(mid_newest_hit),
        "内容命中要定位到**最新**那条命中消息，不是第一条"
    );
    assert_eq!(
        hit_id_of(&j, new),
        Some(new_first_msg),
        "仅标题命中的会话定位到**标题出处**（首条消息），不是最新消息"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑨ 额度申请：认领只生效一次（第二刀零副作用）
// ─────────────────────────────────────────────────────────────────────────────

/// `review_quota_request` 的顺序是**读校验 → 原子认领 → 副作用 → 通知**。
/// 这里逐条钉住"认领不到就什么都不做"：第二刀既不许再清零，也不许多发一条通知。
#[tokio::test]
async fn quota_review_claims_once_and_touches_nothing_on_the_second_call() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, ADMIN_UID, "admin").await;
    make_user(&db, APPLY_UID, "user").await;
    exec(
        &db,
        &format!("UPDATE user SET chat_quota_used = 7 WHERE id = {APPLY_UID}"),
    )
    .await;
    exec(
        &db,
        &format!("DELETE FROM user_notification WHERE user_id = {APPLY_UID}"),
    )
    .await;
    exec(
        &db,
        &format!("DELETE FROM quota_request WHERE user_id = {APPLY_UID}"),
    )
    .await;
    exec(
        &db,
        &format!(
            "INSERT INTO quota_request (user_id, reason, status) \
             VALUES ({APPLY_UID}, 'it reason', 0)"
        ),
    )
    .await;
    let rid = one_i32(
        &db,
        &format!("SELECT MAX(id) FROM quota_request WHERE user_id = {APPLY_UID}"),
    )
    .await
    .expect("刚插进去的申请查不到");

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(ADMIN_UID, "admin", 0);
    let uri = format!("/api/protected/quota/requests/{rid}/review");

    // ① 第一刀：认领得到 ⇒ 清零 + 一条通知
    let (st, j) = call(
        app.clone(),
        "POST",
        &uri,
        Some(&admin),
        Some(r#"{"approved":true}"#),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "管理员该能批准这条申请：{j}");
    assert_eq!(
        used_of(&db, APPLY_UID).await,
        0,
        "批准的唯一动作就是把计数器归零"
    );
    assert_eq!(
        count_of(
            &db,
            &format!(
                "SELECT COUNT(*) FROM user_notification \
                 WHERE user_id = {APPLY_UID} AND title = '{NOTICE_APPROVED_TITLE}'"
            )
        )
        .await,
        1,
        "批准要发一条通知"
    );

    // ② 他又聊了 5 轮。第二刀若真的又清一次零，这个数会被抹掉——**这就是判据**：
    //    （不这么放的话"重复批准又清了一次"在计数器上完全不可见，只有通知条数看得见）
    exec(
        &db,
        &format!("UPDATE user SET chat_quota_used = 5 WHERE id = {APPLY_UID}"),
    )
    .await;
    let (st2, j2) = call(
        app.clone(),
        "POST",
        &uri,
        Some(&admin),
        Some(r#"{"approved":true}"#),
    )
    .await;
    assert_eq!(st2, StatusCode::OK, "重复处理是正常结局，不是 500 级的服务器错误");
    assert_eq!(j2["code"], 500, "信封里如实说「已经处理过了」：{j2}");
    assert_eq!(
        j2["message"], "这条申请已经处理过了",
        "措辞是跨语言契约（agent 逐字转述），别顺手改：{j2}"
    );
    assert_eq!(
        used_of(&db, APPLY_UID).await,
        5,
        "★ 第二刀必须**零副作用**：他已经聊过的那 5 轮不许被抹掉"
    );
    assert_eq!(
        count_of(
            &db,
            &format!(
                "SELECT COUNT(*) FROM user_notification \
                 WHERE user_id = {APPLY_UID} AND title = '{NOTICE_APPROVED_TITLE}'"
            )
        )
        .await,
        1,
        "★ 也不许发第二条「额度已清零」——那一条是假的"
    );
    assert_eq!(
        count_of(
            &db,
            &format!(
                "SELECT COUNT(*) FROM quota_request \
                 WHERE id = {rid} AND status = 1 AND handled_by = {ADMIN_UID}"
            )
        )
        .await,
        1,
        "认领写下的 status/handled_by 只该有一份"
    );

    // ③ 驳回：没填理由 ⇒ 库里 `note` 是 NULL，通知正文回落成系统写的那一句。
    //    **不往库里塞一句编好的话**是这条路径的承重纪律（模块头注 ②）。
    exec(
        &db,
        &format!(
            "INSERT INTO quota_request (user_id, reason, status) \
             VALUES ({APPLY_UID}, 'second reason', 0)"
        ),
    )
    .await;
    let rid2 = one_i32(
        &db,
        &format!("SELECT MAX(id) FROM quota_request WHERE user_id = {APPLY_UID}"),
    )
    .await
    .expect("第二份申请查不到");
    let (_, j3) = call(
        app,
        "POST",
        &format!("/api/protected/quota/requests/{rid2}/review"),
        Some(&admin),
        Some(r#"{"approved":false}"#),
    )
    .await;
    assert_eq!(j3["code"], 200, "{j3}");
    assert_eq!(
        one_text(
            &db,
            &format!("SELECT note FROM quota_request WHERE id = {rid2}")
        )
        .await,
        None,
        "空理由落 NULL——库里不留一句不是人写的'理由'"
    );
    let content = one_text(
        &db,
        &format!(
            "SELECT content FROM user_notification \
             WHERE user_id = {APPLY_UID} ORDER BY id DESC LIMIT 1"
        ),
    )
    .await
    .unwrap_or_default();
    assert!(
        content.contains(NO_REASON_FALLBACK),
        "通知正文要在**通知层**回落成「{NO_REASON_FALLBACK}」，实得：{content}"
    );
    assert_eq!(
        used_of(&db, APPLY_UID).await,
        5,
        "驳回不动额度（一个字节都不动）"
    );
}

// ════════════════════════════════════════════════════════════════════════════
// ⑩ 站内聚合搜索（20261006）：四类内容的**命中集合**必须精确
// ════════════════════════════════════════════════════════════════════════════
//
// 为什么非要有这一层：这个端点一次把**四张表**倒给访客，所以它的核心判据全是
// 可见性谓词——`is_public` / `status <> 'draft'` / `approved` / `is_deleted`，
// 外加"评论的父文章必须可见"。这些在 `MockDatabase` 面前**全是"通过"**：
// mock 只比对我们喂进去的那串 SQL 文本，不会真的执行。唯一的真判据是——
// 播一条**不该出现**的行进去，再断言它**没有**出现。
//
// 本用例的断言一律是**精确 id 集合**（不是"包含"）。"包含"型断言对本接口尤其危险：
// 四条谓词里漏掉任何一条，结果都是**多出几行**而不是少几行——而"包含"照样绿。
//
// ## 负控记录（写这条用例时实际跑过的，别删这段）
//
// 三处各改坏一次、确认本用例转红、随即还原：
//   · 留言分支的 SQL 预筛里加上 `title LIKE`（印章是「愿」，等于全表命中）→ 红；
//   · 去掉 `is_deleted = 0` → 红；去掉 `note_id IN (可见文章)` → 红；
//   · 去掉 `like_escape` → 红（见下面那条反斜杠夹具，**只有它能抓住转义**）。
// 三处都不是靠"看代码觉得对"。

/// 夹具关键词：**刻意是个真实内容里不可能出现的怪串**。
/// 本用例断言的是精确 id 集合——关键词一旦撞上库里任何一条真实内容
///（开发库上尤其容易），断言会莫名其妙地红，而根因看着像"搜索坏了"。
const AGG_KW: &str = "qqzz聚合夹具";

const AGG_NOTE_OK: i32 = 900000021; // 公开 + 已发布 + 标题命中 ⇒ 该出现
const AGG_NOTE_DRAFT: i32 = 900000022; // status='draft' ⇒ 不许出现
const AGG_NOTE_HIDDEN: i32 = 900000023; // is_public=0 ⇒ 不许出现

const AGG_TALK_TITLE: i32 = 900000031; // approved=1，**标题**命中
const AGG_TALK_BODY: i32 = 900000032; // approved=1，**正文**命中
const AGG_TALK_PENDING: i32 = 900000033; // approved=0 ⇒ 不许出现
const AGG_BOARD_OK: i32 = 900000034; // src=board，正文命中
const AGG_BOARD_SIGN: i32 = 900000035; // src=board，**印章里有关键词、正文没有** ⇒ 不许出现
const AGG_BOARD_BACKSLASH: i32 = 900000036; // 反斜杠夹具，只被第二条查询命中

const AGG_COMMENT_OK: i32 = 900000041; // 可见文章下、已过审、未删 ⇒ 该出现
const AGG_COMMENT_HIDDEN_NOTE: i32 = 900000042; // 挂在不许出现的那篇文章上 ⇒ 不许出现
const AGG_COMMENT_DELETED: i32 = 900000043; // is_deleted=1 ⇒ 不许出现
const AGG_COMMENT_PENDING: i32 = 900000044; // approved=0 ⇒ 不许出现

/// 取某一类结果里的 `key` 集合（**升序**：服务端按相关度排，集合断言不该依赖它）。
///
/// 回 `i32` 是为了与上面那批夹具常量同型（`key` 在线上是 int，收窄无损）。
fn agg_keys(j: &serde_json::Value, bucket: &str) -> Vec<i32> {
    let mut v: Vec<i32> = j["data"][bucket]
        .as_array()
        .unwrap_or_else(|| panic!("data.{bucket} 不是数组：{j}"))
        .iter()
        .map(|h| h["key"].as_i64().expect("命中行没有整数 key") as i32)
        .collect();
    v.sort_unstable();
    v
}

#[tokio::test]
async fn test_聚合搜索的四类命中集合与可见性谓词() {
    let Some((db, db_app)) = connect_pair().await else {
        return;
    };

    // ── 播种（先清自己的残留：上次跑挂了会留下行）────────────────────────
    for id in [
        AGG_NOTE_OK,
        AGG_NOTE_DRAFT,
        AGG_NOTE_HIDDEN,
    ] {
        exec(&db, &format!("DELETE FROM note WHERE id = {id}")).await;
    }
    for id in [
        AGG_TALK_TITLE,
        AGG_TALK_BODY,
        AGG_TALK_PENDING,
        AGG_BOARD_OK,
        AGG_BOARD_SIGN,
        AGG_BOARD_BACKSLASH,
    ] {
        exec(&db, &format!("DELETE FROM talk WHERE id = {id}")).await;
    }
    for id in [
        AGG_COMMENT_OK,
        AGG_COMMENT_HIDDEN_NOTE,
        AGG_COMMENT_DELETED,
        AGG_COMMENT_PENDING,
    ] {
        exec(&db, &format!("DELETE FROM note_comment WHERE id = {id}")).await;
    }

    // 三篇文章。**只有第一行该被搜到**；另外两行是两条谓词的负控。
    // 正文都刻意不含关键词 ⇒ 分数只来自标题（100），排序可预期。
    // `is_public` 在 PG 侧是**真 boolean**（`src/entity/note.rs` 里也是 `bool`）⇒ 写
    // `true`/`false`，写 `1`/`0` 会被 PG 拒绝。
    exec(
        &db,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status) VALUES \
             ({AGG_NOTE_OK},     '{AGG_KW} 可见文章', '正文里没有那个词', NOW(), NOW(), true,  'published'), \
             ({AGG_NOTE_DRAFT},  '{AGG_KW} 草稿',     '正文里没有那个词', NOW(), NOW(), true,  'draft'), \
             ({AGG_NOTE_HIDDEN}, '{AGG_KW} 隐藏文章', '正文里没有那个词', NOW(), NOW(), false, 'published')"
        ),
    )
    .await;

    // 说说 / 留言。`title` 那一列的**两套语义**正是这段夹具的重点：
    // 说说的 `title` 是标题（该被搜），留言的 `title` 是印章「愿」（**不许**被搜）。
    exec(
        &db,
        &format!(
            "INSERT INTO talk (id, title, content, cat, v, author, user_id, src, approved, created_at, updated_at) VALUES \
             ({AGG_TALK_TITLE}, '{AGG_KW} 说说标题', '说说正文里没有那个词', '愿', 0, '', 0, 'talk',  1, NOW(), NOW()), \
             ({AGG_TALK_BODY},  '无关标题',           '说说正文里出现 {AGG_KW} 一次', '愿', 0, '', 0, 'talk', 1, NOW(), NOW()), \
             ({AGG_TALK_PENDING}, '无关标题',         '待审的正文里也有 {AGG_KW}', '愿', 0, '', 0, 'talk',  0, NOW(), NOW()), \
             ({AGG_BOARD_OK},   '愿',                 '河灯正文里也有 {AGG_KW}', '愿', 0, '留名甲', 0, 'board', 1, NOW(), NOW()), \
             ({AGG_BOARD_SIGN}, '{AGG_KW}',           '这条河灯的正文里没有那个词', '愿', 0, '留名乙', 0, 'board', 1, NOW(), NOW())"
        ),
    )
    .await;

    // 反斜杠夹具：正文含**一个字面反斜杠**的 `c:\path`。
    // 这是**唯一能抓住 `like_escape` 的判据**：用户搜 `c:\path` 时，未转义的
    // LIKE 模式 `%c:\path%` 里 `\p` 会被 PG 当成转义的 `p`（等价于搜 `c:path`），
    // 于是这一行**根本不会被取回来**，内存里那一遍再准也救不了——**丢的是命中**。
    // 注意这条与"`%` 变成通配符"不同：那个方向只会多取行（内存会筛掉），抓不住。
    //
    // ⚠️ 字面量里是**单个**反斜杠（`'… c:\path …'`），不是 MySQL 时代那个 `\\`：
    // PG 默认 `standard_conforming_strings = on`，字符串里的反斜杠就是反斜杠、不吃一层
    // （MySQL 默认会吃一层，所以旧夹具才写 `\\`）。写成 `\\` 会存进两个反斜杠，
    // 这条判据当场失去意义。
    exec(
        &db,
        &format!(
            r"INSERT INTO talk (id, title, content, cat, v, author, user_id, src, approved, created_at, updated_at) VALUES
             ({AGG_BOARD_BACKSLASH}, '愿', '路径 c:\path 结束', '愿', 0, '留名丙', 0, 'board', 1, NOW(), NOW())"
        ),
    )
    .await;

    // 四条评论，**只有第一条该出现**。
    exec(
        &db,
        &format!(
            "INSERT INTO note_comment (id, note_id, user_id, content, approved, is_deleted, created_at, updated_at) VALUES \
             ({AGG_COMMENT_OK},          {AGG_NOTE_OK},     0, '评论正文 {AGG_KW}', 1, 0, NOW(), NOW()), \
             ({AGG_COMMENT_HIDDEN_NOTE}, {AGG_NOTE_HIDDEN}, 0, '评论正文 {AGG_KW}', 1, 0, NOW(), NOW()), \
             ({AGG_COMMENT_DELETED},     {AGG_NOTE_OK},     0, '评论正文 {AGG_KW}', 1, 1, NOW(), NOW()), \
             ({AGG_COMMENT_PENDING},     {AGG_NOTE_OK},     0, '评论正文 {AGG_KW}', 0, 0, NOW(), NOW())"
        ),
    )
    .await;

    // ── 真链路 ────────────────────────────────────────────────────────
    let body = format!(r#"{{"keyword":"{AGG_KW}"}}"#);
    let (st, j) = call(test_app(db_app), "POST", "/api/public/search", None, Some(&body)).await;
    assert_eq!(st, StatusCode::OK, "聚合搜索不该在 HTTP 层失败：{j}");
    assert_eq!(j["code"], 200, "信封 code 必须是 200：{j}");

    // 四个数组的**精确** id 集合（多一行少一行都红）
    assert_eq!(agg_keys(&j, "notes"), vec![AGG_NOTE_OK], "文章：只有公开+已发布那一篇该出现");
    assert_eq!(
        agg_keys(&j, "talks"),
        vec![AGG_TALK_TITLE, AGG_TALK_BODY],
        "说说：approved=0 的不许出现"
    );
    assert_eq!(
        agg_keys(&j, "board"),
        vec![AGG_BOARD_OK],
        "留言：只有**正文**命中的那条；印章里带关键词的那条不许出现"
    );
    assert_eq!(
        agg_keys(&j, "comments"),
        vec![AGG_COMMENT_OK],
        "评论：软删/未过审/挂在不可见文章下的三条都不许出现"
    );

    // 三处同源：总数 == counts 四项之和 == 四个数组长度之和
    assert_eq!(j["data"]["total"], 5, "命中总数：{j}");
    assert_eq!(j["data"]["counts"]["note"], 1);
    assert_eq!(j["data"]["counts"]["talk"], 2);
    assert_eq!(j["data"]["counts"]["board"], 1);
    assert_eq!(j["data"]["counts"]["comment"], 1);

    // 说说行按分数排在前面的是**标题命中的那条**（标题 +100 vs 正文 1 次 +1）。
    // 这条钉的是"打分的标题维度真的接上了"——它就是 +100 那一档的可见后果。
    let talk_order: Vec<i64> = j["data"]["talks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["key"].as_i64().unwrap())
        .collect();
    assert_eq!(
        talk_order,
        vec![AGG_TALK_TITLE as i64, AGG_TALK_BODY as i64],
        "标题命中的该排在只命中正文的前面"
    );

    // 评论行必须带上**跳转所需的两件东西**：所属文章 id 与那篇文章的标题。
    let c0 = &j["data"]["comments"][0];
    assert_eq!(c0["type"], "comment");
    assert_eq!(
        c0["noteId"], AGG_NOTE_OK,
        "评论行不带 noteId，前端就拼不出 /article/<id>?cid=<id>"
    );
    assert_eq!(
        c0["title"], format!("{AGG_KW} 可见文章"),
        "评论行的行首标题该是**它挂在哪篇文章**上（不是评论自己的正文）"
    );
    // 其余三类的 noteId 恒缺席（前端凭它是否存在判"能不能跳"）
    for (bucket, k) in [("notes", AGG_NOTE_OK), ("talks", AGG_TALK_TITLE), ("board", AGG_BOARD_OK)] {
        let row = j["data"][bucket]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["key"] == k)
            .unwrap_or_else(|| panic!("{bucket} 里没有 {k}：{j}"));
        assert!(row["noteId"].is_null(), "{bucket} 的 noteId 该是 null：{row}");
    }
    // 留言行的行首标题恒空串（`title` 那一列是印章，不能当标题显示）
    let b0 = &j["data"]["board"][0];
    assert_eq!(b0["type"], "board");
    assert_eq!(b0["title"], "", "留言行的标题必须留空");
    assert_eq!(b0["snippet"], "河灯正文里也有 qqzz聚合夹具", "摘要该是正文（折平空白后）");
    // 留言的作者是**自由留名**，不是账号身份
    assert_eq!(b0["author"], "留名甲");

    // ── 第二条查询：LIKE 转义（反斜杠）────────────────────────────────
    // `keyword` 在这里真的是 `c:\path`（JSON 里 `\\` 折成一个反斜杠），
    // 而夹具正文里存的也是**字面量** `c:\path`（PG 的字符串字面量 `'… c:\path …'`
    // 不消费反斜杠，见上面夹具那段的 ⚠️）。
    let body = r#"{"keyword":"c:\\path"}"#;
    let (st, j) = call(test_app(db), "POST", "/api/public/search", None, Some(body)).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        agg_keys(&j, "board"),
        vec![AGG_BOARD_BACKSLASH],
        "搜 `c:\\path` 必须命中那条**含字面量反斜杠**的留言——\
         取不到就是 like_escape 漏了（`\\p` 被 LIKE 当成转义的 `p`，直接搜成了 `c:path`）：{j}"
    );
    // 另一面：转义**不该把别的行顺带捞进来**。这三条零断言在 CI 那种干净库上恒成立
    //（夹具关键词之外的正文不会出现 `c:\path`）；开发库上若有真实内容写着这个路径，
    // 这里会红，而那是夹具假设不成立、不是搜索坏了。
    assert_eq!(j["data"]["counts"]["note"], 0);
    assert_eq!(j["data"]["counts"]["talk"], 0);
    assert_eq!(j["data"]["counts"]["comment"], 0);
}

// ════════════════════════════════════════════════════════════════════════════
// ⑪ 后台留言列表（20261014）：服务端筛选 / 排序 / 分页 / LEFT JOIN
// ════════════════════════════════════════════════════════════════════════════
//
// 断言一律写成**精确 id 集合**或**精确 id 序列**。这一页从"整表拉回前端筛"改成
// 服务端筛之后，最典型的坏法恰好都是"多给你几行"或"少给你几行"而两侧都看着对——
// 用"包含"断言会全绿。

/// 夹具关键词。**必须纯 ASCII**——与 ⑩ 不同：⑩ 只用它当 POST body，这里它要进
/// **查询串**，`http::Uri` 不收非 ASCII 字节（中文会 panic 在 `b.body(..).unwrap()`）。
/// 它照旧是"真实内容里不可能出现的怪串"（精确集合断言的前提）。
const BOARDQ_KW: &str = "qqzzboardkw";

/// 调用方。**必须是管理员**——这条接口住在 `protected_routes` 域里，域上挂了
/// `auth_guard`（`routes/mod.rs` 末尾那个 `route_layer`），而它判的是**库里的
/// `user.role`**（`authz::can_access_console`，不信 JWT 里的 role）⇒ 光有一枚合法令牌
/// 只会拿到 403。（本条用例的第一版就是这么写的：普通 user 令牌，CI 上第一条断言
/// 就报了 403——handler 自己那个 `current_uid` 只是域内的第二道、更弱的检查。）
/// 夹具里没有任何留言指向这个账号 ⇒ 他不参与命中集合。
const BOARDQ_UID_ADMIN: i32 = 900000050;

const BOARDQ_UID_A: i32 = 900000051; // 用户名里带关键词
const BOARDQ_UID_B: i32 = 900000052; // 昵称里带关键词，且名下**有三条**命中行
/// 一个**不存在的用户**：孤儿留言指向它（线上对应"发布者账号已经删了"）。
/// 高位夹具段里没有任何用例会建这个 id ⇒ `LEFT JOIN` 与 `INNER JOIN` 的分界线落在这里。
const BOARDQ_GHOST_UID: i32 = 900000059;

const BOARDQ_BODY: i32 = 900000061; // 正文命中，愿
const BOARDQ_SIGN: i32 = 900000062; // **留名**命中，寄
const BOARDQ_UBYNAME: i32 = 900000063; // **用户名**命中（A），愿
const BOARDQ_UBYNICK: i32 = 900000064; // **昵称**命中（B），愿
const BOARDQ_DECOY: i32 = 900000065; // 诱饵：四列全不命中，诉
const BOARDQ_OTHER_SRC: i32 = 900000066; // `src='talk'` 的说说，正文命中 ⇒ 不许出现
const BOARDQ_UBYNICK2: i32 = 900000067; // 昵称命中（B），愿
const BOARDQ_UBYNICK3: i32 = 900000068; // 昵称命中（B），愿
const BOARDQ_ORPHAN: i32 = 900000069; // 正文命中，但发布者已不存在

/// 全部夹具行共用的时间戳（见文件头第四半的最后一段）：**同秒多行**是分页最难的情形。
const BOARDQ_AT: &str = "2026-01-02 03:04:05";

/// `q=BOARDQ_KW` 该命中的**全部**行（无序；要比集合时先各自排序）。
const BOARDQ_HITS: [i32; 7] = [
    BOARDQ_BODY,
    BOARDQ_SIGN,
    BOARDQ_UBYNAME,
    BOARDQ_UBYNICK,
    BOARDQ_UBYNICK2,
    BOARDQ_UBYNICK3,
    BOARDQ_ORPHAN,
];

/// 取列表里的 id 序列（**刻意不排序**：这一页的次序本身就是判据的一部分——
/// 倒序/正序与"同秒按 id 排"都要能被看见。要比集合的调用方自己排）。
fn board_ids(j: &serde_json::Value) -> Vec<i32> {
    j["data"]
        .as_array()
        .unwrap_or_else(|| panic!("data 不是数组（信封形状变了？）：{j}"))
        .iter()
        // ⚠️ 这一行的 id **不叫 `id`**：`BoardAdminDto` 把它 `rename` 成了 `talkKey`
        //（留言管理那一页的前端也按 `talkKey` 读）。第一版这里写的是 `id`，CI 上当场
        // panic 在"没有整数 id"——断言的行形状同样是住在别人手里的前提。
        .map(|r| {
            r["talkKey"]
                .as_i64()
                .unwrap_or_else(|| panic!("留言行没有整数 talkKey：{r}"))
                as i32
        })
        .collect()
}

/// 升序副本，专门给"集合相等"的断言用。
fn sorted(mut v: Vec<i32>) -> Vec<i32> {
    v.sort_unstable();
    v
}

#[tokio::test]
async fn test_后台留言列表的服务端筛选分页与连接语义() {
    let Some((db, db_app)) = connect_pair().await else {
        return;
    };

    // ── 播种（先清自己的残留：上次跑挂了会留下行）────────────────────────
    // `talk` 的孤儿行指向 `BOARDQ_GHOST_UID`，它**没有** user 行可删——别在这里
    // "顺手"把它也塞进 DELETE：那行删不掉的 SQL 会让播种当场 panic。
    for id in BOARDQ_HITS.into_iter().chain([BOARDQ_DECOY, BOARDQ_OTHER_SRC]) {
        exec(&db, &format!("DELETE FROM talk WHERE id = {id}")).await;
    }
    for id in [BOARDQ_UID_ADMIN, BOARDQ_UID_A, BOARDQ_UID_B] {
        exec(&db, &format!("DELETE FROM user WHERE id = {id}")).await;
    }

    // 三个用户：一个是调用方（管理员，见上面那条常量的说明），另外两个**命中四列里的
    // 不同两列**（用户名的是 A、昵称的是 B）。
    // B 名下三条留言 ⇒ "join 让行翻倍"若有发生，B 那三条会变成 9 行、并集立刻对不上。
    // A 的昵称**刻意不含关键词**（四点全不沾）：四列里只要有一列没被真跑过，
    // 精确集合断言就还绿着——所以"哪一列命中"必须一列一列地钉死。
    // 这两个账号的 username / nickname 也都取自夹具的怪串：那两列上有唯一索引
    //（`nickname_unique_20261002.sql`），用 'jia' 这种常见词撞上库里已有的行，
    // 会让**播种那一步**就失败——而报错看着像"测试坏了"，不是"唯一约束起作用了"。
    exec(
        &db,
        &format!(
            "INSERT INTO user (id, username, nickname, password, role) VALUES \
             ({BOARDQ_UID_ADMIN}, 'nb-qqzz-admin', 'nb-qqzz-admin', 'x', 'admin'), \
             ({BOARDQ_UID_A}, '{BOARDQ_KW}_a', 'nb-jia-qqzz', 'x', 'user'), \
             ({BOARDQ_UID_B}, 'b_{BOARDQ_KW}', '{BOARDQ_KW}_yi', 'x', 'user')"
        ),
    )
    .await;

    // 九条 talk：七条该被搜到、两条是负控（四列全不命中的诱饵、`src='talk'` 的说说）。
    // 每一行的 `title` 都是印章（留言那一列的语义）；正文里有关键词的只有三条
    //（BODY / OTHER_SRC / ORPHAN）——OTHER_SRC 那一条正是"src 谓词"的负控。
    exec(
        &db,
        &format!(
            "INSERT INTO talk (id, title, content, cat, v, author, user_id, src, approved, created_at, updated_at) VALUES \
             ({BOARDQ_BODY},      '愿', '灯下写着 {BOARDQ_KW} 两个字', '愿', 0, 'jia',              0,                  'board', 1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_SIGN},      '寄', '正文里没有那个词',             '寄', 0, '{BOARDQ_KW}_ming', 0,                  'board', 1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_UBYNAME},   '愿', '正文里没有那个词',             '愿', 0, 'bing',             {BOARDQ_UID_A},     'board', 1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_UBYNICK},   '愿', '正文里没有那个词',             '愿', 0, 'ding',             {BOARDQ_UID_B},     'board', 1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_DECOY},     '诉', '正文里没有那个词',             '诉', 0, 'wu',               0,                  'board', 1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_OTHER_SRC}, '无关标题', '说说正文里也有 {BOARDQ_KW}', '愿', 0, '',            0,                  'talk',  1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_UBYNICK2},  '愿', '正文里没有那个词',             '愿', 0, 'ji',               {BOARDQ_UID_B},     'board', 1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_UBYNICK3},  '愿', '正文里没有那个词',             '愿', 0, 'geng',             {BOARDQ_UID_B},     'board', 1, '{BOARDQ_AT}', NOW()), \
             ({BOARDQ_ORPHAN},    '愿', '灯下也写着 {BOARDQ_KW} 两个字', '愿', 0, 'xin',             {BOARDQ_GHOST_UID}, 'board', 1, '{BOARDQ_AT}', NOW())"
        ),
    )
    .await;

    // ── 真链路 ────────────────────────────────────────────────────────
    jwt_secret();
    // 域名「管理员」是 `auth_guard` 判的（查库、只看按 uid 取回来的那一行的 `role`），
    // 而 JWT 里的 role 字符串它不读 ⇒ 这里给 "admin" 只是与库里那行保持一致的写法。
    let token = auth_jwt::create_token(BOARDQ_UID_ADMIN, "admin", 0);
    let app = test_app(db_app);

    // ① 分页的第一页：总数来自 COUNT、次序是"时间倒序 → id 倒序"。
    let (st, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}&page=1&page_size=2"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "留言管理列表不该在 HTTP 层失败：{j}");
    assert_eq!(
        j["code"], 200,
        "信封 code 必须是 200（走到这一步说明令牌经住了 auth_guard 与 auth_uid）：{j}"
    );
    assert_eq!(
        j["total"], 7,
        "「共 N 条」是**总条数**、不是本页条数——一页 2 条而总数 7 才是对的：{j}"
    );
    // 同秒多行 ⇒ 次序只能由 id 那一层定下来。少了它，PG 对并列行的次序不保证
    //（`ORDER BY` 只按键排，并列那些行的先后由执行计划决定），这一条会时绿时红，
    // 而翻页会重复/漏行。
    assert_eq!(
        board_ids(&j),
        vec![BOARDQ_ORPHAN, BOARDQ_UBYNICK3],
        "倒序 + 同秒按 id 倒排：{j}"
    );

    // ② 翻完所有页：**并集不重不漏**、每一页的 total 都等于 7。
    let mut seen: Vec<i32> = Vec::new();
    for p in 1..=4 {
        let (st, j) = call(
            app.clone(),
            "GET",
            &format!("/api/protect/board?q={BOARDQ_KW}&page={p}&page_size=2"),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(j["total"], 7, "每一页都该报同一个总数（第 {p} 页）：{j}");
        seen.extend(board_ids(&j));
    }
    assert_eq!(seen.len(), 7, "四页共 8 格、最后一页只有 1 条：{seen:?}");
    assert_eq!(
        sorted(seen),
        sorted(BOARDQ_HITS.to_vec()),
        "翻页并集必须**不多不少**：多了是 join 让行翻倍或负控混了进来，少了是丢行"
    );

    // ③ 翻过头的那一页：**空页照样带总数**（`total` 取自 COUNT、不是取 rows.length）。
    let (_, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}&page=5&page_size=2"),
        Some(&token),
        None,
    )
    .await;
    assert!(board_ids(&j).is_empty(), "第 5 页该是空的：{j}");
    assert_eq!(j["total"], 7, "空页的 total 仍是 7：{j}");

    // ④ `order=asc` 把整段反过来（旧在前）。同秒 ⇒ 恰好是 id 升序。
    let (_, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}&order=asc&page=1&page_size=200"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        board_ids(&j),
        sorted(BOARDQ_HITS.to_vec()),
        "`order=asc` 该是 id 升序（全部同秒）：{j}"
    );

    // ⑤ `cat` 与关键词**同时**生效（印章：愿 = E6 84 BF / 寄 = E5 AF 84，查询串里
    //    中文必须百分号编码）。两张精确集合把 `cat` 那一侧的谓词钉死。
    let (_, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}&cat=%E6%84%BF&page=1&page_size=200"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        j["total"], 6,
        "`cat=愿` 的命中是六条（诱饵那条是诉、留名那条是寄）：{j}"
    );
    assert_eq!(
        sorted(board_ids(&j)),
        sorted(vec![
            BOARDQ_BODY,
            BOARDQ_UBYNAME,
            BOARDQ_UBYNICK,
            BOARDQ_UBYNICK2,
            BOARDQ_UBYNICK3,
            BOARDQ_ORPHAN,
        ]),
        "`cat=愿` 的精确集合：{j}"
    );
    let (_, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}&cat=%E5%AF%84&page=1&page_size=200"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(board_ids(&j), vec![BOARDQ_SIGN], "`cat=寄` 只有留名那条：{j}");
    assert_eq!(j["total"], 1, "两组之和必须回到 7：{j}");

    // ⑥ `like_escape` 的 `%` 那一面。搜 `qqzzboardkw%`（查询串里 `%25`）时，未转义的
    //    模式 `%qqzzboardkw%%` 里那个 `%` 是**通配符**，会把七条全捞回来——**多取行**。
    //    （与 ⑩ 反斜杠那面"丢命中"的方向相反，所以那一条抓不住这一面。）
    let (_, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}%25&page=1&page_size=10"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        j["total"], 0,
        "搜 `{BOARDQ_KW}%` 该一条不中：夹具里没有哪个字段含字面的 `%`。\
         这里非 0 就是 like_escape 漏了（`%` 被当成了通配符）：{j}"
    );
    assert!(board_ids(&j).is_empty(), "{j}");

    // ⑦ `page` 只在给了 `page_size` 时生效；`page_size` 夹在 [1, 200]。
    let (_, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}&page=2"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        board_ids(&j).len(),
        7,
        "只给 page 不触发分页（否则第 2 页只剩 2 条，等于把整段截成半截）：{j}"
    );
    let (_, j) = call(
        app.clone(),
        "GET",
        &format!("/api/protect/board?q={BOARDQ_KW}&page=1&page_size=0"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        board_ids(&j).len(),
        1,
        "`page_size=0` 夹到 1（0 会让 `(page-1)*size` 与分页断言一起失效）：{j}"
    );
    assert_eq!(j["total"], 7, "{j}");

    // ⑧ 无参调用：与 20261014 之前**逐字节相同**——老调用方（agent 的三个工具、
    //    golden 夹具）按**数组**读 `data`。
    let (st, j) = call(app, "GET", "/api/protect/board", Some(&token), None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(
        j.get("total").is_none(),
        "不带参数时响应里**不许出现** `total` 键（`skip_serializing_if` 让它整个消失，
         老调用方里有按字段数看的）：{j}"
    );
    let all = board_ids(&j);
    // 这条接口不是按用户隔离的（管理员看的是全站留言），开发库上可能有真实行
    // ⇒ 只能断言**包含**，断言不了精确集合。
    for id in BOARDQ_HITS.into_iter().chain([BOARDQ_DECOY]) {
        assert!(
            all.contains(&id),
            "全量列表里少了 id={id}。孤儿行（发布者已不存在）尤其重要——\
             `LEFT JOIN` 写成 `INNER JOIN` 就是把它从管理员眼前静默摘掉：{j}"
        );
    }
    assert!(
        !all.contains(&BOARDQ_OTHER_SRC),
        "`src='talk'` 的说说不是留言，不许出现在留言管理里：{j}"
    );
}
