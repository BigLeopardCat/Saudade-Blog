//! 真 MySQL 集成测（20261003）：把 `counts_for` 的四条聚合语句放到**真库**上跑一遍。
//!
//! ## 为什么非要有这一层
//!
//! 仓里原有的 `tests/api_tests.rs` 走 `MockDatabase`——它**不连接数据库、也不解码返回行**
//! （mock 返回的是我们喂进去的值，模拟不了服务端真实的类型）。于是一整类事故对它完全
//! 隐形：20260930 线上那次 500，根因是 **MySQL 的 `SUM(<整数列>)` 返回 `DECIMAL` 而不是
//! `BIGINT`**，sea-orm 按 `Option<i64>` 解码当场报
//!
//! ```text
//! mismatched types; Rust type Option<i64> (as SQL type BIGINT)
//! is not compatible with SQL type DECIMAL
//! ```
//!
//! ——`cargo check` 全绿、`cargo test`（MockDatabase）全绿，一部署就现形：文章列表卡片
//! 三个数一个都不显示、`GET /stats` 直接 500。修法是所有求和都过
//! [`sum_views`](saudade_blog::routes::note_stats) 那一手的 `CAST(... AS SIGNED)`。
//! **只有真库能把这条判据钉住**：本文件第一个用例就是"求和拿得回一个整数"，
//! 谁把那个 `cast_as` 删了，这里立刻红。
//!
//! 顺带钉住的还有三件 MockDatabase 永远证明不了的事：
//!   · `COUNT(*)`/`SUM` 在**零行**时是 NULL（`null → 0` 的折零逻辑真的走过一遍）；
//!   · 空 id 列表必须**短路**——`IN ()` 在 MySQL 里是语法错误，不短路就是一条真报错；
//!   · 讨论数的两条过滤（`approved = 1 AND is_deleted = 0`）在真 SQL 下的取舍，
//!     以及 `note_view`/`note_like`/`user_favorite` 上那几条**外键**真的能插得进去。
//!
//! ## 门控（务必看清，别把它改宽）
//!
//! · `TEST_MYSQL_URL` **没设** ⇒ 打印一行"跳过"然后返回（本地 `cargo test`、
//!   贡献者的机器上都不受影响——他们大多没有现成的库）。
//! · 设了但连不上 ⇒ **响亮失败**，绝不静默跳过。跳过的那些"绿"是这道闸唯一的敌人：
//!   CI 里库没起来（服务容器没健康、口令写错）时如果也是绿的，那它就成了一道装饰。
//! · 库必须有**结构**：`bash scripts/migration/fresh_install.sh <库名> …` 建出来的那种
//!   （CI 的 `check` job 就跑这个脚本）。缺表时第一件事是带着提示失败，而不是抛一句
//!   `Table 'x' doesn't exist` 让人猜。
//!
//! 用法（本机，库名自取；**不要指向生产库**）：
//!
//! ```bash
//! MYSQL_BIN="mysql -uroot -p" bash scripts/migration/fresh_install.sh saudade_it
//! TEST_MYSQL_URL="mysql://root:密码@127.0.0.1:3306/saudade_it" cargo test --test mysql_integration
//! ```
//!
//! ## 夹具数据用高位 id
//!
//! 四个用例各占一个 `9000000xx` 的 note id，互不干扰（`cargo test` 默认多线程并发跑）。
//! 用高位是为了**在一份不干净的开发库上也能跑**：这些 id 不会撞上任何真实文章。
//! 每个用例开头先清一遍自己的残留（上次跑挂了留下的），结尾不强制清理——残留也只影响
//! 它自己那个 id，且下次开头会清掉。

use std::time::Duration;

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use saudade_blog::routes::note_stats::counts_for;

/// 四个用例各占一个 id（见文件头注）
const NOTE_SUM: i32 = 900000001;
const NOTE_EMPTY: i32 = 900000002;
const NOTE_COMMENTS: i32 = 900000003;
const NOTE_LIKES: i32 = 900000004;

/// 打开被测库。`None` = 没设 `TEST_MYSQL_URL`（调用方直接返回，即"跳过"）。
///
/// 这里**不做 `unwrap_or_else` 之类的兜底**：环境变量在场时任何一步不成功都必须 panic
/// （见文件头注的门控那一段）。
async fn connect() -> Option<DatabaseConnection> {
    let url = match std::env::var("TEST_MYSQL_URL") {
        Ok(u) if !u.trim().is_empty() => u,
        _ => {
            eprintln!(
                "⏭  跳过：TEST_MYSQL_URL 没设（真库集成测，本地默认不跑；\
                 见 tests/mysql_integration.rs 头注）"
            );
            return None;
        }
    };
    assert!(
        url.starts_with("mysql://"),
        "TEST_MYSQL_URL 必须以 mysql:// 开头（现在拿到的是 `{}…`）。\
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
            "TEST_MYSQL_URL 在场但连不上库：{e}\n\
             这条**不是跳过、是失败**——设了这个变量就意味着这道闸必须真跑起来。"
        )
    });

    ensure_schema(&db).await;
    Some(db)
}

/// 库里的结构得像 `scripts/migration/fresh_install.sh` 建出来的那套。
/// 缺表就带着"怎么补"的提示失败，别让它退化成一个看不出前因后果的 SQL 报错。
async fn ensure_schema(db: &DatabaseConnection) {
    let want = ["note", "note_view", "note_like", "user_favorite", "note_comment"];
    let list = want.map(|t| format!("'{t}'")).join(",");
    let row = db
        .query_one(Statement::from_string(
            DbBackend::MySql,
            format!(
                "SELECT COUNT(*) FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ({list})"
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
         bash scripts/migration/fresh_install.sh <库名> [mysql 参数…]",
        want.len()
    );
}

/// 跑一条写语句（原生 SQL——这里要验的正是**真 SQL 的语义**，不走 entity 更贴近现场）。
async fn exec(db: &DatabaseConnection, sql: &str) {
    db.execute(Statement::from_string(DbBackend::MySql, sql.to_string()))
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

// ─────────────────────────────────────────────────────────────────────────────
// ① `SUM(<整数列>)` 必须拿得回一个 Rust 的 i64（DECIMAL 陷阱）
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

    let got = counts_for(&db, &[NOTE_SUM]).await.expect(
        "counts_for 报错了。**若错误里出现 `Rust type Option<i64> (as SQL type BIGINT) \
         is not compatible with SQL type DECIMAL`**，就是 sum_views 的 CAST(... AS SIGNED) \
         被删了——见 src/routes/note_stats.rs 与 tests/mysql_integration.rs 的头注",
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
// ⑤ 空 id 列表必须短路（`IN ()` 在 MySQL 里是语法错误）
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn counts_for_empty_ids_never_reaches_sql() {
    let Some(db) = connect().await else { return };
    let got = counts_for(&db, &[]).await.expect(
        "空 id 列表必须**在发 SQL 之前**短路：`WHERE note_id IN ()` 是 MySQL 语法错误，\
         真发出去就是一条 ERROR 1064",
    );
    assert!(got.is_empty(), "空进空出");
}
