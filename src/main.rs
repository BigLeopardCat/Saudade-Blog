use dotenvy::dotenv;
use sea_orm::SqlxPostgresConnector;
use std::env;
use std::net::SocketAddr;

use saudade_blog::{create_router, AppState};

#[tokio::main]
async fn main() {
    dotenv().ok();
    saudade_blog::observability::init();

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = saudade_blog::database::connect(&db_url)
        .await
        .expect("Failed to connect to DB");
    let db = SqlxPostgresConnector::from_sqlx_postgres_pool(pool.clone());

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

    saudade_blog::checkpoint_cleanup::start(SqlxPostgresConnector::from_sqlx_postgres_pool(pool));
    let app_state = AppState { db, rate_limiter, post_limiter, report_limiter };
    let app = create_router(app_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    tracing::info!(service = "saudade-blog", pid = std::process::id(), address = %addr,
        event = "service_started", "HTTP server ready");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
