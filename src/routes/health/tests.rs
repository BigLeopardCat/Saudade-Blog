use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use sea_orm::{DatabaseConnection, DbErr, MockDatabase, SqlxPostgresConnector};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tower::ServiceExt;

fn app(db: DatabaseConnection) -> Router {
    crate::routes::create_router(AppState {
        db,
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: crate::risk::PostRateLimiter::default(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

async fn probe(app: Router, path: &str, expected: StatusCode, value: Value) {
    let response = app
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), expected);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), value);
}

#[tokio::test]
async fn readiness_does_not_disclose_database_errors_or_accept_missing_ping_results() {
    let failure = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom(
            "postgres://private:password@internal/db".into(),
        )])
        .into_connection();
    probe(
        app(failure),
        "/api/health/ready",
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"ready": false}),
    )
    .await;
    let empty = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<BTreeMap<String, sea_orm::Value>>::new()])
        .into_connection();
    probe(
        app(empty),
        "/api/health/ready",
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"ready": false}),
    )
    .await;
    let unexpected_row: BTreeMap<&str, sea_orm::Value> = BTreeMap::from([("ready", 0.into())]);
    let unexpected = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![unexpected_row]])
        .into_connection();
    probe(
        app(unexpected),
        "/api/health/ready",
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"ready": false}),
    )
    .await;
}

#[tokio::test]
async fn postgres_public_health_routes_bound_pool_waits_and_keep_liveness_independent() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        assert!(std::env::var_os("CI").is_none(), "CI requires TEST_PG_URL");
        return;
    };
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&url)
        .await
        .unwrap();
    let app = app(SqlxPostgresConnector::from_sqlx_postgres_pool(pool.clone()));
    probe(
        app.clone(),
        "/api/health/ready",
        StatusCode::OK,
        json!({"ready": true}),
    )
    .await;
    let held = pool.acquire().await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        probe(
            app.clone(),
            "/api/health/live",
            StatusCode::OK,
            json!({"alive": true}),
        ),
    )
    .await
    .expect("liveness must not wait for the database");
    tokio::time::timeout(
        Duration::from_secs(5),
        probe(
            app.clone(),
            "/api/health/ready",
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"ready": false}),
        ),
    )
    .await
    .expect("readiness must time out before the ten-second pool acquisition");
    drop(held);
    probe(
        app.clone(),
        "/api/health/ready",
        StatusCode::OK,
        json!({"ready": true}),
    )
    .await;
    pool.close().await;
    probe(
        app.clone(),
        "/api/health/live",
        StatusCode::OK,
        json!({"alive": true}),
    )
    .await;
    probe(
        app,
        "/api/health/ready",
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"ready": false}),
    )
    .await;
}
