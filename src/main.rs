use dotenvy::dotenv;
use sea_orm::SqlxPostgresConnector;
use std::env;
use std::net::SocketAddr;

use saudade_blog::{create_router, AppState};

#[tokio::main]
async fn main() {
    dotenv().ok();
    saudade_blog::observability::init();

    saudade_blog::auth_jwt::secret::validate(env::var("JWT_SECRET").ok().as_deref()).expect(
        "JWT_SECRET must be a private random key of at least 32 bytes, not a template value",
    );

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = saudade_blog::database::connect(&db_url)
        .await
        .expect("Failed to connect to DB");
    let db = SqlxPostgresConnector::from_sqlx_postgres_pool(pool.clone());

    // Login rate limits apply before password verification.
    let max_attempts = env::var("LOGIN_MAX_ATTEMPTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let window_secs = env::var("LOGIN_WINDOW_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    let lockout_secs = env::var("LOGIN_LOCKOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(900);
    let rate_limiter =
        saudade_blog::rate_limiter::LoginRateLimiter::new(max_attempts, window_secs, lockout_secs);

    let post_limiter = saudade_blog::risk::PostRateLimiter::new();

    let report_max = env::var("MONITOR_REPORT_MAX")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);
    let report_window_secs = env::var("MONITOR_REPORT_WINDOW_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let report_lockout_secs = env::var("MONITOR_REPORT_LOCKOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    let report_limiter = saudade_blog::rate_limiter::LoginRateLimiter::new(
        report_max,
        report_window_secs,
        report_lockout_secs,
    );

    saudade_blog::routes::gallery::start_cleanup(db.clone());
    saudade_blog::checkpoint_cleanup::start(SqlxPostgresConnector::from_sqlx_postgres_pool(pool));
    let app_state = AppState {
        db,
        rate_limiter,
        post_limiter,
        report_limiter,
    };
    let app = create_router(app_state);

    let port = env::var("BLOG_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(3000);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(service = "saudade-blog", pid = std::process::id(), address = %addr,
        event = "service_started", "HTTP server ready");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    saudade_blog::lifecycle::serve(
        listener,
        app,
        saudade_blog::lifecycle::task_tracker(),
        async {
            saudade_blog::lifecycle::shutdown_signal().await;
            saudade_blog::routes::image_generation::stop_accepting();
            saudade_blog::routes::gallery::stop_cleanup();
        },
    )
    .await
    .unwrap();
}
