use dotenvy::dotenv;
use sea_orm::Database;
use std::env;
use std::net::SocketAddr;
use tracing_subscriber;

use saudade_blog::{create_router, AppState};

#[tokio::main]
async fn main() {
    dotenv().ok();
    tracing_subscriber::fmt::init();

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let db = Database::connect(&db_url).await.expect("Failed to connect to DB");

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
