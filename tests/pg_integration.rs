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
//!   · 关键词要能命中**用户名/昵称**（在 `user` 表上）⇒ 查询带 `LEFT JOIN "user"`（PG 里
//!     `user` 是保留字，裸写等于 `current_user`）。LEFT 还是
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
//! ## 第五半（20261018）：聊天图片
//!
//! ⑬ `chat_image` 是**手写迁移**建的表（`0003_chat_image.sql`，不在 `0000_schema.sql` 里
//!   ——那一份是从 MySQL 的 `information_schema` 生成的，而图片从来没进过任何库）。
//!   三条判据各自钉一件只有真库能证明的事：
//!   · **往返逐字相等**：dataURL 进库出库一个字节都不能变（夹具的 base64 刻意含
//!     `+` `/` `=`）。走**真链路** `GET /api/chat/history`，因为查表只能证明"存进去了"、
//!     证明不了 `HistoryItem.images` 这一格接上了线；
//!   · **外键级联删**：删 `chat_history` 行 ⇒ 它的图跟着走。这是本表破例用 DB 外键的
//!     唯一理由（删 `chat_history` 的地方有 5 处，漏一处就是永久孤儿且没有任何东西会红）；
//!   · **`(message_id, seq)` 唯一键**挡重放——应用层"先查再插"中间那个窗口就是第二次写。
//!
//! ⑬ 的夹具也**必须**在 `ensure_schema` 的 `want` 名单里带上 `chat_image`：漏了它，
//! 失败会退化成一裸 SQL 报错（`relation "chat_image" does not exist`），
//! 看不出"这个库该建两份结构"这个前因后果。
//!
//! ⑦⑧ 起要签真令牌、走真路由：`create_router` + 真 JWT（`create_token` 自会读
//! `JWT_SECRET`，本文件自己把它设上）。夹具一律用 `9000000xx` 高位 id，且**按用户隔离**
//! ——⑦⑧ 只在 `CONV_UID` 名下建会话、⑨ 只在 `APPLY_UID` 名下建申请，
//! 所以"另一个用例留下的行"不会污染断言（⑥ 连用户都是自己的）。
//!
//! ## 本套件的会话时区是 **UTC**（判据别拿 `CURRENT_DATE` 当"今天"）
//!
//! 本套件用 sea-orm 默认连接创建隔离夹具，SQLx 会将会话设为 UTC。
//! 涉及日期的断言应使用夹具的明确日期或独占编号，避免依赖开发机时区。
//! 生产连接池在连接完成后设置站点时区，其默认时间戳由 `database_timezone.rs` 验证。
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
//! # 结构由**两份**脚本按序建：0000（库级，从 MySQL 生成）+ 编号迁移里进 CI 的那几份。
//! # 「哪几份进 CI」的唯一事实源是 scripts/migration/pg/ci_schema_files.py（它打印的就是
//! # 要按序喂给 psql 的清单，`--self-test` 保证磁盘上每个编号迁移都归过类）——
//! # 别在这里另抄一份文件名。
//! # ⚠️ 0000 头注里写死了库名 `saudade_blog`（脚本内有一句 `ALTER DATABASE "saudade_blog" …`）
//! # ——建一个另名的测库时，要么把那一句改成新库名，要么就按它头注那样把库也建成
//! # `saudade_blog`（那种情况务必用**独立实例**，别撞上生产库）。
//! psql -c "CREATE DATABASE saudade_it ENCODING 'UTF8'"
//! for f in $(python3 scripts/migration/pg/ci_schema_files.py); do
//!   psql -d saudade_it -v ON_ERROR_STOP=1 -f "$f" || exit 1
//! done
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
    TransactionTrait,
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
/// 会话搜索大小写那一条（⑧b）单独一个 uid：`make_user` 先删后插，共号会在并发跑时互删。
const CONV_CI_UID: i32 = 900000058;
// 聊天图片那一族（⑬）**三条用例各占一个 uid**：`cargo test` 默认多线程并发跑，
// 共用同一个 uid 的话 `make_user` 会互相删对方刚插的行 —— 症状是
// `duplicate key value violates unique constraint "user_pkey"`，
// 看着像夹具坏了、其实是并发（20261018 CI 首跑就是这么红的）。
const IMG_ROUNDTRIP_UID: i32 = 900000017;
const IMG_CASCADE_UID: i32 = 900000018;
const IMG_UNIQUE_UID: i32 = 900000019;
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
    //
    // ⚠️ `max_connections(1)` 是**算过账的**，不是随手填的小数（20261018）：
    //   · 本机 PG `max_connections = 30`，而**生产常驻就占掉约 10 个**（`saudade-rust` /
    //     `saudade-agent` 都连同一台）⇒ 本套件可用的只有二十来个；
    //   · `cargo test` 默认并发 = `nproc`（本机 **4**），而**每条用例开两个池**
    //     （`connect_pair`，`DatabaseConnection` 不是 `Clone`）⇒
    //     并发连接数 ≈ `2 × nproc × max_connections`。
    //   写 4 时是 `2 × 4 × 4 = 32 > 20`：**刚好压在边界上**，于是偶发
    //   `pool timed out while waiting for an open connection` —— 红起来像"这次改动
    //   把库弄坏了"，而根因与改动无关（20261018 实测复现：`--test-threads=32` 必红）。
    //   写 1 之后是 8，留足了余量。**用例里的查询全是顺序 await**（handler 里没有
    //   `join!` / `join_all`，`grep` 可验），所以一个池一条连接够用。
    opt.connect_timeout(Duration::from_secs(5)).max_connections(1);
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
    // `chat_image`（20261018）：**它不在 `0000_schema.sql` 里**——是 `0003_chat_image.sql`
    // 建的（手写迁移，见那个文件的头注）。加进这份名单有两个作用：① 它的用例失败时
    // 得到的是"库结构不全 + 怎么补"，不是一条裸 SQL 报错；② 顺带把"CI 只加载 0000"
    // 这个洞钉在明面上——清单见 `scripts/migration/pg/ci_schema_files.py`。
    // `note_tag`（20261018）：也是**手写迁移**建的（`0006_note_tag.sql`），理由同 `chat_image`。
    let want = [
        "note",
        "note_view",
        "note_like",
        "user_favorite",
        "note_comment",
        "note_tag",
        "user",
        "conversation",
        "chat_history",
        "chat_image",
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
        "库结构不全（要 {} 张表，只找到 {got} 张）。先建结构（**按序全跑**，缺哪份都补上）：\n\
         psql -d <库名> -v ON_ERROR_STOP=1 -f scripts/migration/pg/0000_schema.sql\n\
         psql -d <库名> -v ON_ERROR_STOP=1 -f scripts/migration/pg/0003_chat_image.sql\n\
         psql -d <库名> -v ON_ERROR_STOP=1 -f scripts/migration/pg/0004_note_visibility.sql\n\
         psql -d <库名> -v ON_ERROR_STOP=1 -f scripts/migration/pg/0005_orphan_cleanup.sql\n\
         psql -d <库名> -v ON_ERROR_STOP=1 -f scripts/migration/pg/0006_note_tag.sql\n\
         （清单的唯一事实源是 scripts/migration/pg/ci_schema_files.py —— CI 就按它建库）",
        want.len()
    );
}

/// 跑一条写语句（原生 SQL——这里要验的正是**真 SQL 的语义**，不走 entity 更贴近现场）。
async fn exec<C: ConnectionTrait>(db: &C, sql: &str) {
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
    exec(db, &format!("DELETE FROM \"user\" WHERE id = {id}")).await;
    exec(
        db,
        &format!(
            "INSERT INTO \"user\" (id, username, nickname, password, role) \
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
async fn one_i64<C: ConnectionTrait>(db: &C, sql: &str) -> Option<i64> {
    let row = db
        .query_one(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap_or_else(|e| panic!("SQL 失败：{e}\n  {sql}"))
        .expect("这道查询连一行都没回来");
    row.try_get_by_index(0).expect("这一列不是整数")
}

/// 同上，取一个 `int4` 标量（`id` / `chat_quota_used` 那一族——PG 侧它们是 `integer`，
/// 实体也是 `i32`）。分宽的理由见 [`one_i64`]。
async fn one_i32<C: ConnectionTrait>(db: &C, sql: &str) -> Option<i32> {
    let row = db
        .query_one(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap_or_else(|e| panic!("SQL 失败：{e}\n  {sql}"))
        .expect("这道查询连一行都没回来");
    row.try_get_by_index(0).expect("这一列不是整数")
}

/// 同上，取 TEXT/VARCHAR 列（可空）。
async fn one_text<C: ConnectionTrait>(db: &C, sql: &str) -> Option<String> {
    let row = db
        .query_one(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap_or_else(|e| panic!("SQL 失败：{e}\n  {sql}"))
        .expect("这道查询连一行都没回来");
    row.try_get_by_index::<Option<String>>(0).expect("这一列不是文本")
}

async fn count_of<C: ConnectionTrait>(db: &C, sql: &str) -> i64 {
    one_i64(db, sql).await.expect("COUNT(*) 不可能是 NULL")
}

/// 某个账号当前的额度计数器（`used_of` 的名字直说它读的是哪一列）。
async fn used_of(db: &DatabaseConnection, uid: i32) -> i32 {
    one_i32(
        db,
        &format!("SELECT chat_quota_used FROM \"user\" WHERE id = {uid}"),
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
    exec(&db, &format!("DELETE FROM \"user\" WHERE id = {UID}")).await;
    exec(
        &db,
        &format!(
            "INSERT INTO \"user\" (id, username, password) VALUES ({UID}, 'it_fixture_900000004', 'x')"
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
    exec(&db, &format!("DELETE FROM \"user\" WHERE id = {UID}")).await;
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
        &format!("UPDATE \"user\" SET chat_quota_used = 2 WHERE id = {QUOTA_UID}"),
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
        &format!("UPDATE \"user\" SET chat_quota_used = 0 WHERE id = {QUOTA_UID2}"),
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

// ── ⑧b 会话搜索的大小写（20261019）─────────────────────────────────────────────
//
// PG 的 `LIKE` **区分大小写**，而切流之前 MySQL 的排序规则是 `utf8mb4_0900_ai_ci`
// （大小写**不**敏感）⇒ 会话搜索在切流那天**静默变敏感**了。产线实测：`chat_history` 里
// `LIKE '%esp32%'` 命中 **0** 行、`ILIKE` 命中 **34** 行 —— 用户搜一个自己明明打过的词，
// 得到的是"没聊过"。
//
// ⚠️ 这一处与文章搜索**不同**：那边 SQL 只是**预筛**、真判定在内存里
// （`to_lowercase().contains`），这里**没有第二层** ⇒ `ILIKE` 就是这条搜索的**全部语义**。
// 所以判据只能是端到端的（真库 + 真请求），没有别的地方能证明它。
//
// 四条 `.ilike` 全钉在这一条用例里：会话列表的**标题**命中与**正文**命中（`?q=` 两处），
// 以及消息级搜索 `/api/chat/search`。

#[tokio::test]
async fn conversation_search_is_case_insensitive() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, CONV_CI_UID, "user").await;
    clear_conversations(&db, CONV_CI_UID).await;

    // ① 标题里写的是**大写** `ESP32`；② 标题无关、**正文**里是大写（走另一处谓词）
    let by_title = make_conversation(&db, CONV_CI_UID, Some("ESP32 固件笔记")).await;
    let by_body = make_conversation(&db, CONV_CI_UID, Some("无关标题")).await;
    add_msg(&db, CONV_CI_UID, by_body, "正文里也写 ESP32 大写").await;
    // 负控：**真不含**该词的会话。大小写不敏感不等于"什么都命中"。
    let clean = make_conversation(&db, CONV_CI_UID, Some("与关键词无关")).await;

    let app = test_app(db_app);
    let token = auth_jwt::create_token(CONV_CI_UID, "user", 0);

    let (st, j) = call(
        app.clone(),
        "GET",
        "/api/chat/conversations?q=esp32",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    let ids = conv_ids(&j);
    assert!(
        ids.contains(&by_title) && ids.contains(&by_body),
        "搜小写 `esp32` 必须命中**标题**里写 `ESP32` 与**正文**里写 `ESP32` 的两条会话。\
         少了谁就是那一处还在用区分大小写的 `LIKE`。拿到 {ids:?}"
    );
    assert!(
        !ids.contains(&clean),
        "不该命中的会话被捞进来了（大小写不敏感 ≠ 什么都命中）：{ids:?}"
    );

    // 消息级搜索走的是**另一处**谓词（`search_chat_messages`）
    let (st, j) = call(app, "GET", "/api/chat/search?q=esp32", Some(&token), None).await;
    assert_eq!(st, StatusCode::OK, "{j}");
    let hit_convs: Vec<i32> = j["hits"]
        .as_array()
        .unwrap_or_else(|| panic!("hits 不是数组：{j}"))
        .iter()
        .filter_map(|h| h["conversation_id"].as_i64().map(|v| v as i32))
        .collect();
    assert!(
        hit_convs.contains(&by_body),
        "消息级搜索同样要命中（这一处的 `LIKE` 与列表那两处是分开写的）：{j}"
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
        &format!("UPDATE \"user\" SET chat_quota_used = 7 WHERE id = {APPLY_UID}"),
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
        &format!("UPDATE \"user\" SET chat_quota_used = 5 WHERE id = {APPLY_UID}"),
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
// Keep this visibility fixture distinct from concurrent partial-match fixtures.
const AGG_KW: &str = "qqzzaggregatevisibility";

const AGG_NOTE_OK: i32 = 900000021; // 公开 + 已发布 + 标题命中 ⇒ 该出现
/// ⚠️ 这一行**原来是 `is_public=true` + `status='draft'`** —— 那正是「黑名单漏洞」的现场
/// （`status <> 'draft'` 是那半条唯一的守卫）。20261018 的 `note_status_visibility_ck`
/// 之后**这种行不可能存在**（CHECK 直接拒），所以夹具只能是 `is_public=false`。
/// **代价要说清楚**：这条现在是 `is_public` 那半的负控，**不再**独立检验状态谓词 ——
/// 约束在场时「公开 ⇒ 状态词是公开那一档」，`Status.is_in(...)` 那半在库内是**冗余**的。
/// 状态那半的判据只剩两处：⑭（约束本身）与 `frontend/tests/note-visibility.test.mjs`
/// （源码锁）。别把这条读成「状态谓词被验过了」。
const AGG_NOTE_DRAFT: i32 = 900000022; // is_public=0 + status='draft' ⇒ 不许出现
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

    // 三篇文章。**只有第一行该被搜到**；另外两行都是 `is_public=false` 的负控
    // （草稿那行见 `AGG_NOTE_DRAFT` 的头注：CHECK 之后"公开却是草稿"的行造不出来，
    // 所以这条**不再**独立检验状态谓词 —— 别读成两条谓词各有一条负控）。
    // 正文都刻意不含关键词 ⇒ 分数只来自标题（100），排序可预期。
    // `is_public` 在 PG 侧是**真 boolean**（`src/entity/note.rs` 里也是 `bool`）⇒ 写
    // `true`/`false`，写 `1`/`0` 会被 PG 拒绝。
    exec(
        &db,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status) VALUES \
             ({AGG_NOTE_OK},     '{AGG_KW} 可见文章', '正文里没有那个词', NOW(), NOW(), true,  'published'), \
             ({AGG_NOTE_DRAFT},  '{AGG_KW} 草稿',     '正文里没有那个词', NOW(), NOW(), false, 'draft'), \
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
    assert_eq!(b0["snippet"], format!("河灯正文里也有 {AGG_KW}"), "摘要该是正文（折平空白后）");
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
        exec(&db, &format!("DELETE FROM \"user\" WHERE id = {id}")).await;
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
            "INSERT INTO \"user\" (id, username, nickname, password, role) VALUES \
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

// ─────────────────────────────────────────────────────────────────────────────
// ⑫ 阅读上报的 upsert：同一天连报三次要**原地累加到 3**，而不是一行都写不进去
// ─────────────────────────────────────────────────────────────────────────────

/// 为什么这条判据要**读库里的真值**、而不是看接口的状态码：
/// `report_view` 的 Err 分支只 `tracing::warn!`（设计如此——统计失败不该让读者看不了
/// 正文），所以 upsert 写不进去时接口**照样回 200**。20261018 切库当天就是这么踩到的：
/// PG 的 `ON CONFLICT … DO UPDATE SET` 里裸写 `cnt` 是**歧义**的（目标行与 `excluded`
/// 都有这一列），PG 报 `column reference "cnt" is ambiguous`，而 MySQL 的
/// `ON DUPLICATE KEY UPDATE` 把裸名解析成既有行、不报错 ⇒ 阅读数静默不涨。
/// 接口是绿的、日志里只有一行 warn、前端只当"这次没数"。
///
/// ⚠️ 症状比"第二次起不涨"更重：PG 是**解析整条语句**时报的歧义，与走不走
/// `DO UPDATE` 那一支无关 ⇒ **第一次上报就没落库**（反控实测：把表名去掉，下面
/// 的 `COUNT(*)` 是 0 而不是 1）。所以这条用例的判据不能写成"第二次数了没"。
#[tokio::test]
async fn view_report_upserts_instead_of_violating_the_unique_key() {
    let Some((db, db_app)) = connect_pair().await else { return };
    const NOTE_VIEW_UPSERT: i32 = 900000005;
    make_note(&db, NOTE_VIEW_UPSERT).await;
    let app = test_app(db_app);

    // 同一天连报三次：第一次 INSERT，后两次走 `DO UPDATE`（`cnt` 必须原地 +1）
    for i in 1..=3 {
        let (st, _) = call(
            app.clone(),
            "POST",
            &format!("/api/public/notes/{NOTE_VIEW_UPSERT}/view"),
            None,
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "第 {i} 次上报的状态码");
    }

    // ⚠️ 判据里**不能拿 `CURRENT_DATE` 当"今天"**：sqlx-postgres 的会话时区是 **UTC**，
    // 而本仓的约定是"一律存本地 +08:00 钟面"（CLAUDE.md §4 时区约定），`report_view`
    // 写进去的是 `chrono::Local::now().date_naive()`。00:00–08:00 之间这两个**差一天**
    // ——实测 05:03 跑这条用例，连接上的 `CURRENT_DATE` 是 10-17、库里那一行是 10-18，
    // 于是这条判据会在"写入完全正确"的情况下红。夹具 id 是本用例独占的，按 note_id 取就够。
    let rows = count_of(
        &db,
        &format!("SELECT COUNT(*) FROM note_view WHERE note_id = {NOTE_VIEW_UPSERT}"),
    )
    .await;
    assert_eq!(rows, 1, "三次上报只该留一行（唯一键 (note_id, view_date) 的语义）");
    // ⚠️ `cnt` 是 `integer`（int4）⇒ 只能走 `one_i32`；用 `one_i64` 会当场报
    // `Rust type i64 … is not compatible with SQL type INT4`（分宽的理由见 `one_i64` 的注）
    let cnt = one_i32(
        &db,
        &format!("SELECT cnt FROM note_view WHERE note_id = {NOTE_VIEW_UPSERT}"),
    )
    .await
    .expect("note_view 里没有这一行——upsert 连 INSERT 那一步都没落下去");
    assert_eq!(
        cnt, 3,
        "三次上报要累加成 3。**读到 1 就是 upsert 写失败了**——接口当时回的是 200，\
         错误只进了 tracing::warn!（`src/routes/note_stats.rs::report_view`）"
    );
    // 顺手把"写进去的是**本地**日期"也钉住：这正是上一条注释里那个 UTC/本地差一天的
    // 事实来源，将来若有人把 `Set(today)` 换成 SQL 的 `CURRENT_DATE`，红在这里。
    let day = one_text(
        &db,
        &format!("SELECT view_date::text FROM note_view WHERE note_id = {NOTE_VIEW_UPSERT}"),
    )
    .await;
    let today = chrono::Local::now().date_naive().to_string();
    assert_eq!(
        day.as_deref(),
        Some(today.as_str()),
        "view_date 存的必须是本地钟面日期（与 `report_view` 的 `Local::now().date_naive()` 同源）"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑬ 聊天图片（20261018）：往返逐字相等 / 外键级联删 / (message_id, seq) 唯一
// ─────────────────────────────────────────────────────────────────────────────

/// 往一条消息上挂一张图（`seq` 是同一条消息内的次序）。**照抄 `prepare_chat` 的写法**
/// ——它落的也是完整 dataURL（含 `data:image/…;base64,` 前缀），不是裸 base64。
async fn add_img(db: &DatabaseConnection, mid: i32, seq: i16, data: &str) {
    // dataURL 里可能有单引号以外的任意字符；用 PG 的 dollar-quoting 兜住，
    // 免得夹具里的 `'` 把 SQL 撕开（本文件其余夹具都是 `format!` 拼串，没有绑定参数）。
    exec(
        db,
        &format!(
            "INSERT INTO chat_image (message_id, seq, data) VALUES ({mid}, {seq}, $img${data}$img$)"
        ),
    )
    .await;
}

/// 某条消息名下的图片张数。
async fn img_count(db: &DatabaseConnection, mid: i32) -> i64 {
    count_of(
        db,
        &format!("SELECT COUNT(*) FROM chat_image WHERE message_id = {mid}"),
    )
    .await
}

/// **dataURL 进库、出库必须逐字相等**——这是"图片落库"这件事唯一诚实的判据。
/// 夹具刻意选含 `+` `/` `=` 的 base64（这三类字符在 form-encoding / URL 转义 / 手工拼接
/// 里各是一个常见的坏点），任何一层把字节改掉，`assert_eq!` 当场红。
///
/// 走的是**真链路**（`GET /api/chat/history`）而不是直接查表：要验的正是
/// `HistoryItem.images` 这一格真的接上了线（查表只能证明"存进去了"，证明不了
/// "读得出来"——20261018 之前那半截 `mapDbItems` 白名单就是这种静默丢字段）。
#[tokio::test]
async fn chat_history_returns_images_byte_for_byte() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, IMG_ROUNDTRIP_UID, "user").await;
    clear_conversations(&db, IMG_ROUNDTRIP_UID).await;
    let cid = make_conversation(&db, IMG_ROUNDTRIP_UID, Some("带图的会话")).await;

    // `+` `/` `=` 各出现，末尾还有 `==`（base64 填充）
    const IMG_A: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg+/x==";
    const IMG_B: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ+AAA==";
    let with_imgs = add_msg(&db, IMG_ROUNDTRIP_UID, cid, "看看这两张\n[图片×2]").await;
    add_img(&db, with_imgs, 0, IMG_A).await;
    add_img(&db, with_imgs, 1, IMG_B).await;
    let plain = add_msg(&db, IMG_ROUNDTRIP_UID, cid, "这条没有图").await;

    let app = test_app(db_app);
    let token = auth_jwt::create_token(IMG_ROUNDTRIP_UID, "user", 0);
    let (st, j) = call(
        app,
        "GET",
        &format!("/api/chat/history?conversation_id={cid}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "带真令牌的历史请求不该 401/403：{j}");

    let items = j["items"].as_array().expect("items 必须是数组");
    assert_eq!(items.len(), 2, "两条消息都要在：{j}");
    // 历史是**时间升序**（阅读序）⇒ 先发的那条在前
    assert_eq!(items[0]["id"].as_i64(), Some(with_imgs as i64), "{j}");
    assert_eq!(items[1]["id"].as_i64(), Some(plain as i64), "{j}");

    let got: Vec<&str> = items[0]["images"]
        .as_array()
        .expect("images 必须是数组（缺键 / null 都说明这一格没接上线）")
        .iter()
        .map(|v| v.as_str().expect("images 的元素必须是字符串"))
        .collect();
    assert_eq!(
        got,
        vec![IMG_A, IMG_B],
        "dataURL 必须逐字相等、且按 seq 顺序。拿到 {got:?}"
    );

    // 没图的那条：**空数组，不是缺键、不是 null** —— 前端 `migrateItem` 认的是数组本身。
    let none = items[1]["images"]
        .as_array()
        .expect("没有图的消息也要给 `images: []`（缺键会让前端多一条降级路径）");
    assert!(none.is_empty(), "没有图的消息 images 该是空数组，拿到 {none:?}");
    assert_eq!(img_count(&db, plain).await, 0, "空数组要对应「库里真没有图」");
}

/// **外键级联删**——这是本表破例用 DB 外键（而不是照 chat 家族惯例走应用层级联）的
/// **唯一理由**：删 `chat_history` 的地方有 5 处（`discard_handler` / 每会话 500 条删头 /
/// `DiscardAbortedExchange::drop` / `delete_conversation` / 删临时账号），漏一处就是
/// 图片**永久孤儿**，而且**没有任何东西会红**。
///
/// 所以这条判据必须验"删消息 ⇒ 图跟着没了"，而不是"删消息的代码里也写了删图"——
/// 后者只是把 5 处人工同步又抄了一遍。
#[tokio::test]
async fn deleting_a_message_cascades_to_its_images() {
    let Some((db, _db_app)) = connect_pair().await else { return };
    make_user(&db, IMG_CASCADE_UID, "user").await;
    clear_conversations(&db, IMG_CASCADE_UID).await;
    let cid = make_conversation(&db, IMG_CASCADE_UID, Some("级联")).await;
    let mid = add_msg(&db, IMG_CASCADE_UID, cid, "两张\n[图片×2]").await;
    add_img(&db, mid, 0, "data:image/png;base64,AAA").await;
    add_img(&db, mid, 1, "data:image/png;base64,BBB").await;
    assert_eq!(img_count(&db, mid).await, 2, "前提：两张图确实插进去了");

    exec(&db, &format!("DELETE FROM chat_history WHERE id = {mid}")).await;

    assert_eq!(
        img_count(&db, mid).await,
        0,
        "删掉消息之后它的图必须跟着走。**留着一行就是永久孤儿**——读路径只按\
         `message_id IN (最近 50 条的 id)` 取图，那条消息再也不会被读到，而它占的字节\
         会一直留在库里，没有任何东西会红。外键（`fk_chat_image_msg` ON DELETE CASCADE）\
         就是为这一条存在的。"
    );
}

/// `(message_id, seq)` 唯一键：重放 / 双标签页重复提交**挡在库这一层**。
/// 应用层去重做不到这件事——两个并发请求各自查一次"有没有"再各自插，中间那个窗口
/// 就是第二次写（同族事故见 `quota::try_consume` 的头注）。
#[tokio::test]
async fn chat_image_unique_key_blocks_a_replayed_seq() {
    let Some((db, _db_app)) = connect_pair().await else { return };
    make_user(&db, IMG_UNIQUE_UID, "user").await;
    clear_conversations(&db, IMG_UNIQUE_UID).await;
    let cid = make_conversation(&db, IMG_UNIQUE_UID, Some("唯一键")).await;
    let mid = add_msg(&db, IMG_UNIQUE_UID, cid, "一张\n[图片]").await;
    add_img(&db, mid, 0, "data:image/png;base64,AAA").await;

    let dup = db
        .execute(Statement::from_string(
            DbBackend::Postgres,
            format!(
                "INSERT INTO chat_image (message_id, seq, data) \
                 VALUES ({mid}, 0, 'data:image/png;base64,BBB')"
            ),
        ))
        .await;
    let err = dup.expect_err("同一个 (message_id, seq) 插第二次必须被唯一键挡住");
    // ⚠️ 只断言"报错了"是**空真**：表不存在、列名写错、外键指向不存在的消息……
    // 任何一种都报错。把约束名钉住，红的才是唯一键这一件事。
    let msg = err.to_string();
    assert!(
        msg.contains("chat_image_uk_msg_seq"),
        "报错必须来自那个唯一索引（拿到的是：{msg}）"
    );
    assert_eq!(img_count(&db, mid).await, 1, "被挡住之后不该多出一行");
    // 换一个 seq 是**另一张图**，必须插得进（别把唯一键写成"一条消息只许一张图"）
    add_img(&db, mid, 1, "data:image/png;base64,BBB").await;
    assert_eq!(img_count(&db, mid).await, 2, "seq 不同就是不同的图");
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑭ 可见性不变量（20261018）：`note_status_visibility_ck`
// ─────────────────────────────────────────────────────────────────────────────
//
// 治的是"两个字段描述同一件事、而守卫是黑名单"：`status <> 'draft'` 会把**没见过的词**
// 和 NULL 一起放过去，而 `update_note` 那条只带 `{"is_public":true}` 的写能造出
// `('private', true)` —— 这种行**会被公开列出**。应用侧那一半（白名单谓词 + 写侧拒收未知词）
// 在 `src/routes/notes.rs`，本节的这几条钉的是**库自己**不再允许那种组合存在。
//
// ⚠️ 只断言"约束存在"是**空真**（存在也可能写成恒真）。必须**种违规行**看它是不是真被拒 ——
// 下面每一条都是"先试违规、再试合法"，两边都要有。

/// ⑭ 占的是一**段** id：`VIS_NOTE_BASE + 0..6`（三条被拒的 + 三条该落库的）。段长登记在
/// `ID_BLOCKS` 里，⑰ 会拦"别的点常量落进这一段"。
const VIS_NOTE_BASE: i32 = 900000051;

/// 约束在不在。不在就给出"该跑哪份迁移"的提示 —— 否则失败会退化成一条裸 SQL 报错
/// （"new row … violates check constraint"根本不会出现，因为约束压根不在），
/// 看不出"这个库还差一份迁移"这个前因后果。
async fn constraint_exists(db: &DatabaseConnection, name: &str, table: &str) -> bool {
    one_i64(
        db,
        &format!(
            "SELECT COUNT(*) FROM pg_constraint \
             WHERE conname = '{name}' AND conrelid = '{table}'::regclass AND contype = 'c'"
        ),
    )
    .await
    .unwrap_or(0)
        > 0
}

/// 跑一条**预期失败**的语句，回错误文本；成功则回 `None`。
///
/// 每条都走 autocommit（不开事务）：一条被拒会把事务标脏，后面的语句全被
/// `current transaction is aborted` 顶掉，红的原因就变成了"事务脏了"而不是"约束没拦住"。
async fn exec_err(db: &DatabaseConnection, sql: &str) -> Option<String> {
    db.execute(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .err()
        .map(|e| e.to_string())
}

/// 种一行 `note`（只给约束关心的那两列 + 必填列）。
fn note_sql(id: i32, is_public: bool, status: Option<&str>) -> String {
    let st = match status {
        Some(s) => format!("'{s}'"),
        None => "NULL".to_string(),
    };
    format!(
        "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status) \
         VALUES ({id}, '可见性夹具', 'x', NOW(), NOW(), {is_public}, {st})"
    )
}

#[tokio::test]
async fn note_status_visibility_check_rejects_and_accepts() {
    let Some((db, _app)) = connect_pair().await else { return };
    assert!(
        constraint_exists(&db, "note_status_visibility_ck", "note").await,
        "库上没有 `note_status_visibility_ck` —— 先跑 scripts/migration/pg/0004_note_visibility.sql。\
         CI 的建库清单唯一事实源是 scripts/migration/pg/ci_schema_files.py（漏了它，CI 上这条判据\
         会红在「库结构不全」这种与代码无关的原因上）。"
    );
    for i in 0..6 {
        exec(&db, &format!("DELETE FROM note WHERE id = {}", VIS_NOTE_BASE + i)).await;
    }

    // ── 负控三条：都必须被拒 ──────────────────────────────────────────────
    // ① 今天真能造出来的那一条（`update_note` 只带 {"is_public":true}）。
    let e = exec_err(&db, &note_sql(VIS_NOTE_BASE, true, Some("private")))
        .await
        .expect("('private', true) 必须被拒 —— 这正是「公开列表会把它列出来」的那一行");
    assert!(
        e.contains("note_status_visibility_ck"),
        "报错必须来自那条约束（拿到的是：{e}）"
    );
    // ② NULL 词。`IS NOT NULL` 写在 CHECK 里是**真的会拒**的（求值 FALSE 而不是 UNKNOWN）
    //    —— 这条就是"没动列元数据也拿到了不变量"的判据。
    let e = exec_err(&db, &note_sql(VIS_NOTE_BASE + 1, true, None))
        .await
        .expect("(NULL, true) 必须被拒（CHECK 里的 IS NOT NULL）");
    assert!(e.contains("note_status_visibility_ck"), "{e}");
    // ③ 没见过的词。黑名单时代它会被**放行**（不在排除名单里），白名单时代必须拦。
    let e = exec_err(&db, &note_sql(VIS_NOTE_BASE + 2, true, Some("archived")))
        .await
        .expect("未知状态词必须被拒 —— 黑名单时代的漏洞就是它");
    assert!(e.contains("note_status_visibility_ck"), "{e}");

    // ── 正控三条：都必须被接受（只测"会拦"就变成了"把合法的也拦掉"也绿）──────
    // ④ `('published', false)`：显式隐藏。`published` 是兼容别名（列缺省就是它），
    //    而"公开词 + is_public=false"是**合法**状态 —— 约束不能把它一起禁掉。
    exec(&db, &note_sql(VIS_NOTE_BASE + 3, false, Some("published"))).await;
    // ⑤ `('public', true)`：常态。
    exec(&db, &note_sql(VIS_NOTE_BASE + 4, true, Some("public"))).await;
    // ⑥ **不带 status**（走列缺省 `'published'`）：集成测夹具与任何 status-less INSERT
    //    都靠这条 —— 禁掉 `published` 会让一大堆既有夹具红。
    exec(
        &db,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public) \
             VALUES ({}, '可见性夹具', 'x', NOW(), NOW(), true)",
            VIS_NOTE_BASE + 5
        ),
    )
    .await;

    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM note WHERE id BETWEEN {VIS_NOTE_BASE} AND {}", VIS_NOTE_BASE + 5)
        )
        .await,
        3,
        "负控三条一条都不该落库，正控三条都该在"
    );
    for i in 0..6 {
        exec(&db, &format!("DELETE FROM note WHERE id = {}", VIS_NOTE_BASE + i)).await;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑮ `update_note` 的可见性推导（20261018）：显式要公开而状态词不公开 ⇒ 拒收且不改行
// ─────────────────────────────────────────────────────────────────────────────
//
// 这是"黑名单漏洞"的**入口**：从前 `update_note` 是"派生 → 允许显式覆盖 → 再补一次"，
// 只带 `{"is_public":true}` 打在一条 `status='private'` 的行上，第二次覆盖把 is_public 置回
// true 而 status 一个字节没动 ⇒ 库里落下 `('private', true)`。
//
// ⚠️ 只跑 mock 是**空真**（MockDatabase 不解码行，也走不到真实推导）；这里走真链路 + 真库，
// 并且**断言那一行没被改动** —— "报错了但已经写进去了"是这类修复最常见的假绿。

/// ⚠️ **`_UID` 与 `_NOTE` 各占一个号，且都不许落进别的用例的 id 段里。**
/// 900000052 曾经同时被这里（`UPD_VIS_UID`）与 `BOARDQ_UID_B` 用着 —— 两个用例并发跑，
/// `make_user`（先 DELETE 再 INSERT）会把对方正在用的那一行抽走。`UPD_VIS_NOTE` 更不能
/// 取 900000052：那是 ⑭ 的 `VIS_NOTE_BASE + 1`，⑭ 收尾时会把它整段删掉。
/// 两条都由 ⑰ 静态查（点对点 + 点对段），别只靠这句注释。
const UPD_VIS_UID: i32 = 900000055;
const UPD_VIS_NOTE: i32 = 900000057;

#[tokio::test]
async fn update_note_refuses_public_flag_on_non_public_status() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, UPD_VIS_UID, "admin").await;
    exec(&db, &format!("DELETE FROM note WHERE id = {UPD_VIS_NOTE}")).await;
    exec(&db, &note_sql(UPD_VIS_NOTE, false, Some("private"))).await;

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(UPD_VIS_UID, "admin", 0);

    // ⚠️ 键名是 **`is_public`**（下划线），不是 `isPublic`：`UpsertNoteRequest.is_public` 是
    // 全结构体里**唯一一个没有 serde rename 的字段**（`noteTitle` / `isTop` / `noteTags` 那些
    // 都有）。写成 `isPublic` 会被 serde 静默忽略 ⇒ 这一笔变成"什么都没改"的空请求，
    // 三条断言全绿而**判据根本没在测那条路**。`frontend/src/interface/NoteType.d.ts:25`
    // 记着同一件事（那边是 DTO 侧）。
    //
    // ① 显式公开 + 状态词是 private ⇒ 必须被拒，且那一行**一个字节都不能动**。
    let (st, j) = call(
        app.clone(),
        "POST",
        &format!("/api/protected/notes/{UPD_VIS_NOTE}"),
        Some(&admin),
        Some(r#"{"is_public": true}"#),
    )
    .await;
    // ⚠️ 信封是 `ApiResponse { code, message, data }`（`src/utils.rs:7`）—— **没有 `success`
    // 字段**。业务失败 = **HTTP 仍 200 + 信封里 `code=500`**。我第一版四条断言全按
    // `j["success"]` 写，CI 上四条一起红（`as_bool()` 在缺键上是 `None`）。
    assert_eq!(st, StatusCode::OK, "业务失败也是 HTTP 200，靠信封说话：{j}");
    assert_eq!(j["code"], 500, "必须如实报错：{j}");
    let (status_after, public_after) = one_text(
        &db,
        &format!("SELECT status || '|' || is_public::text FROM note WHERE id = {UPD_VIS_NOTE}"),
    )
    .await
    .map(|s| s.split_once('|').map(|(a, b)| (a.to_string(), b.to_string())).unwrap())
    .expect("夹具行不见了");
    assert_eq!(
        (status_after.as_str(), public_after.as_str()),
        ("private", "false"),
        "被拒的那一笔不许把行改掉（报错了但已经写进去 = 这类修复最常见的假绿）"
    );

    // ② 同时给状态词（合法的那一个）⇒ 应当成功，且落库的是**归一后**的词。
    let (st, j) = call(
        app.clone(),
        "POST",
        &format!("/api/protected/notes/{UPD_VIS_NOTE}"),
        Some(&admin),
        Some(r#"{"status": "published", "is_public": true}"#),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "状态词给对了就该成功：{j}");
    assert_eq!(
        one_text(&db, &format!("SELECT status FROM note WHERE id = {UPD_VIS_NOTE}")).await.as_deref(),
        Some("public"),
        "`published` 是兼容别名，落库必须归一成 `public`（库里只该有一个「公开」词）"
    );

    // ③ 未知状态词 ⇒ 拒收，**不许原样写库**（原样写库正是"库里出现没见过的词、
    //    而黑名单时代它照旧被公开列出"的来路）。
    let (st, j) = call(
        app,
        "POST",
        &format!("/api/protected/notes/{UPD_VIS_NOTE}"),
        Some(&admin),
        Some(r#"{"status": "archived"}"#),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 500, "未知状态词必须拒收：{j}");
    assert_eq!(
        one_text(&db, &format!("SELECT status FROM note WHERE id = {UPD_VIS_NOTE}")).await.as_deref(),
        Some("public"),
        "被拒的未知词不许落库"
    );

    exec(&db, &format!("DELETE FROM note WHERE id = {UPD_VIS_NOTE}")).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑯ 删临时账号 ⇒ 六张会话相关表该 uid 的行全空（20261018）
// ─────────────────────────────────────────────────────────────────────────────
//
// **这条判据在收口之前是红的**：`delete_temp_user` 只手写了三张表
// （`chat_history` / `chat_summary` / `conversation`），而 `delete_conversation` 删五张
// —— 漏掉的 `execution_log` / `pending_action` / `agent_task` 在账号删除后全部成为孤儿，
// 三张表都按 `conversation_id` 读 ⇒ 会话没了就再也没有任何读取路径，**也没有任何东西会红**。
//
// ⚠️ 这条是本节**唯一**能证明"清单是全的"的判据：配套的
// `frontend/tests/chat-cascade-single-source.test.mjs` 只证明"清单只有一份"，
// 一份漏了某张表的唯一清单照样能让它全绿。两者必须配对。
//
// 夹具**真的往六张表里都种行** —— 空表上跑删除恒绿，那是本仓最忌讳的空真。

const CASCADE_UID: i32 = 900000053;
/// 发起删除的那个管理员。**必须自己占一个 uid**：`ADMIN_UID`（900000014）被额度那条用例
/// 用着，而 `make_user` 是先 DELETE 再 INSERT —— 共用一个 uid 时两边会互相把对方刚插的行
/// 抽走，症状是随机红且只在并发时出现（20261018 CI 首跑踩过一次，见 IMG_* 那一族的注释）。
const CASCADE_ADMIN_UID: i32 = 900000054;

#[tokio::test]
async fn deleting_a_temp_user_purges_all_six_chat_tables() {
    let Some((db, db_app)) = connect_pair().await else { return };
    // 发起人得是管理员（`/api/temp-users/*` 那一组在 auth_guard 后面），被删的那个是普通用户。
    make_user(&db, CASCADE_ADMIN_UID, "admin").await;
    make_user(&db, CASCADE_UID, "user").await;
    clear_conversations(&db, CASCADE_UID).await;

    let cid = make_conversation(&db, CASCADE_UID, Some("级联夹具")).await;
    add_msg(&db, CASCADE_UID, cid, "一条消息").await;
    exec(
        &db,
        &format!(
            "INSERT INTO chat_summary (user_id, conversation_id, summary, message_count, updated_at) \
             VALUES ({CASCADE_UID}, {cid}, '摘要', 1, NOW())"
        ),
    )
    .await;
    exec(
        &db,
        &format!(
            "INSERT INTO execution_log (user_id, conversation_id, skill, detail, created_at) \
             VALUES ({CASCADE_UID}, {cid}, 'navigate', '跳转「/」', NOW())"
        ),
    )
    .await;
    exec(
        &db,
        &format!(
            "INSERT INTO pending_action (conversation_id, user_id, task_id, skill, tool, created_at) \
             VALUES ({cid}, {CASCADE_UID}, 'task-1', 'navigate', 'navigate_to', NOW())"
        ),
    )
    .await;
    exec(
        &db,
        &format!(
            "INSERT INTO agent_task (conversation_id, user_id, task_id, state, created_at, updated_at) \
             VALUES ({cid}, {CASCADE_UID}, 'task-1', 'submitted', NOW(), NOW())"
        ),
    )
    .await;

    // 先确认夹具真种进去了 —— 否则下面的"全 0"是空真（表里本来就没行）。
    let seeded = count_of(
        &db,
        &format!(
            "SELECT (SELECT COUNT(*) FROM chat_history WHERE user_id = {CASCADE_UID}) \
                  + (SELECT COUNT(*) FROM chat_summary WHERE user_id = {CASCADE_UID}) \
                  + (SELECT COUNT(*) FROM execution_log WHERE user_id = {CASCADE_UID}) \
                  + (SELECT COUNT(*) FROM pending_action WHERE user_id = {CASCADE_UID}) \
                  + (SELECT COUNT(*) FROM agent_task WHERE user_id = {CASCADE_UID}) \
                  + (SELECT COUNT(*) FROM conversation WHERE user_id = {CASCADE_UID})"
        ),
    )
    .await;
    assert_eq!(seeded, 6, "夹具六张表各该有一行，实际 {seeded} 行（没种进去 ⇒ 下面全 0 是空真）");

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(CASCADE_ADMIN_UID, "admin", 0);
    let (st, j) = call(app, "DELETE", &format!("/api/temp-users/{CASCADE_UID}"), Some(&admin), None).await;
    assert_eq!(st, StatusCode::OK, "删账号请求该成功：{j}");
    assert_eq!(j["code"], 200, "{j}");

    for (label, sql) in [
        ("chat_history", format!("SELECT COUNT(*) FROM chat_history WHERE user_id = {CASCADE_UID}")),
        ("chat_summary", format!("SELECT COUNT(*) FROM chat_summary WHERE user_id = {CASCADE_UID}")),
        ("execution_log", format!("SELECT COUNT(*) FROM execution_log WHERE user_id = {CASCADE_UID}")),
        ("pending_action", format!("SELECT COUNT(*) FROM pending_action WHERE user_id = {CASCADE_UID}")),
        ("agent_task", format!("SELECT COUNT(*) FROM agent_task WHERE user_id = {CASCADE_UID}")),
        ("conversation", format!("SELECT COUNT(*) FROM conversation WHERE user_id = {CASCADE_UID}")),
    ] {
        assert_eq!(
            count_of(&db, &sql).await,
            0,
            "删账号之后 `{label}` 还留着这个 uid 的行 —— 会话没了就没有任何读取路径会碰到它，\
             也没有别的东西会红（20261018 之前 `delete_temp_user` 只清三张表）"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑰ 夹具 uid 不许重复（20261018）
// ─────────────────────────────────────────────────────────────────────────────
//
// `cargo test` 默认**多线程并发**跑。两个用例共用一个 uid 时，`make_user`（先 DELETE 再
// INSERT）会把对方正在用的那一行抽走 —— 症状是**随机红**，且只在并发时出现。
// 20261018 CI 首跑就是这么红的：三条新用例共用一个 uid，报的是
// `duplicate key value violates unique constraint "user_pkey"`，看着像夹具坏了、
// 其实是并发，**本机 `cargo check` 全绿**（这是最难自己发现的一类）。
//
// 所以把"每个用例一个 uid"从注释里的一条约定，变成一条会红的判据：扫**自己的源码**，
// 每个 `const …_UID: i32 = N;` 的 N 都必须唯一。
//
// ⚠️ 射程说明（20261018 扩过一次）：覆盖 `_UID` 那一族（都往同一张 `user` 表里插）、
// `_NOTE` 那一族（都往 `note` 表里插），以及 `TAGONE` / `TAGTWO` 那一族（⑲ 的标签夹具，
// 分别往两张标签表里插）。`NOTE_SUM` / `AGG_NOTE_OK` 那些**不**在这个射程里 —— 它们不按
// 那几种命名，扫不出干净的一组，那半边仍然只靠注释里的约定。
//
// 除了点对点查重，还要**点对段**：有的用例一次占一段 id（`VIS_NOTE_BASE` 那 6 个），
// 别的点常量落进去一样是并发互删。段登记在 `ID_BLOCKS` 里（只写名字与段长，起始值从
// 源码里现取 —— 写死值就又是一份会漂的手抄表）。
//
// ⚠️ **对账必须在同一张表里做**：`user` / `note` / `tag_one` / `tag_two` 的 id 是四条
// 独立序列，同号完全合法（`BOARDQ_UID_A = 900000051` 与 `VIS_NOTE_BASE = 900000051`
// 就是这样，不是冲突；⑲ 的撞号夹具更是**刻意**同号）。
// 表由**名字里的那个词**认（见 `fixture_ns`）。
const ID_BLOCKS: &[(&str, i32)] = &[("VIS_NOTE_BASE", 6)];

/// 名字里的那个词就是它的表。见上面那段 ⚠️。
///
/// ⚠️ 判断顺序有讲究：先 `UID`，再 `TAGONE` / `TAGTWO`，最后 `NOTE`。`TAGONE` 不是
/// `TAGTWO` 的子串，两者也不与 `NOTE` 互相包含 —— 但**将来加词时要注意**：
/// 一个叫 `TAGONE_NOTE` 的常量会落进 `tag_one`（先判到的那个），而它按命名读起来像是
/// `note` 的。给夹具起名时让后缀只有一个意思。
fn fixture_ns(name: &str) -> &'static str {
    for (token, ns) in [
        ("UID", "user"),
        ("TAGONE", "tag_one"),
        ("TAGTWO", "tag_two"),
        ("NOTE", "note"),
    ] {
        if name.contains(token) {
            return ns;
        }
    }
    "note"
}

#[test]
fn fixture_uids_are_unique() {
    let src = include_str!("pg_integration.rs");
    let mut all: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
    for line in src.lines() {
        let line = line.trim();
        if !line.starts_with("const ") {
            continue;
        }
        let Some((lhs, rhs)) = line.split_once(':') else { continue };
        let name = lhs.trim_start_matches("const ").trim().to_string();
        let Some(value) = rhs.split('=').nth(1) else { continue };
        // ⚠️ 先砍**行尾注释**再解析。此前只砍 `;` —— 而 `const AGG_NOTE_OK: i32 = 900000021; // …`
        // 砍完还带着 `; // …`，parse 失败 ⇒ 整条被 `continue` 静默跳过。本文件 45 条 i32 常量里
        // 有 24 条带注释，**这个 guard 当时只扫到 21 条**，而它看起来跟全扫一模一样。
        let value = value.split("//").next().unwrap_or("").trim();
        let value = value.trim_end_matches(';').trim();
        if let Some(n) = value.parse::<i32>().ok() {
            all.insert(name, n);
        }
    }

    // 判据自己的正控：**一条都不许被静默跳过**。上面那个洞就是"少扫了一层而看不出来"，
    // 所以这里不比一个手抄的阈值，而是拿"源码里有几行 `const …: i32 = …`"当分母 ——
    // 少解析一条就红。（`ID_BLOCKS` 那种 `&[(&str, i32)]` 的常量不含 `: i32 = `，不在分母里。）
    let expected = src
        .lines()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("const ") && t.contains(": i32 = ")
        })
        .count();
    assert_eq!(
        all.len(),
        expected,
        "有 `const …: i32 = …` 没被解析出来（判据自己漏了射程 —— 十有八九是行尾注释没砍干净）"
    );

    // 点常量：一个常量 = 一个 id。
    // 射程 = 名字里带 `_UID`（user）、带 `TAGONE` / `TAGTWO`（两张标签表）、或以 `_NOTE`
    // 结尾（note）。`NOTE_SUM` / `AGG_NOTE_OK` 那些**仍然不在**射程里（不以后缀命名，
    // 扫不出干净的一组）—— 那半边只有注释里的约定。
    let points: Vec<(String, i32)> = all
        .iter()
        .filter(|(n, _)| {
            n.contains("_UID") || n.contains("TAGONE") || n.contains("TAGTWO") || n.ends_with("_NOTE")
        })
        .map(|(n, v)| (n.clone(), *v))
        .collect();
    // 判据自己的正控（射程那一半）：⑲ 的标签夹具常量必须**真的被扫进来**。
    // 少了这一条，"射程没扩上"与"扩上了且没有冲突"在输出上**一模一样**。
    let tag_points = points
        .iter()
        .filter(|(n, _)| matches!(fixture_ns(n), "tag_one" | "tag_two"))
        .count();
    assert!(
        tag_points >= 4,
        "⑲ 的标签夹具常量一个都没被扫到（`points` 的过滤条件没跟着 `fixture_ns` 扩？）：{tag_points}"
    );

    let mut seen: std::collections::HashMap<(&str, i32), String> = std::collections::HashMap::new();
    for (name, n) in &points {
        if let Some(prev) = seen.insert((fixture_ns(name), *n), name.clone()) {
            panic!(
                "夹具 id {n} 被 `{prev}` 与 `{name}` 共用（同一张表）—— 并发跑时 `make_user` /\
                 建行会互相删行，症状是随机红（见本条注释）。给其中一个换一个没人用的号。"
            );
        }
    }

    // 段常量：一个常量 = 连续一段 id。起始值从 `all` 现取（改名 ⇒ 这里先红，不是静默少一层射程）。
    for (bname, len) in ID_BLOCKS {
        let Some(start) = all.get(*bname) else {
            panic!("`ID_BLOCKS` 登记了 `{bname}`，但源码里没有这个 `const` —— 改名了就一起改");
        };
        for (name, n) in &points {
            if fixture_ns(name) != fixture_ns(bname) {
                continue;
            }
            if *n >= *start && *n < start + len {
                panic!(
                    "夹具 id {n}（`{name}`）落在 `{bname}` 占的 [{start}, {}) 里 —— 那个用例\
                     收尾时会整段删掉，两个用例并发跑 ⇒ 随机红。给 `{name}` 换一个段外的号。",
                    start + len
                );
            }
        }
    }

    assert!(
        seen.len() >= 10,
        "一条 `_UID` / `_NOTE` 常量都没扫到（判据自己坏了，别当成通过）：{}",
        seen.len()
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑱ 公开文章列表读得出来（20261018 事故的回归锁）
// ─────────────────────────────────────────────────────────────────────────────
//
// 现场：三个列表端点原来写的是
// `find_also_related(category::Entity).into_partial_model::<NoteSummary, CategoryPartial>()`
// —— **每一行都映射失败**。`SelectTwo::into_partial_model` 的第一步是
// `QuerySelect::select_only(self)`，而 `SelectTwoModel` 读行时按 `A_` / `B_` 前缀取列
// （`from_query_result(res, "A_")`），那两个前缀**正是 `find_also_related` 写进 select
// 列表的别名**（`apply_alias`）—— 被 `select_only` 清掉之后就再也对不上。
// 而三个调用点都是 `.unwrap_or(vec![])` ⇒ **公网文章列表静默变空**：接口照旧 200、
// 日志一个字都没有、本机 `cargo check` 全绿。这条判据钉的就是"列表里必须有自己刚种的那一篇"。
//
// ⚠️ **必须按自己的 id 找**：生产/CI 库里本来就有一批公开文章，只断言"data 非空"
// 会被它们蒙混过去 —— 那样这条判据在事故当下**照样是绿的**。
//
// 配套的源码锁 `不许用_select_two_那版_partial_model` 管"别再写回去"；
// 这一条管"写回去了会红"。两条配对，缺一条都不够。
const LIST_NOTE: i32 = 900000058;
/// 夹具分类。`category` 与 `note` 的 id 是两个独立序列，取同号无妨（⑰ 按表对账）。
const LIST_CAT: i32 = 900000058;

#[tokio::test]
async fn 公开文章列表里找得到自己刚种的那一篇() {
    let Some((db, db_app)) = connect_pair().await else { return };
    exec(&db, &format!("DELETE FROM note WHERE id = {LIST_NOTE}")).await;
    exec(&db, &format!("DELETE FROM category WHERE id = {LIST_CAT}")).await;
    exec(
        &db,
        &format!("INSERT INTO category (id, name) VALUES ({LIST_CAT}, '列表夹具分类')"),
    )
    .await;
    exec(
        &db,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status, category_id) \
             VALUES ({LIST_NOTE}, '公开列表夹具', '正文不该出现在列表里', NOW(), NOW(), true, 'public', {LIST_CAT})"
        ),
    )
    .await;

    let app = test_app(db_app);
    let (st, j) = call(app, "GET", "/api/public/notes?page=1&page_size=1000", None, None).await;
    assert_eq!(st, StatusCode::OK, "{j}");
    let rows = j["data"]
        .as_array()
        .unwrap_or_else(|| panic!("data 不是数组：{j}"));
    let mine = rows
        .iter()
        .find(|r| r["noteKey"].as_i64() == Some(LIST_NOTE as i64))
        .unwrap_or_else(|| {
            panic!(
                "自己刚种的那篇公开文章不在公开列表里（共 {} 行）—— 这正是 20261018 的事故形状：\
                 每一行都映射失败，而 `.unwrap_or(vec![])` 把它变成「列表本来就是空的」。{j}",
                rows.len()
            )
        });
    // 列表**不给正文**（`map_note_summary` 本来就把两个正文键置空）—— 这条同时钉住
    // "partial model 只摘了 content、没有把别的列一起摘掉"。
    assert_eq!(mine["noteContent"].as_str(), Some(""), "列表不给正文：{j}");
    assert_eq!(mine["content"].as_str(), Some(""), "列表不给正文（另一个键）：{j}");
    assert_eq!(
        mine["noteTitle"].as_str(),
        Some("公开列表夹具"),
        "标题必须真的读出来了（只摘 content、不摘别的列）：{j}"
    );
    // 分类名走 `category_names` 那一次单独查询 —— 新代码，同样要有人看着。
    assert_eq!(
        mine["categoryTitle"].as_str(),
        Some("列表夹具分类"),
        "分类名要挂上（分类从 LEFT JOIN 改成单独一次查询了）：{j}"
    );

    exec(&db, &format!("DELETE FROM note WHERE id = {LIST_NOTE}")).await;
    exec(&db, &format!("DELETE FROM category WHERE id = {LIST_CAT}")).await;
}

/// 剥掉行注释与块注释（**跳过字符串字面量**）。
///
/// 判据读的是**代码**，不是注释。本仓的注释里到处在**举例**写那些被禁的写法 ——
/// 这一版第一次跑就栽在这：`notes.rs` 的头注逐字写着那条被禁的组合，锁当场把自己红掉
/// （"不剥注释"与"真用了"在源码文本上长得一模一样）。
fn strip_rust_comments(src: &str) -> String {
    let b: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == '"' {
            // 字符串字面量整段搬过去（含 `\"` 转义），免得把 URL 里的 `//` 当注释起点。
            out.push(b[i]);
            i += 1;
            while i < b.len() && b[i] != '"' {
                if b[i] == '\\' && i + 1 < b.len() {
                    out.push(b[i]);
                    i += 1;
                }
                out.push(b[i]);
                i += 1;
            }
            if i < b.len() {
                out.push(b[i]);
                i += 1;
            }
        } else if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '/' {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

/// 在一段**代码文本**里找出 `SelectTwo` 那版 `into_partial_model` 的每一处。
///
/// 认法 = turbofish 里有逗号（`::<A, B>` 就是两实体那版；`::<A>` 是单实体那版）。
/// 按**整份文本**扫、不逐行 —— 免得有人把 turbofish 折成两行就绕过去。
fn partial_model_two_hits(code: &str) -> Vec<String> {
    const NEEDLE: &str = "into_partial_model::<";
    let mut hits = Vec::new();
    let mut rest = code;
    while let Some(i) = rest.find(NEEDLE) {
        let after = &rest[i + NEEDLE.len()..];
        let end = after.find('>').unwrap_or(after.len());
        if after[..end].contains(',') {
            hits.push(after[..end].replace('\n', " "));
        }
        rest = &rest[i + 1..];
    }
    hits
}

/// `SelectTwo` 那版 `into_partial_model` **不许再出现**（见 ⑱ 头注）。
#[test]
fn 不许用_select_two_那版_partial_model() {
    // 判据自己的正控：剥注释**不能把代码也剥掉**。少了这一条，"strip 太狠 ⇒ 永远扫不到"
    // 会静默变成全绿，而它看起来跟"确实没有"一模一样。
    let sample = "let q = a.find_also_related(B).into_partial_model::<M, N>(); // 注释";
    assert_eq!(
        partial_model_two_hits(&strip_rust_comments(sample)).len(),
        1,
        "正控失败：真代码里的 `::<M, N>` 都没被抓到 ⇒ 下面那条扫不出东西不算数"
    );
    // 反控：注释里的、以及单实体那版，都不许报。
    let comments = "// 以前是 into_partial_model::<M, N>()\n/* 也曾是 into_partial_model::<M, N>() */";
    assert!(
        partial_model_two_hits(&strip_rust_comments(comments)).is_empty(),
        "反控失败：注释里的举例被当成真代码了"
    );
    let single = "let q = a.into_partial_model::<M>();";
    assert!(
        partial_model_two_hits(&strip_rust_comments(single)).is_empty(),
        "反控失败：单实体那版（`::<M>`）被误报"
    );

    let mut offenders: Vec<String> = Vec::new();
    let mut stack = vec![std::path::PathBuf::from("src")];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).expect("src 读不动") {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&p).unwrap();
            for h in partial_model_two_hits(&strip_rust_comments(&text)) {
                offenders.push(format!("{}: {h}", p.display()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "`SelectTwo` 那版 `into_partial_model` 每行都会映射失败（`select_only` 清掉了 \
         `A_`/`B_` 别名），而调用点的 `.unwrap_or(vec![])` 会让它**静默变成空列表**。\
         单实体那版没问题，用它 + 单独查一次关联表：{offenders:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑲ 文章↔标签的关联表（20261018）：往返、级联按列、撞号、移动、回填
// ─────────────────────────────────────────────────────────────────────────────
//
// `note.tags` 那一列逗号串归一成了 `note_tag` 关联表（`0006_note_tag.sql`）。这一节钉的是
// **存对了没有** —— `frontend/tests/note-tag-single-source.test.mjs` 那条源码锁只证明
// "写路径只有一条"，证明不了数据对（那条锁自己的末尾也是这么写的）。
//
// ⚠️ **本节用例之间有一条隐式不变量要守**（也是它们唯一会互相踩的地方）：
// **任何时刻已提交的 `note.tags` 里出现的 id，都必须在 `tag_one`/`tag_two` 里存在**
// （soak 期两处同源，见 `note_tags.rs` 头注）。回填那条用例的守卫是**扫全表**的，
// 所以只要某个用例在"标签已删、文章还在"的窗口里提交，它就会红在别人的残留上 ——
// 而且红得完全看不出前因后果。⇒ 收尾一律**先删文章、再删标签**；建的时候反过来。
//
// ⚠️ 这条不变量的**唯一例外是 panic**：收尾整段被跳过 ⇒ 库里会留下"标签已删、文章还在"
// 的残留，下一次跑时回填那条用例的守卫会因此红在一个与自己无关的原因上。所以那条用例
// 失败时会**顺带把绊倒守卫的文章打印出来**（`DIAG_DIRTY_TAGS`）—— 看到那个诊断先清残留，
// 别去查回填。
//
// ⚠️ 夹具 id 的取名规则（⑰ 按名字分表对账）：`_NOTE` 结尾 → `note` 表，
// 名字里带 `TAGONE` → `tag_one` 表，带 `TAGTWO` → `tag_two` 表。
/// ⚠️ **每个用例一个 uid**：`make_user` 先 DELETE 再 INSERT，两个用例共用一个号
/// 会在并发跑时互相抽走对方正在用的那一行（⑰ 就是拦这个的静态判据）。
const TAGRT_ADMIN_UID: i32 = 900000078;
const TAGCAS_ADMIN_UID: i32 = 900000079;
const TAGCOL_ADMIN_UID: i32 = 900000070;
const TAGMOVE_ADMIN_UID: i32 = 900000080;
const TAGAS_ADMIN_UID: i32 = 900000066;

const TAGRT_NOTE: i32 = 900000071;
/// ⚠️ 一级这个 id **比二级那个大**：这样"保序"与"按 id 排序"才分得开
/// （今天的串恰好升序是历史巧合，不是语义 —— 见 `0006` 头注）。
const TAGRT_TAGONE: i32 = 900000082;
const TAGRT_TAGTWO: i32 = 900000081;

const TAGCAS_NOTE: i32 = 900000072;
const TAGCAS_OTHER_NOTE: i32 = 900000073;
const TAGCAS_TAGONE: i32 = 900000083;
const TAGCAS_TAGTWO: i32 = 900000088;

const TAGCOL_NOTE: i32 = 900000074;
/// 撞号夹具：同一个数字在两张表里各有一行（两条独立自增序列，同号完全合法）。
const TAGCOL_TAGONE: i32 = 900000084;
const TAGCOL_TAGTWO: i32 = 900000084;

const TAGMOVE_NOTE: i32 = 900000075;
/// ≥ `TAG_TWO_ID_BASE`（10000）⇒ 升级时**不许沿用旧 id**，必然走"换 id"那一支
/// —— 也就是"改指向之后那一列还得跟着重算"最容易漏的那条路。
const TAGMOVE_TAGTWO: i32 = 900000094;

/// 自动保存那条路（克隆修改稿）用的夹具。
const TAGAS_NOTE: i32 = 900000090;
const TAGAS_TAGONE: i32 = 900000093;

const TAGBACK_NOTE: i32 = 900000076;
const TAGBACK_TAGONE: i32 = 900000085;
const TAGBACK_TAGTWO: i32 = 900000089;

/// 只被守卫的负控用：一个**两张表里都查不到**的 id（悬空）。
const TAGGUARD_NOTE: i32 = 900000077;

/// 诊断用（**不是判据**）：库里哪些文章的 `note.tags` 指着不存在的标签。
///
/// 存在的理由只有一个：0006 的守卫是扫全表的，红起来时得能一眼看出**是谁**把它绊倒的
/// （多半是上一次跑挂的残留）。它刻意写得比迁移里那条预检**简单** —— 诊断不该长得像判据，
/// 免得哪天有人把它当成"另一份口径"去同步。
const DIAG_DIRTY_TAGS: &str = "SELECT coalesce(string_agg(n.id::text || ':' || n.tags, ' | '), '（无）') \
     FROM note n \
    WHERE coalesce(n.tags, '') <> '' \
      AND EXISTS (SELECT 1 FROM unnest(string_to_array(n.tags, ',')) AS t(piece) \
                   WHERE trim(t.piece) ~ '^[0-9]+$' \
                     AND NOT EXISTS (SELECT 1 FROM tag_one o WHERE o.id::text = trim(t.piece)) \
                     AND NOT EXISTS (SELECT 1 FROM tag_two w WHERE w.id::text = trim(t.piece)))";

/// 建一篇属于某人的公开文章（`update_note` 那条路要 `auth_guard` 判库里的 role，
/// 所以夹具账号得是 admin；`user_id` 也照实写上，免得撞上"缺作者就补写"那条支线）。
async fn make_owned_note(db: &DatabaseConnection, id: i32, uid: i32) {
    exec(db, &format!("DELETE FROM note WHERE id = {id}")).await;
    exec(
        db,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, user_id, is_public, status) \
             VALUES ({id}, '标签夹具', 'x', NOW(), NOW(), {uid}, true, 'public')"
        ),
    )
    .await;
}

/// 建一行一级标签。**先建标签再建文章**（本节头注那条不变量）。
async fn make_tag_one(db: &DatabaseConnection, id: i32, name: &str) {
    exec(db, &format!("DELETE FROM tag_one WHERE id = {id}")).await;
    exec(
        db,
        &format!("INSERT INTO tag_one (id, name, color) VALUES ({id}, '{name}', '#111111')"),
    )
    .await;
}

/// 建一行二级标签（不带父，本节不测父子）。
async fn make_tag_two(db: &DatabaseConnection, id: i32, name: &str) {
    exec(db, &format!("DELETE FROM tag_two WHERE id = {id}")).await;
    exec(
        db,
        &format!("INSERT INTO tag_two (id, name, color) VALUES ({id}, '{name}', '#222222')"),
    )
    .await;
}

/// 关联表按 `seq` 拼出来的串 —— **与 `0007` 预检里那条重算语句同形**。
async fn tag_agg(db: &DatabaseConnection, note_id: i32) -> Option<String> {
    one_text(
        db,
        &format!(
            "SELECT string_agg(coalesce(tag_one_id, tag_two_id)::text, ',' ORDER BY seq) \
               FROM note_tag WHERE note_id = {note_id}"
        ),
    )
    .await
}

/// soak 期那条不变量：`note.tags` 那一列与关联表重算出来的串**逐字相同**（含顺序）。
///
/// 漂了不会有人看见（所有读路径都在关联表上），代价要等 `0007` 的预检把"删列"拦下来才
/// 显形 —— 而那时拿到的只是一句"两边漂了"。所以每一条改动关联表的用例收尾都调它一次。
async fn assert_mirror_matches(db: &DatabaseConnection, note_id: i32) {
    let col = one_text(db, &format!("SELECT tags FROM note WHERE id = {note_id}")).await;
    let agg = tag_agg(db, note_id).await;
    assert_eq!(
        col, agg,
        "文章 {note_id} 的 `note.tags` 与关联表重算出来的串不一致 —— soak 期两处同源，\
         漂了的话 `0007_drop_note_tags_column.sql` 的预检会把删列拦下来，而那时只知道\
         「两边漂了」（本用例的收尾 SQL 或某条写路径漏了 `resync_tags_column`）"
    );
}

/// 一篇文章的 `noteTags`（走公开详情，也就是**连线上的那一份**）。
async fn wire_note_tags(app: axum::Router, id: i32) -> String {
    let (st, j) = call(app, "GET", &format!("/api/public/notes/{id}"), None, None).await;
    assert_eq!(st, StatusCode::OK, "公开详情应当 200：{j}");
    let v = &j["data"]["noteTags"];
    assert!(v.is_string(), "`noteTags` 必须是字符串（缺键或 null 都会让前端解析炸）：{j}");
    v.as_str().unwrap().to_string()
}

#[tokio::test]
async fn note_tags_写路径往返逐字一致且归属按列() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, TAGRT_ADMIN_UID, "admin").await;
    // 建：先标签、再文章（本节头注）。
    make_tag_one(&db, TAGRT_TAGONE, "往返一级").await;
    make_tag_two(&db, TAGRT_TAGTWO, "往返二级").await;
    make_owned_note(&db, TAGRT_NOTE, TAGRT_ADMIN_UID).await;

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(TAGRT_ADMIN_UID, "admin", 0);

    // ── ① 脏值 + 乱序 + 混两级，一起喂进去 ──────────────────────────────────
    // 原串：一级(82) 在前、二级(81) 在后 —— **数字是降序**；外加重复、空片、一个空格。
    let raw = format!("{TAGRT_TAGONE}, {TAGRT_TAGTWO},{TAGRT_TAGONE},,");
    let (st, j) = call(
        app.clone(),
        "POST",
        &format!("/api/protected/notes/{TAGRT_NOTE}"),
        Some(&admin),
        Some(&format!(r#"{{"noteTags": "{raw}"}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "写标签必须成功：{j}");

    // 期望 = 解析口径（只认 ASCII 数字、`>0`、**保序**去重）的结果，不是原串：
    // 重复的去掉、空片丢掉、顺序照原样（**不是**按 id 排序）。
    let want = format!("{TAGRT_TAGONE},{TAGRT_TAGTWO}");
    assert_eq!(
        one_text(&db, &format!("SELECT tags FROM note WHERE id = {TAGRT_NOTE}")).await.as_deref(),
        Some(want.as_str()),
        "那一列必须落成解析结果（去重、保序），不是原串"
    );
    assert_eq!(
        tag_agg(&db, TAGRT_NOTE).await.as_deref(),
        Some(want.as_str()),
        "关联表按 seq 拼出来必须与那一列**逐字**相同（`0007` 预检用的就是这条）"
    );
    assert_eq!(
        count_of(&db, &format!("SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGRT_NOTE}")).await,
        2,
        "重复的 id 只许落一行"
    );
    // `seq` 从 0 起、连续 —— 它就是前端渲染标签的顺序。
    assert_eq!(
        one_text(&db, &format!(
            "SELECT string_agg(seq::text, ',' ORDER BY seq) FROM note_tag WHERE note_id = {TAGRT_NOTE}"
        ))
        .await
        .as_deref(),
        Some("0,1"),
        "`seq` 必须从 0 起连续（前端按存储顺序渲染标签）"
    );
    // 归属按**列**，不按数字大小：一级那个落 `tag_one_id`，二级那个落 `tag_two_id`。
    assert_eq!(
        one_text(&db, &format!(
            "SELECT tag_one_id::text || '/' || coalesce(tag_two_id::text, '-') \
               FROM note_tag WHERE note_id = {TAGRT_NOTE} AND seq = 0"
        ))
        .await
        .as_deref(),
        Some(format!("{TAGRT_TAGONE}/-").as_str()),
        "id 更大的那个是**一级**（tag_one_id），归属只能按列判、不能按数字猜"
    );
    assert_eq!(
        one_text(&db, &format!(
            "SELECT coalesce(tag_one_id::text, '-') || '/' || tag_two_id::text \
               FROM note_tag WHERE note_id = {TAGRT_NOTE} AND seq = 1"
        ))
        .await
        .as_deref(),
        Some(format!("-/{TAGRT_TAGTWO}").as_str())
    );
    // `num_nonnulls = 1` 这条约束（"这一行恰好指向一张表"）在**真数据**上没有被绕过。
    assert_eq!(
        count_of(&db, &format!(
            "SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGRT_NOTE} \
              AND num_nonnulls(tag_one_id, tag_two_id) <> 1"
        ))
        .await,
        0
    );

    // ── ② 线格式往返：详情接口给出的 `noteTags` 与写进去的解析结果逐字相同 ────
    assert_eq!(
        wire_note_tags(app.clone(), TAGRT_NOTE).await,
        want,
        "线格式（逗号分隔的 id 串）必须逐字不变 —— agent 仓与前端零改动就是靠这一条"
    );

    // ── ③ 空串：清空标签 ⇒ 关联表零行、那一列落 NULL、线上给 `\"\"` ─────────────
    let (st, j) = call(
        app.clone(),
        "POST",
        &format!("/api/protected/notes/{TAGRT_NOTE}"),
        Some(&admin),
        Some(r#"{"noteTags": ""}"#),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "{j}");
    assert_eq!(
        count_of(&db, &format!("SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGRT_NOTE}")).await,
        0,
        "空串 = 一个标签都没有 ⇒ 关联行必须全清掉"
    );
    assert_eq!(
        one_text(&db, &format!("SELECT tags FROM note WHERE id = {TAGRT_NOTE}")).await,
        None,
        "空列表要落成 NULL 而不是空串（存量里「没标签」一直是 NULL，写空串会让同一件事有两个字面值）"
    );
    assert_eq!(
        wire_note_tags(app, TAGRT_NOTE).await,
        "",
        "线上仍然要给 `\"\"`（不是 null、不是缺键）—— 前端 `parseNoteTags` 两个都吃，\
         但 agent 仓的 codec 逐字钉着这个形状"
    );

    // 收尾：**先删文章、再删标签**（本节头注那条不变量）。
    exec(&db, &format!("DELETE FROM note WHERE id = {TAGRT_NOTE}")).await;
    exec(&db, &format!("DELETE FROM tag_one WHERE id = {TAGRT_TAGONE}")).await;
    exec(&db, &format!("DELETE FROM tag_two WHERE id = {TAGRT_TAGTWO}")).await;
    exec(&db, &format!("DELETE FROM \"user\" WHERE id = {TAGRT_ADMIN_UID}")).await;
}

#[tokio::test]
async fn note_tags_外键级联是按列生效的() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, TAGCAS_ADMIN_UID, "admin").await;
    make_tag_one(&db, TAGCAS_TAGONE, "级联一级").await;
    make_tag_two(&db, TAGCAS_TAGTWO, "级联二级").await;
    make_owned_note(&db, TAGCAS_NOTE, TAGCAS_ADMIN_UID).await;
    make_owned_note(&db, TAGCAS_OTHER_NOTE, TAGCAS_ADMIN_UID).await;

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(TAGCAS_ADMIN_UID, "admin", 0);
    for (nid, tags) in [
        (TAGCAS_NOTE, format!("{TAGCAS_TAGONE},{TAGCAS_TAGTWO}")),
        // 另一篇只挂二级那个标签 —— 它是"删一级标签不许波及别处"的对照。
        (TAGCAS_OTHER_NOTE, format!("{TAGCAS_TAGTWO}")),
    ] {
        let (st, j) = call(
            app.clone(),
            "POST",
            &format!("/api/protected/notes/{nid}"),
            Some(&admin),
            Some(&format!(r#"{{"noteTags": "{tags}"}}"#)),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{j}");
        assert_eq!(j["code"], 200, "{j}");
    }

    // 删掉那一行一级标签（走真接口，不是裸 SQL —— 要验的正是"删标签这条路把那一列重算回来了"）。
    let (st, j) = call(
        app.clone(),
        "DELETE",
        "/api/protected/tag",
        Some(&admin),
        Some(&format!(r#"{{"level":"one","ids":[{TAGCAS_TAGONE}]}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "删标签应当成功：{j}");

    // ① 同篇里指向二级的那一行**还在**（旧 `prune_note_tags` 是"扫全表 + 按数字判"，
    //    它和"按列级联"在这条上会给出不同的结果 —— 这条就是两者的分界线）。
    assert_eq!(
        count_of(&db, &format!("SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGCAS_NOTE}")).await,
        1,
        "删一级标签只该带走指向它的那一行，同篇指向二级的行必须留着"
    );
    assert_eq!(
        one_text(&db, &format!(
            "SELECT tag_two_id::text FROM note_tag WHERE note_id = {TAGCAS_NOTE}"
        ))
        .await
        .as_deref(),
        Some(format!("{TAGCAS_TAGTWO}").as_str())
    );
    // ② 另一篇引用的是**别的标签**，一行都不该动。
    assert_eq!(
        count_of(&db, &format!(
            "SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGCAS_OTHER_NOTE}"
        ))
        .await,
        1,
        "删一个标签不该波及引用别的标签的文章"
    );
    // ③ 那一列跟着重算：一篇去掉一个、另一篇一个字不动（不是 NULL）。
    assert_mirror_matches(&db, TAGCAS_NOTE).await;
    assert_mirror_matches(&db, TAGCAS_OTHER_NOTE).await;
    assert_eq!(
        one_text(&db, &format!("SELECT tags FROM note WHERE id = {TAGCAS_NOTE}")).await.as_deref(),
        Some(format!("{TAGCAS_TAGTWO}").as_str()),
        "被删掉的那个 id 必须从那一列里消失（否则 0007 的预检会红）"
    );
    assert_eq!(
        wire_note_tags(app, TAGCAS_NOTE).await,
        format!("{TAGCAS_TAGTWO}")
    );

    // 收尾：先删文章、再删标签。
    exec(&db, &format!("DELETE FROM note WHERE id IN ({TAGCAS_NOTE}, {TAGCAS_OTHER_NOTE})")).await;
    exec(&db, &format!("DELETE FROM tag_two WHERE id = {TAGCAS_TAGTWO}")).await;
    exec(&db, &format!("DELETE FROM \"user\" WHERE id = {TAGCAS_ADMIN_UID}")).await;
}

#[tokio::test]
async fn note_tags_撞号时归一级且只出现一次() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, TAGCOL_ADMIN_UID, "admin").await;
    // 同一个数字在两张表里各建一行：两条自增序列互相独立，同号完全合法（`0006` 头注）。
    make_tag_one(&db, TAGCOL_TAGONE, "撞号一级").await;
    make_tag_two(&db, TAGCOL_TAGTWO, "撞号二级").await;
    make_owned_note(&db, TAGCOL_NOTE, TAGCOL_ADMIN_UID).await;

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(TAGCOL_ADMIN_UID, "admin", 0);
    let (st, j) = call(
        app.clone(),
        "POST",
        &format!("/api/protected/notes/{TAGCOL_NOTE}"),
        Some(&admin),
        Some(&format!(r#"{{"noteTags": "{TAGCOL_TAGONE}"}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "{j}");

    // 关联表落地之后这件事**结构性**不再含糊：一行自己知道指向哪张表。
    assert_eq!(
        count_of(&db, &format!("SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGCOL_NOTE}")).await,
        1,
        "撞号的 id 只许落一行（同一个标签在一篇里出现两次是脏数据）"
    );
    assert_eq!(
        one_text(&db, &format!(
            "SELECT coalesce(tag_one_id::text, '-') || '/' || coalesce(tag_two_id::text, '-') \
               FROM note_tag WHERE note_id = {TAGCOL_NOTE}"
        ))
        .await
        .as_deref(),
        Some(format!("{TAGCOL_TAGONE}/-").as_str()),
        "撞号取**一级**（与前端 `flattenTagOptions`、`0006` 回填的取向同一处对齐）"
    );
    // 线上也必须是**一个** id，不是两个、也不是空。
    let wire = wire_note_tags(app, TAGCOL_NOTE).await;
    assert_eq!(wire, format!("{TAGCOL_TAGONE}"));
    assert_eq!(wire.split(',').count(), 1, "撞号不许在线上变成两个标签：{wire}");
    assert_mirror_matches(&db, TAGCOL_NOTE).await;

    exec(&db, &format!("DELETE FROM note WHERE id = {TAGCOL_NOTE}")).await;
    exec(&db, &format!("DELETE FROM tag_one WHERE id = {TAGCOL_TAGONE}")).await;
    exec(&db, &format!("DELETE FROM tag_two WHERE id = {TAGCOL_TAGTWO}")).await;
    exec(&db, &format!("DELETE FROM \"user\" WHERE id = {TAGCOL_ADMIN_UID}")).await;
}

#[tokio::test]
async fn note_tags_跨表移动后标签仍挂在原文章上() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, TAGMOVE_ADMIN_UID, "admin").await;
    make_tag_two(&db, TAGMOVE_TAGTWO, "移动二级").await;
    make_owned_note(&db, TAGMOVE_NOTE, TAGMOVE_ADMIN_UID).await;

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(TAGMOVE_ADMIN_UID, "admin", 0);
    let (st, j) = call(
        app.clone(),
        "POST",
        &format!("/api/protected/notes/{TAGMOVE_NOTE}"),
        Some(&admin),
        Some(&format!(r#"{{"noteTags": "{TAGMOVE_TAGTWO}"}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "{j}");

    // 二 → 一。id ≥ `TAG_TWO_ID_BASE` ⇒ **不许沿用旧 id**，于是必然走"换 id"那一支。
    let (st, j) = call(
        app.clone(),
        "POST",
        "/api/protected/tag/move",
        Some(&admin),
        Some(&format!(
            r#"{{"level":"two","id":{TAGMOVE_TAGTWO},"toLevel":"one"}}"#
        )),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "移动应当成功：{j}");
    assert_eq!(j["data"]["idChanged"], true, "id ≥ 10000 时不许沿用旧 id：{j}");
    let new_id = j["data"]["toId"].as_i64().expect("toId 必须是数字") as i32;
    assert_ne!(new_id, TAGMOVE_TAGTWO);

    // ★ 这条用例的核心：标签**还挂在原来那篇文章上**。
    // 顺序反了（先删旧标签行、再改指向）的话外键 `ON DELETE CASCADE` 会把关联行静默带走 ——
    // 事务照常提交、接口回 200、标签从 API 上消失，没有任何东西报错。
    assert_eq!(
        count_of(&db, &format!("SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGMOVE_NOTE}")).await,
        1,
        "跨表移动之后标签必须还在原来那篇文章上（没了 = 改指向与删旧行的顺序反了）"
    );
    assert_eq!(
        one_text(&db, &format!(
            "SELECT coalesce(tag_one_id::text, '-') || '/' || coalesce(tag_two_id::text, '-') \
               FROM note_tag WHERE note_id = {TAGMOVE_NOTE}"
        ))
        .await
        .as_deref(),
        Some(format!("{new_id}/-").as_str()),
        "改指向要**换列**（tag_two_id → tag_one_id），不能只换值"
    );
    // 换了 id ⇒ 那一列必须跟着重算（沿用旧 id 时它本来就还是对的，这一支才是最容易漏的）。
    assert_mirror_matches(&db, TAGMOVE_NOTE).await;
    assert_eq!(wire_note_tags(app, TAGMOVE_NOTE).await, format!("{new_id}"));
    // 旧行真的没了（否则 `tag_two` 里会留一行孤儿标签）。
    assert_eq!(
        count_of(&db, &format!("SELECT COUNT(*) FROM tag_two WHERE id = {TAGMOVE_TAGTWO}")).await,
        0
    );

    exec(&db, &format!("DELETE FROM note WHERE id = {TAGMOVE_NOTE}")).await;
    exec(&db, &format!("DELETE FROM tag_one WHERE id = {new_id}")).await;
    exec(&db, &format!("DELETE FROM \"user\" WHERE id = {TAGMOVE_ADMIN_UID}")).await;
}

#[tokio::test]
async fn note_tag_回填逐字往返且悬空会被守卫拦下() {
    let Some((db, _app)) = connect_pair().await else { return };
    // `include_str!` 而不是把回填 SQL 抄一遍：抄一份出来就等于"第二个实现"，
    // 而这份迁移只跑一次 —— 抄本会静静地与真本漂开，谁也不会发现。
    let migration = include_str!("../scripts/migration/pg/0006_note_tag.sql");

    // ── ① 回填往返 ─────────────────────────────────────────────────────────
    // 整段放在一个**事务里、最后回滚**：① 种下的"遗留串"绝不提交，免得别的用例
    // （尤其是本用例②的守卫）被它影响；② 本用例自己不留下任何残留。
    make_tag_one(&db, TAGBACK_TAGONE, "回填一级").await;
    make_tag_two(&db, TAGBACK_TAGTWO, "回填二级").await;
    let txn = db.begin().await.expect("开事务失败");
    // 遗留串刻意是脏的 + 乱序的 + 混两级的：重复、空片、以及**数字更大的那个在前**。
    let legacy = format!("{TAGBACK_TAGONE},{TAGBACK_TAGONE},,{TAGBACK_TAGTWO}");
    exec(
        &txn,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status, tags) \
             VALUES ({TAGBACK_NOTE}, '回填夹具', 'x', NOW(), NOW(), true, 'public', '{legacy}')"
        ),
    )
    .await;
    if let Err(e) = txn.execute_unprepared(migration).await {
        // ⚠️ 这条 `expect` 会**连带**红在别人的残留上：0006 的守卫是扫全表的，只要库里
        // 存在任何一篇"`note.tags` 指着已经不存在的标签"的文章，它就会中止整个迁移。
        // 正常跑时不会（本节头注那条不变量），但**上一次跑挂在中途**会 —— 收尾整段被
        // panic 跳过，残留就留在了库里。所以这里把"是谁把守卫绊倒的"直接问出来：
        // 不然下一个人看到的是"回填失败了"，而真正的原因在上一次运行。
        let dirty = one_text(&txn, DIAG_DIRTY_TAGS).await.unwrap_or_default();
        panic!(
            "跑 0006 的回填失败：{e}\n  \
             守卫是**扫全表**的，绊倒它的文章是（`文章id:它的串`）：{dirty}\n  \
             这些若不是本用例自己造的，就是上一次跑挂留下的残留（本节的收尾在 panic 时被跳过）——\
             先清掉再跑。"
        );
    }

    let want = format!("{TAGBACK_TAGONE},{TAGBACK_TAGTWO}");
    assert_eq!(
        one_text(&txn, &format!(
            "SELECT string_agg(coalesce(tag_one_id, tag_two_id)::text, ',' ORDER BY seq) \
               FROM note_tag WHERE note_id = {TAGBACK_NOTE}"
        ))
        .await
        .as_deref(),
        Some(want.as_str()),
        "回填必须**逐字**复原（去重取首次出现、顺序照原串、两级按列归属）"
    );
    assert_eq!(
        one_text(&txn, &format!(
            "SELECT coalesce(tag_one_id::text,'-') || '/' || coalesce(tag_two_id::text,'-') \
               FROM note_tag WHERE note_id = {TAGBACK_NOTE} AND seq = 0"
        ))
        .await
        .as_deref(),
        Some(format!("{TAGBACK_TAGONE}/-").as_str())
    );
    assert_eq!(
        one_text(&txn, &format!(
            "SELECT coalesce(tag_one_id::text,'-') || '/' || coalesce(tag_two_id::text,'-') \
               FROM note_tag WHERE note_id = {TAGBACK_NOTE} AND seq = 1"
        ))
        .await
        .as_deref(),
        Some(format!("-/{TAGBACK_TAGTWO}").as_str())
    );
    // 回填**不碰**那一列（它只插关联行）：soak 期那一列本来就还是原样，
    // 而 `0007` 的预检比的是"两边逐字相等"—— 这里顺带把"回填之后两边仍然相等"钉住。
    assert_eq!(
        one_text(&txn, &format!("SELECT tags FROM note WHERE id = {TAGBACK_NOTE}")).await.as_deref(),
        Some(legacy.as_str()),
        "回填只插关联行、不改那一列（那一列由「预检保证两边本来就一致」承接）"
    );
    // 重跑一次必须**一行都不加**（幂等：`NOT EXISTS` 那半）。
    txn.execute_unprepared(migration).await.expect("重跑 0006 不该失败");
    assert_eq!(
        count_of(&txn, &format!("SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGBACK_NOTE}")).await,
        2,
        "0006 重跑必须是 no-op（`NOT EXISTS` 那半）—— 它会被跑第二遍（改了库结构再跑一次是常态）"
    );
    txn.rollback().await.expect("回滚失败");

    // ── ② 负控：悬空的 id 必须被守卫拦下 ────────────────────────────────────
    // 没有这一条的话，①里那个"跑成功了"证明不了守卫在场 —— 一个恒真的守卫与一个
    // 正确的守卫，在①里的表现**一模一样**。
    let txn = db.begin().await.expect("开事务失败");
    exec(
        &txn,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status, tags) \
             VALUES ({TAGGUARD_NOTE}, '悬空夹具', 'x', NOW(), NOW(), true, 'public', '999999999')"
        ),
    )
    .await;
    let e = txn
        .execute_unprepared(migration)
        .await
        .expect_err("遗留串里有一个两张表都查不到的 id ⇒ 守卫必须中止整个迁移（本迁移不猜）");
    let msg = e.to_string();
    assert!(
        msg.contains("本迁移不猜"),
        "拦下它的必须是那条守卫（拿到的是：{msg}）"
    );
    txn.rollback().await.expect("回滚失败");

    // 收尾：先删文章（上面两次都回滚了，这里其实没有残留）、再删标签。
    exec(&db, &format!("DELETE FROM note WHERE id IN ({TAGBACK_NOTE}, {TAGGUARD_NOTE})")).await;
    exec(&db, &format!("DELETE FROM tag_one WHERE id = {TAGBACK_TAGONE}")).await;
    exec(&db, &format!("DELETE FROM tag_two WHERE id = {TAGBACK_TAGTWO}")).await;
}

#[tokio::test]
async fn note_tags_修改稿从原行复制标签() {
    let Some((db, db_app)) = connect_pair().await else { return };
    make_user(&db, TAGAS_ADMIN_UID, "admin").await;
    make_tag_one(&db, TAGAS_TAGONE, "修改稿一级").await;
    make_owned_note(&db, TAGAS_NOTE, TAGAS_ADMIN_UID).await;
    // 上一次跑挂留下的修改稿（`draft_of` 指着源行）。
    exec(&db, &format!("DELETE FROM note WHERE draft_of = {TAGAS_NOTE}")).await;

    let app = test_app(db_app);
    let admin = auth_jwt::create_token(TAGAS_ADMIN_UID, "admin", 0);
    let tags = format!("{TAGAS_TAGONE}");
    let (st, j) = call(
        app.clone(),
        "POST",
        &format!("/api/protected/notes/{TAGAS_NOTE}"),
        Some(&admin),
        Some(&format!(r#"{{"noteTags": "{tags}"}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "{j}");

    // 自动保存一个**非草稿**的源行 ⇒ `resolve_autosave_target` 克隆出一行修改稿。
    // 这一笔**不带** `noteTags`（编辑器平时就是这么发的），所以修改稿的标签只能来自
    // "从源行复制"那条路 —— 漏了的话"继续编辑"打开时标签栏是空的，用户一保存就把标签清光。
    let (st, j) = call(
        app.clone(),
        "POST",
        "/api/protected/draft/autosave",
        Some(&admin),
        Some(&format!(r#"{{"id":{TAGAS_NOTE},"noteTitle":"自动保存夹具"}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["code"], 200, "自动保存应当成功：{j}");
    // ⚠️ 键名是 **`draftId`**（驼峰，有 serde rename），不是 `draft_id`：写成下划线会拿到
    // `None`，而 `expect` 至少会当场报出来（静默版是 `unwrap_or(0)`，那会去查一篇不存在的文章）。
    let rev = j["data"]["draftId"].as_i64().expect("draftId 必须是数字") as i32;
    assert_ne!(rev, TAGAS_NOTE, "源行不是草稿 ⇒ 应当克隆出一行**新的**修改稿");
    assert_eq!(
        one_i32(&db, &format!("SELECT draft_of FROM note WHERE id = {rev}")).await,
        Some(TAGAS_NOTE),
        "克隆出来的那一行得记得自己是谁的修改稿"
    );

    // ★ 修改稿的标签必须与源行一致（关联表**不会**跟着列克隆走，得显式复制一份）。
    assert_eq!(
        tag_agg(&db, rev).await,
        tag_agg(&db, TAGAS_NOTE).await,
        "修改稿必须复制源行的标签（漏了 ⇒ 打开修改稿时标签栏是空的，一保存就把标签清光）"
    );
    assert_eq!(
        tag_agg(&db, rev).await.as_deref(),
        Some(tags.as_str()),
        "而且复制过来的就是源行那一份"
    );
    // 两条路的"那一列"都得对上（克隆那一笔写的是关联表 + 那一列，两边同源）。
    assert_mirror_matches(&db, rev).await;
    assert_mirror_matches(&db, TAGAS_NOTE).await;
    // 源行的标签一个都没被改动（克隆是"复制"，不是"搬走"）。
    assert_eq!(
        count_of(&db, &format!("SELECT COUNT(*) FROM note_tag WHERE note_id = {TAGAS_NOTE}")).await,
        1
    );

    // 收尾：先删文章（源行 + 修改稿）、再删标签。
    exec(&db, &format!("DELETE FROM note WHERE id = {rev} OR id = {TAGAS_NOTE}")).await;
    exec(&db, &format!("DELETE FROM tag_one WHERE id = {TAGAS_TAGONE}")).await;
    exec(&db, &format!("DELETE FROM \"user\" WHERE id = {TAGAS_ADMIN_UID}")).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑳ 搜索的 SQL 预筛（20261018）：预筛不许**少收一行**
// ─────────────────────────────────────────────────────────────────────────────
//
// 预筛只保证**超集**（`search_core::keyword_prefilter` 头注）：真判定、打分、档位、顺序
// 全留在内存那一遍。所以它唯一危险的坏法是**少收** —— SQL 没把某一行取回来，内存里那一遍
// 再准也看不见它，结果是"搜不到"，而接口照旧 200、日志一个字都没有。⇒ 本节每条判据
// 都是「**该出现的那一类必须出现**」，而不是"看着像对"。
//
// 四类命中各一条夹具：只命中标题 / 只命中正文 / **只命中标签名** / 必须不出现的隐藏稿。
// 第三类是新解锁的那一格：标签名住在 `note_tag` 关联表里，SQL 主查询碰不到，只能先把
// 命中的文章 id 取回来 OR 进去（`notes::note_keyword_prefilter`）。关联表落地之前
// SQL 侧**根本判不了**这一维（那时标签是 id 串：搜名字恒空、搜数字恒假命中）。
//
// ⚠️ **`%` / `_` 的转义在本节里几乎观察不到**，别把它读成"测过了"：内存判定才是权威
// （`to_lowercase().contains`），未转义的 `LIKE` 只会**多收**行，多收的那些到内存里照样
// 被筛掉 ⇒ 最终答案一个字不差。真正会因转义坏掉的是**反斜杠**（模式里的 `\p` 被 PG 当成
// "转义的 p" ⇒ **少收**），所以只有它有一条端到端判据（见 ⑳b）。`%` / `_` 的判据在
// `search_core` 的 SQL 文本单测里（那里看的是生成出来的模式串本身）。

/// 夹具关键词：**刻意是个真实内容里不可能出现的怪串**（同 `AGG_KW` 的理由 —— 断言里
/// 有精确 id 集合，撞上库里任何一条真实内容就会红得像是"搜索坏了"）。
const SRCH_KW: &str = "qzkw";

const SRCH_TITLE_NOTE: i32 = 900000101; // 只命中**标题** ⇒ 该出现
const SRCH_BODY_NOTE: i32 = 900000102; // 只命中**正文** ⇒ 该出现
const SRCH_TAG_NOTE: i32 = 900000103; // 标题/正文都不含关键词，**只有标签名含** ⇒ 该出现
const SRCH_HIDDEN_NOTE: i32 = 900000110; // 标题命中但 `is_public=false` ⇒ 不许出现
const SRCH_TAGONE: i32 = 900000111; // 上面那篇挂的一级标签，名字里带关键词

/// 取搜索结果里的 `noteKey`，**保持服务端给的顺序**（⑳a 要钉排序，不能排序后再比）。
fn note_keys(j: &serde_json::Value) -> Vec<i32> {
    j["data"]
        .as_array()
        .unwrap_or_else(|| panic!("data 不是数组：{j}"))
        .iter()
        .map(|r| r["noteKey"].as_i64().expect("文章行没有整数 noteKey") as i32)
        .collect()
}

/// 发一条文章搜索（`/api/public/notes/search`，**无鉴权**）。
async fn search_notes_of(app: axum::Router, keyword: &str) -> serde_json::Value {
    let body = format!(r#"{{"keyword":"{keyword}"}}"#);
    let (st, j) = call(app, "POST", "/api/public/notes/search", None, Some(&body)).await;
    assert_eq!(st, StatusCode::OK, "文章搜索不该在 HTTP 层失败：{j}");
    assert_eq!(j["code"], 200, "信封 code 必须是 200：{j}");
    j
}

#[tokio::test]
async fn test_搜索预筛的四类命中与档内顺序() {
    let Some((db, db_app)) = connect_pair().await else { return };

    // 先清自己的残留（上次跑挂了会留下行）。**先删文章、再删标签**（⑲ 头注那条不变量）。
    exec(
        &db,
        &format!(
            "DELETE FROM note WHERE id IN ({SRCH_TITLE_NOTE},{SRCH_BODY_NOTE},{SRCH_TAG_NOTE},{SRCH_HIDDEN_NOTE})"
        ),
    )
    .await;
    exec(&db, &format!("DELETE FROM tag_one WHERE id = {SRCH_TAGONE}")).await;

    // 建：先标签、再文章（同 ⑲）。
    make_tag_one(&db, SRCH_TAGONE, &format!("{SRCH_KW}标签名")).await;
    exec(
        &db,
        &format!(
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status) VALUES \
             ({SRCH_TITLE_NOTE},  '{SRCH_KW} 标题命中', '正文里没有那个词', NOW(), NOW(), true,  'published'), \
             ({SRCH_BODY_NOTE},   '无关标题',          '正文里出现 {SRCH_KW} 一次', NOW(), NOW(), true, 'published'), \
             ({SRCH_TAG_NOTE},    '无关标题',          '正文里没有那个词', NOW(), NOW(), true, 'published'), \
             ({SRCH_HIDDEN_NOTE}, '{SRCH_KW} 隐藏稿',  '正文里没有那个词', NOW(), NOW(), false, 'published')"
        ),
    )
    .await;
    // 第三篇只挂标签：标题、正文都不含关键词 ⇒ 它能被搜到**只能**因为标签那一维被 OR 进来。
    exec(
        &db,
        &format!(
            "INSERT INTO note_tag (note_id, seq, tag_one_id, tag_two_id) \
             VALUES ({SRCH_TAG_NOTE}, 0, {SRCH_TAGONE}, NULL)"
        ),
    )
    .await;
    exec(
        &db,
        &format!("UPDATE note SET tags = '{SRCH_TAGONE}' WHERE id = {SRCH_TAG_NOTE}"),
    )
    .await;

    let j = search_notes_of(test_app(db_app), SRCH_KW).await;
    // **精确有序列表**（多一行少一行、顺序换了都红）。
    // 顺序 = 档内按分数倒序，而三篇的分数恰好各来自一个维度：
    //   标题命中 +100 / **标签命中 +30** / 正文出现 1 次 +1
    // ⇒ 这条同时钉住了「打分还在内存里跑」与「标签那一维真的接上了」两件事。
    assert_eq!(
        note_keys(&j),
        vec![SRCH_TITLE_NOTE, SRCH_TAG_NOTE, SRCH_BODY_NOTE],
        "四类命中：标题(+100) > 标签(+30) > 正文(+1)；隐藏稿不许出现。实得：{j}"
    );

    // 收尾：先文章、再标签。
    exec(
        &db,
        &format!(
            "DELETE FROM note WHERE id IN ({SRCH_TITLE_NOTE},{SRCH_BODY_NOTE},{SRCH_TAG_NOTE},{SRCH_HIDDEN_NOTE})"
        ),
    )
    .await;
    exec(&db, &format!("DELETE FROM tag_one WHERE id = {SRCH_TAGONE}")).await;
}

// ── ⑳b 大小写口径 / 可见集合不被收窄 / 反斜杠转义 ──────────────────────────────
//
// 三条判据各钉一个**会静默丢结果**的坏法，都不是"看着像对"：
//
//   ① **大小写**：预筛用 `ILIKE`，内存判定是 `to_lowercase().contains`。若预筛写成 `LIKE`
//      （PG 的 `LIKE` **区分大小写**），正文里写 `ESP32`、查询是 `esp32` 的那些行会被
//      SQL 这一层丢掉 —— 内存那一遍永远看不见它们。**同一处缺陷在 `search.rs` 的
//      `talk_hits` / `comment_hits` 里是存量 bug**（那两处一直用 `Column::…like(...)`），
//      20261018 一并修成 `ILIKE`。
//   ② **可见集合不许被预筛收窄**：评论那一栏问的是"这篇**文章**可见吗"，不是"这篇**文章**
//      命中关键词吗"。拿预筛后的文章集合去喂，搜一个词就会让**别的文章下的评论整片消失**
//      —— 所以 `search_all` 里可见集合是一条**不带关键词**的独立查询（`visible_notes_query`）。
//   ③ **反斜杠**：预筛的模式串过 `like_escape`。不转义的话 `%z:\srch%` 里的 `\s` 被 PG
//      当成"转义的 s"（等价于搜 `z:srch`）⇒ **少收**。
//      ⚠️ 路径**刻意不用 `c:\path`**：⑩ 那条用例搜 `c:\path` 时断言"文章/说说/评论
//      三个计数都是 0"，而它自己的注释就写着"开发库上若有真实内容写着这个路径，这里会红"。
//      两个用例是**并发**跑的 —— 用同一个串就是给 ⑩ 埋一条随机红（20261018 实测撞过）。
//
// ⚠️ ② 与 ③ 的夹具都刻意让"文章本身不命中关键词" —— 否则判据在坏掉的实现上**照样绿**。

const SRCH_UPPER_NOTE: i32 = 900000104; // 正文写的是大写 `ESP32` ⇒ 搜 `esp32` 必须找得到
const SRCH_BSLASH_NOTE: i32 = 900000105; // 正文含字面量 `c:\path` ⇒ 搜 `c:\path` 必须找得到
const SRCH_CMT_HOST_NOTE: i32 = 900000106; // 标题/正文都与下面两个关键词无关
const SRCH_PCT_NOTE: i32 = 900000107; // 正文含字面量 `100%`
const SRCH_UNDER_NOTE: i32 = 900000108; // 正文含 `aXb` ⇒ 搜 `a_b` 不该找到它

const SRCH_CMT_PLAIN: i32 = 900000121; // 挂在上面的宿主文章上，正文含小写 `zqx`
const SRCH_CMT_UPPER: i32 = 900000122; // 同上，正文含大写 `QRW`
const SRCH_TALK_UPPER: i32 = 900000131; // 说说，正文含大写 `VBN`

#[tokio::test]
async fn test_搜索预筛的大小写可见集合与转义() {
    let Some((db, db_app)) = connect_pair().await else { return };

    for id in [SRCH_UPPER_NOTE, SRCH_BSLASH_NOTE, SRCH_CMT_HOST_NOTE, SRCH_PCT_NOTE, SRCH_UNDER_NOTE] {
        exec(&db, &format!("DELETE FROM note WHERE id = {id}")).await;
    }
    for id in [SRCH_CMT_PLAIN, SRCH_CMT_UPPER] {
        exec(&db, &format!("DELETE FROM note_comment WHERE id = {id}")).await;
    }
    exec(&db, &format!("DELETE FROM talk WHERE id = {SRCH_TALK_UPPER}")).await;

    // 正文里是**大写** `ESP32`（`ILIKE` 的判据）；`c:\path` 是**单个**反斜杠 ——
    // PG 默认 `standard_conforming_strings = on`，字符串字面量里的反斜杠就是反斜杠，
    // 写成 `\\` 会存进两个、这条判据当场失去意义（同 ⑱ 那条反斜杠夹具的 ⚠️）。
    exec(
        &db,
        &format!(
            // ⚠️ **普通字符串**（不是 `r"…"`）：`\` + 换行才是续行。写成原始字符串的话
            // 那些续行的反斜杠会原样进 SQL，PG 直接报 `syntax error at or near "\"`。
            // 而正文里的那一个反斜杠得写成 `\\`（Rust 层折成 `\`，PG 的
            // `standard_conforming_strings = on` 再不吃一层 ⇒ 库里存的就是**一个**）。
            "INSERT INTO note (id, title, content, created_at, updated_at, is_public, status) VALUES \
             ({SRCH_UPPER_NOTE},     '固件笔记',  '正文里写的是 ESP32 大写', NOW(), NOW(), true, 'published'), \
             ({SRCH_BSLASH_NOTE},    '路径笔记',  '路径 z:\\srch 结束',      NOW(), NOW(), true, 'published'), \
             ({SRCH_CMT_HOST_NOTE},  '评论宿主',  '与这两个关键词都无关',    NOW(), NOW(), true, 'published'), \
             ({SRCH_PCT_NOTE},       '百分比笔记', '完成度 100% 的夹具',     NOW(), NOW(), true, 'published'), \
             ({SRCH_UNDER_NOTE},     '下划线笔记', '正文里写着 aXb 三个字符', NOW(), NOW(), true, 'published')"
        ),
    )
    .await;

    // 两条评论挂在**标题/正文都不含 `zqx`/`qrw`** 的文章上 ⇒ 它们能不能被搜到，
    // 只取决于"可见集合有没有被预筛收窄"。
    exec(
        &db,
        &format!(
            "INSERT INTO note_comment (id, note_id, user_id, content, approved, is_deleted, created_at, updated_at) VALUES \
             ({SRCH_CMT_PLAIN}, {SRCH_CMT_HOST_NOTE}, 0, '评论正文 zqx', 1, 0, NOW(), NOW()), \
             ({SRCH_CMT_UPPER}, {SRCH_CMT_HOST_NOTE}, 0, '评论正文 QRW', 1, 0, NOW(), NOW())"
        ),
    )
    .await;
    // 说说：正文大写。这一条**与可见集合无关**（说说那一栏不看文章），
    // 所以它单独钉 `talk_hits` 的 `LIKE → ILIKE`。
    exec(
        &db,
        &format!(
            "INSERT INTO talk (id, title, content, cat, v, author, user_id, src, approved, created_at, updated_at) VALUES \
             ({SRCH_TALK_UPPER}, '无关标题', '说说正文 VBN 大写', '愿', 0, '', 0, 'talk', 1, NOW(), NOW())"
        ),
    )
    .await;

    // `Router` 是 `Clone`（`DatabaseConnection` **不是**，见 `connect_pair` 头注）⇒ 真链路
    // 那条句柄建一次、每条请求克隆一份。
    let app = test_app(db_app);

    // ── ① 大小写（文章）────────────────────────────────────────────────
    let j = search_notes_of(app.clone(), "esp32").await;
    assert!(
        note_keys(&j).contains(&SRCH_UPPER_NOTE),
        "正文写 `ESP32`、查询是 `esp32` 的篇**必须**在结果里 —— 少了它说明预筛是区分\
         大小写的 `LIKE`（内存那一遍永远看不见这一行）：{j}"
    );

    // ── ③ 反斜杠转义（文章）────────────────────────────────────────────
    let j = search_notes_of(app.clone(), r"z:\\srch").await;
    assert!(
        note_keys(&j).contains(&SRCH_BSLASH_NOTE),
        "正文含字面量 `z:\\srch` 的篇必须能被 `z:\\srch` 搜到（模式串没过 `like_escape` \
         的话 `\\s` 会被当成转义的 s ⇒ 少收）：{j}"
    );

    // ── ② 可见集合不被收窄（评论）+ ① 的大小写（评论）────────────────────
    let body = r#"{"keyword":"zqx"}"#;
    let (st, j) = call(app.clone(), "POST", "/api/public/search", None, Some(body)).await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert!(
        agg_keys(&j, "comments").contains(&SRCH_CMT_PLAIN),
        "评论的宿主文章**自己不命中关键词**，但那条评论必须被搜到 —— 少了它说明\
         `visible_ids` 是拿**预筛后的候选集合**当可见集合了（搜一个词就把别的文章下的\
         评论整片抹掉）：{j}"
    );

    let body = r#"{"keyword":"qrw"}"#;
    let (st, j) = call(app.clone(), "POST", "/api/public/search", None, Some(body)).await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert!(
        agg_keys(&j, "comments").contains(&SRCH_CMT_UPPER),
        "评论正文写 `QRW`、查询 `qrw` 必须命中（`comment_hits` 的 `LIKE` 是存量 bug，\
         20261018 修成 `ILIKE`）：{j}"
    );

    let body = r#"{"keyword":"vbn"}"#;
    let (st, j) = call(app.clone(), "POST", "/api/public/search", None, Some(body)).await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert!(
        agg_keys(&j, "talks").contains(&SRCH_TALK_UPPER),
        "说说正文写 `VBN`、查询 `vbn` 必须命中（同上，`talk_hits` 的 `LIKE`）：{j}"
    );

    // ── `%` / `_`：只钉"最终答案"，**钉不住转义**（见本节头注的 ⚠️）─────────
    // 正面这一条仍然有意义：它是"含 `%` 的行必须**找得到**"，任何让预筛在 `%` 上炸掉的
    // 实现（比如换成正则）都会在这里红。
    let j = search_notes_of(app.clone(), "100%").await;
    assert!(
        note_keys(&j).contains(&SRCH_PCT_NOTE),
        "正文含字面量 `100%` 的篇必须能被 `100%` 搜到：{j}"
    );
    // 负面这一条**对转义不敏感**（未转义的 `a_b` 会多收 `aXb`，但内存判定照样把它筛掉
    // ⇒ 最终答案一样）。留着是因为它锁的是**最终答案**：哪天有人把判定搬进 SQL，
    // 这条立刻变成真判据。
    let j = search_notes_of(app.clone(), "a_b").await;
    assert!(
        !note_keys(&j).contains(&SRCH_UNDER_NOTE),
        "搜 `a_b` 不该命中正文里的 `aXb`（`_` 是 LIKE 的单字符通配符）：{j}"
    );

    // 收尾：先文章、再评论/说说（评论与文章之间没有外键，得各自删）。
    for id in [SRCH_UPPER_NOTE, SRCH_BSLASH_NOTE, SRCH_CMT_HOST_NOTE, SRCH_PCT_NOTE, SRCH_UNDER_NOTE] {
        exec(&db, &format!("DELETE FROM note WHERE id = {id}")).await;
    }
    for id in [SRCH_CMT_PLAIN, SRCH_CMT_UPPER] {
        exec(&db, &format!("DELETE FROM note_comment WHERE id = {id}")).await;
    }
    exec(&db, &format!("DELETE FROM talk WHERE id = {SRCH_TALK_UPPER}")).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// ㉑ 评论排序（20261020）：`?sort=hot` 与 `?sort=new` 排出**不同的顺序**，且缺省 = hot
// ─────────────────────────────────────────────────────────────────────────────
//
// **为什么这条必须真连库**：热度公式本身是纯函数（`src/routes/comments.rs` 的内联单测
// 把它的形状钉住了：单调性、先验、上界、全序）。纯函数测不到的是**它接没接上**：
//   · `?sort=` 参数解没解析、未知值会不会把整个请求打成 400；
//   · 回复数是**整棵子树**还是直接回复（"回复的回复"也挂在同一个顶层下）；
//   · 回复数只数**公开可见**的那些；
//   · **缺省档**——前端不发 `sort` 时服务端走哪一档。这是产品口径（默认热度），
//     而它在纯函数里一个字都体现不出来。
//
// ⚠️ 夹具刻意让两个顺序**完全不同**（不是"差一条"）：只差一条时，"排序没生效"与
// "生效了、恰好排出这样"看起来一模一样。这里 hot = TOP→REPLY→ONE→DOWN、
// new = ONE→DOWN→TOP→REPLY，**没有任何一条位置相同**；而 SQL 那条前置排序本身就是
// new 档的顺序 ⇒ 把内存排序删掉，hot 那几条断言当场红（这就是本条的反控）。

/// 讨论区夹具的文章与作者（见 ⑰：每个用例一个 uid，`make_user` 先删后插）。
const HOT_NOTE: i32 = 900000202;
const HOT_UID: i32 = 900000201;
/// 四条顶层评论。**id 与"哪条热"无关**（刻意的：若按 id 也能排对，就分不清判据在
/// 读 id 还是在读热度）。
const HOT_CMT_REPLY: i32 = 900000211; // 0 票 + 15 条回复（含 1 条"回复的回复"）⇒ 0.495，第 2
const HOT_CMT_TOP: i32 = 900000212; // 20 赞 1 踩 ⇒ 0.732，第 1
const HOT_CMT_DOWN: i32 = 900000213; // 0 赞 5 踩 ⇒ 0.026，第 4
const HOT_CMT_ONE: i32 = 900000214; // 1 赞 ⇒ 0.208，第 3
/// 回复 id 段：`900000221 + (g-1)`，g ∈ [1, 15]。另有两条**不该被数进去**的（见下）。
const HOT_REPLY_BASE: i32 = 900000221;
const HOT_REPLY_HIDDEN: i32 = 900000236; // approved = 0（待审）⇒ 公开侧不存在
const HOT_REPLY_DELETED: i32 = 900000237; // is_deleted = 1（软删）⇒ 公开侧不存在

/// 清自己的残留（上次跑挂了会留下行）。**顺序有讲究**：票没有外键指回评论，所以票要
/// 按"文章下所有评论 id"先删——反过来（先删评论）票就成孤儿，下次跑时它们会挂在
/// **新插的同号评论**上，症状是"票数比夹具写的多"，看着像公式坏了。
async fn clear_hot_fixture(db: &DatabaseConnection) {
    exec(
        db,
        &format!(
            "DELETE FROM note_comment_vote WHERE comment_id IN \
             (SELECT id FROM note_comment WHERE note_id = {HOT_NOTE})"
        ),
    )
    .await;
    exec(
        db,
        &format!("DELETE FROM note_comment WHERE note_id = {HOT_NOTE}"),
    )
    .await;
    exec(db, &format!("DELETE FROM note WHERE id = {HOT_NOTE}")).await;
    exec(db, &format!("DELETE FROM \"user\" WHERE id = {HOT_UID}")).await;
}

/// 拉一次公开评论列表，回 `(顶层 id 顺序, 该顶层名下的回复 id 顺序)`。
///
/// **保持服务端给的顺序**（要钉排序就不能在这边再排一遍——那会把判据变成"我自己排的
/// 顺序对不对"）。顶层按 `rootId == null` 认，**不靠"数组前半段是顶层"**：那是个实现
/// 细节，哪天它变了，这里应该红而不是跟着一起变。
async fn comment_order_of(
    app: axum::Router,
    query: &str,
    root: i32,
) -> (Vec<i32>, Vec<i32>) {
    let uri = format!("/api/public/notes/{HOT_NOTE}/comments{query}");
    let (st, j) = call(app, "GET", &uri, None, None).await;
    // 未知的 `sort` 值**绝不能在 HTTP 层失败**：`Query` 抽取器遇反序列化失败会回
    // 400 + 纯文本、**不走信封**，而前端判的是 `code === 200` ⇒ 一个过期的分享链接
    // 就能把整段讨论区变成"读取失败"。所以这里连状态码一起断言。
    assert_eq!(st, StatusCode::OK, "公开评论列表不该在 HTTP 层失败（`{uri}`）：{j}");
    assert_eq!(j["code"], 200, "信封 code 必须是 200（`{uri}`）：{j}");
    let rows = j["data"]
        .as_array()
        .unwrap_or_else(|| panic!("data 不是数组（`{uri}`）：{j}"));
    let id_of = |c: &serde_json::Value| c["id"].as_i64().expect("评论行没有整数 id") as i32;
    let tops = rows.iter().filter(|c| c["rootId"].is_null()).map(id_of).collect();
    let replies = rows
        .iter()
        .filter(|c| c["rootId"].as_i64() == Some(root as i64))
        .map(id_of)
        .collect();
    (tops, replies)
}

#[tokio::test]
async fn comment_sort_hot_default_and_new_differ() {
    let Some((db, db_app)) = connect_pair().await else { return };
    clear_hot_fixture(&db).await;
    make_note(&db, HOT_NOTE).await;
    make_user(&db, HOT_UID, "user").await;

    // 四条顶层。`created_at` 刻意与"热度名次"**完全错开**（见本节的 ⚠️）：
    //   REPLY 最老（40h 前）、TOP 30h、DOWN 20h、ONE 最新（10h）
    // ⇒ new 档 = ONE, DOWN, TOP, REPLY；hot 档 = TOP, REPLY, ONE, DOWN。
    exec(
        &db,
        &format!(
            "INSERT INTO note_comment (id, note_id, user_id, content, approved, is_deleted, created_at) VALUES \
             ({HOT_CMT_REPLY}, {HOT_NOTE}, {HOT_UID}, '聊了十五条', 1, 0, NOW() - interval '40 hours'), \
             ({HOT_CMT_TOP},   {HOT_NOTE}, {HOT_UID}, '二十个赞',   1, 0, NOW() - interval '30 hours'), \
             ({HOT_CMT_DOWN},  {HOT_NOTE}, {HOT_UID}, '五个踩',     1, 0, NOW() - interval '20 hours'), \
             ({HOT_CMT_ONE},   {HOT_NOTE}, {HOT_UID}, '一个赞',     1, 0, NOW() - interval '10 hours')"
        ),
    )
    .await;

    // 十五条回复，**倒着插**：id 越大 `created_at` 越老。于是"按时间正序"读出来必然是
    // **id 严格降序**——若 ORDER BY 丢了（PG 通常按堆/插入序返回，即 id 升序），这条会红。
    // g = 15 那条挂在**另一条回复**下（`parent_id` 是回复而不是顶层）⇒ 它仍是 REPLY 名下的
    // 回复，用来钉"数的是整棵子树，不是直接回复数"。
    exec(
        &db,
        &format!(
            "INSERT INTO note_comment \
             (id, note_id, user_id, content, root_id, parent_id, approved, is_deleted, created_at) \
             SELECT {HOT_REPLY_BASE} + g - 1, {HOT_NOTE}, {HOT_UID}, '回复 ' || g, {HOT_CMT_REPLY}, \
                    CASE WHEN g = 15 THEN {HOT_REPLY_BASE} ELSE {HOT_CMT_REPLY} END, \
                    1, 0, NOW() - (g || ' minutes')::interval \
               FROM generate_series(1, 15) g"
        ),
    )
    .await;
    // 两条**不该被数进热度、也不该出现在列表里**的回复：待审 / 已软删。
    exec(
        &db,
        &format!(
            "INSERT INTO note_comment \
             (id, note_id, user_id, content, root_id, parent_id, approved, is_deleted) VALUES \
             ({HOT_REPLY_HIDDEN},  {HOT_NOTE}, {HOT_UID}, '待审的回复', {HOT_CMT_REPLY}, {HOT_CMT_REPLY}, 0, 0), \
             ({HOT_REPLY_DELETED}, {HOT_NOTE}, {HOT_UID}, '已删的回复', {HOT_CMT_REPLY}, {HOT_CMT_REPLY}, 1, 1)"
        ),
    )
    .await;

    // 票：`user_id` 全留 NULL、靠 `visitor_key` 区分（两种身份并排，见迁移文件头注）——
    // 顺带钉住"匿名票也参与热度"这个**已知且已拍板的取舍**（后果写在 comment_votes.rs 头注）。
    for (comment, key, value, n) in [
        (HOT_CMT_TOP, "hotfix-up", 1, 20),
        (HOT_CMT_TOP, "hotfix-dn", -1, 1),
        (HOT_CMT_DOWN, "hotfix-bad", -1, 5),
        (HOT_CMT_ONE, "hotfix-one", 1, 1),
    ] {
        exec(
            &db,
            &format!(
                "INSERT INTO note_comment_vote (comment_id, visitor_key, value) \
                 SELECT {comment}, '{key}-' || g, {value} FROM generate_series(1, {n}) g"
            ),
        )
        .await;
    }

    let app = test_app(db_app);

    // ── ① 缺省档 = hot（产品口径：默认「最热」）──────────────────────────────
    let (dflt, _) = comment_order_of(app.clone(), "", HOT_CMT_REPLY).await;
    assert_eq!(
        dflt,
        vec![HOT_CMT_TOP, HOT_CMT_REPLY, HOT_CMT_ONE, HOT_CMT_DOWN],
        "**不带参数**必须按热度排（0.732 / 0.495 / 0.208 / 0.026）——\
         这是「默认最热」这条口径唯一的落点，纯函数测不到它"
    );

    // ── ② `?sort=hot` 与缺省逐字相同 ────────────────────────────────────────
    let (explicit_hot, _) = comment_order_of(app.clone(), "?sort=hot", HOT_CMT_REPLY).await;
    assert_eq!(explicit_hot, dflt, "显式写 `hot` 与不写必须是同一档");

    // ── ③ ★ 未知值不 reject、不 500，**静默回落 hot** ────────────────────────
    // 这条是"过期的分享链接 / 别人手打的参数"那道防线。它红了通常不是排序坏了，
    // 而是有人把 `Option<String>` 改成了会 reject 的强类型枚举（见 `CommentListQuery`）。
    let (garbage, _) = comment_order_of(app.clone(), "?sort=zzz", HOT_CMT_REPLY).await;
    assert_eq!(garbage, dflt, "未知 sort 值必须回落 hot（且 HTTP 200 + code 200，不是 400）");

    // ── ④ `?sort=new` 是**另一个顺序**（时间降序），且与 hot 无一条同位 ──────
    let (new, replies) = comment_order_of(app.clone(), "?sort=new", HOT_CMT_REPLY).await;
    assert_eq!(
        new,
        vec![HOT_CMT_ONE, HOT_CMT_DOWN, HOT_CMT_TOP, HOT_CMT_REPLY],
        "`?sort=new` 必须按 created_at 降序（10h / 20h / 30h / 40h 前）"
    );
    for (i, (a, b)) in dflt.iter().zip(new.iter()).enumerate() {
        assert_ne!(a, b, "第 {i} 位上 hot 与 new 排到了同一条 —— 夹具失去了分辨力，改夹具");
    }

    // ── ⑤ 回复：恒时间正序，且**只含公开可见的** ─────────────────────────────
    let want_replies: Vec<i32> = (0..15).map(|i| HOT_REPLY_BASE + 14 - i).collect();
    assert_eq!(
        replies, want_replies,
        "回复必须按 created_at **正序**（夹具倒着插的 ⇒ 正序就是 id 降序）；\
         顺序不对时先看 ORDER BY 是不是被并进内存排序一起删了"
    );
    assert!(
        !replies.contains(&HOT_REPLY_HIDDEN) && !replies.contains(&HOT_REPLY_DELETED),
        "待审 / 已软删的回复在公开侧**不存在**（它们也不该进热度：数的是公开可见的回复）"
    );

    // ── ⑥ 回复确实进了热度（而不是"恰好按票排"）────────────────────────────
    // REPLY 是**零票**的，却压在"一个赞"的 ONE 前面 —— 只可能来自回复项。
    // 少了这一条，把 `hot_score` 的回复项删掉（只剩 Wilson）时，① 仍然会绿
    // ——因为 0 票的 REPLY 与 ONE 只差在回复数上，而那正是本条要钉的东西。
    let reply_pos = dflt.iter().position(|&x| x == HOT_CMT_REPLY).expect("REPLY 不在列表里");
    let one_pos = dflt.iter().position(|&x| x == HOT_CMT_ONE).expect("ONE 不在列表里");
    assert!(
        reply_pos < one_pos,
        "0 票 + 15 条回复必须压过 1 票 + 0 回复（0.495 vs 0.208）—— \
         这条红了通常意味着热度里的回复项没了"
    );

    clear_hot_fixture(&db).await;
}
