use dotenvy::dotenv;
use sea_orm::SqlxPostgresConnector;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::env;
use std::net::SocketAddr;
use tracing_subscriber;

use saudade_blog::{create_router, AppState};

#[tokio::main]
async fn main() {
    dotenv().ok();
    // 日志时间统一本地 +08:00 钟面（CLAUDE.md 时区约定）——tracing 默认 UTC，
    // 与 agent 日志（systemd append 本地时间）混查时差 8 小时难对账。
    // with_ansi(false)：文件日志不输出 ANSI 转义（[2m/[32m/[0m 着色序列）——
    // fmt 默认开启，落文件是噪音（干扰 grep、降低 logrotate 压缩率）
    tracing_subscriber::fmt()
        // 20260830：rfc_3339（纳秒精度 + T 分隔 + +08:00 后缀）在文件里与长字段
        // 混排显得"糊"——改自定义格式：空格分隔 + 毫秒，与 agent 日志
        // （2026-08-30 11:48:39 | server | INFO）视觉对齐、易 grep 对账
        .with_timer(tracing_subscriber::fmt::time::ChronoLocal::new("%Y-%m-%d %H:%M:%S%.3f".to_string()))
        .with_ansi(false)
        .init();

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    // 20261018 生产库 MySQL → PostgreSQL。时区那一格**必须在这里显式钉住**：
    // 切库前这段靠 `MySqlConnectOptions::timezone()` 把会话时区设成 +08:00（sqlx 的
    // MySQL 默认是 "+00:00"，会让 DEFAULT CURRENT_TIMESTAMP 存 UTC 值、维护者直查差 8 小时），
    // 而 **`PgConnectOptions` 没有 `.timezone()` 这个方法**——两侧 API 不对称，照搬编译不过。
    // PG 的等价物是启动参数 `-c timezone=...`，经 `options()` 传。
    //
    // 库级也设了一份（`0000_schema.sql` 的 `ALTER DATABASE … SET timezone TO 'Asia/Shanghai'`），
    // 新连接本来就会继承——这里再钉一遍**不是冗余**：`CURRENT_TIMESTAMP`/`now()` 返回
    // `timestamptz`，写进无时区的 `timestamp` 列时按**会话时区**折算。会话时区一变，
    // 全站时间戳集体偏 8 小时，而且**不会有任何报错**（正是本仓最贵的那类坏法）。
    // 库级与连接级各自独立生效，两处同源是有意的。
    // entity 全部用 NaiveDateTime（sea-orm DateTime），不涉时区换算，无 skew。
    let conn_opt: PgConnectOptions = db_url
        .parse::<PgConnectOptions>()
        .expect("invalid DATABASE_URL")
        .options([("timezone", "Asia/Shanghai")]);
    let pool = PgPoolOptions::new()
        .connect_with(conn_opt)
        .await
        .expect("Failed to connect to DB");
    let db = SqlxPostgresConnector::from_sqlx_postgres_pool(pool);

    // H2 修复：登录限流器 —— 密码错误 5 次/5 分钟窗口，锁定 15 分钟
    let max_attempts = env::var("LOGIN_MAX_ATTEMPTS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(5);
    let window_secs = env::var("LOGIN_WINDOW_SECS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    let lockout_secs = env::var("LOGIN_LOCKOUT_SECS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(900);
    let rate_limiter = saudade_blog::rate_limiter::LoginRateLimiter::new(
        max_attempts, window_secs, lockout_secs,
    );

    // 内容风控的最小间隔刹车（20261002）：阈值不在启动期读——它住 `web_info`，
    // 每个发帖请求现读现用，管理员改了不必重启（见 `risk::load_config`）。
    // 这里只把计数器建出来。
    let post_limiter = saudade_blog::risk::PostRateLimiter::new();

    // 错误上报的计数闸（20261015）：`/api/monitor/log` 匿名可写、每条都开-写-关一次日志
    // 文件，此前只有"body ≤ 8KB"与"60 秒同 key 去重"两道——**去重只合并显示，不挡写入**，
    // 于是同一个 IP 能无限刷真实落盘的行。阈值刻意比登录宽得多（正常访客一页报几十条
    // 是常事，宁漏勿误伤真实报错），且可经环境变量调，误伤了不必改代码重部署。
    let report_max = env::var("MONITOR_REPORT_MAX")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(120);
    let report_window_secs = env::var("MONITOR_REPORT_WINDOW_SECS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    let report_lockout_secs = env::var("MONITOR_REPORT_LOCKOUT_SECS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    let report_limiter = saudade_blog::rate_limiter::LoginRateLimiter::new(
        report_max, report_window_secs, report_lockout_secs,
    );

    let app_state = AppState { db, rate_limiter, post_limiter, report_limiter };
    let app = create_router(app_state);

    let items = vec![
        "Public Notes", "Search", "Categories", "Tag1", "Tag2", "Friends", 
        "WebInfo", "UserInfo", "SocialInfo", "Talks"
    ];
    println!("Server starting... exposing endpoints for: {:?}", items);

    // 仅监听本机回环（A9 修复）：nginx 已 proxy_pass 127.0.0.1:3000，公网一律走 443 反代，避免明文 JWT 被嗅探
    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    println!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
