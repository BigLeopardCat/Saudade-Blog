use dotenvy::dotenv;
use sea_orm::SqlxMySqlConnector;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use std::env;
use std::net::SocketAddr;
use tracing_subscriber;

use saudade_blog::{create_router, AppState};

#[tokio::main]
async fn main() {
    dotenv().ok();
    // 日志时间统一本地 +08:00 钟面（CLAUDE.md 时区约定）——tracing 默认 UTC，
    // 与 agent 日志（systemd append 本地时间）混查时差 8 小时难对账
    tracing_subscriber::fmt()
        .with_timer(tracing_subscriber::fmt::time::ChronoLocal::rfc_3339())
        .init();

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    // sqlx 默认把 MySQL 会话时区设为 UTC（time_zone 默认 "+00:00"），
    // DEFAULT CURRENT_TIMESTAMP 会存 UTC 值——维护者直查 DB 差 8 小时。
    // 覆盖为 +08:00：所有 CURRENT_TIMESTAMP 生成本地钟面时间。
    // entity 全部用 NaiveDateTime（sea-orm DateTime），不涉时区换算，无 skew。
    let conn_opt: MySqlConnectOptions = db_url
        .parse::<MySqlConnectOptions>()
        .expect("invalid DATABASE_URL")
        .timezone(Some("+08:00".to_string()));
    let pool = MySqlPoolOptions::new()
        .connect_with(conn_opt)
        .await
        .expect("Failed to connect to DB");
    let db = SqlxMySqlConnector::from_sqlx_mysql_pool(pool);

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

    let app_state = AppState { db, rate_limiter };
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
