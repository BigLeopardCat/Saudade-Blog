//! Process liveness and bounded database readiness, without optional service dependencies.
use super::AppState;
use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde::Serialize;
use std::{sync::Arc, time::Duration};

const DATABASE_TIMEOUT: Duration = Duration::from_secs(2);

fn response<T: Serialize>(status: StatusCode, body: T) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

pub(super) async fn live() -> Response {
    response(StatusCode::OK, serde_json::json!({"alive": true}))
}

pub(super) async fn ready(State(state): State<Arc<AppState>>) -> Response {
    let ping = state.db.query_one(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT 1 AS ready".to_owned(),
    ));
    let ready = match tokio::time::timeout(DATABASE_TIMEOUT, ping).await {
        Ok(Ok(Some(row))) => matches!(row.try_get::<i32>("", "ready"), Ok(1)),
        Ok(_) | Err(_) => false,
    };
    response(
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        serde_json::json!({"ready": ready}),
    )
}

#[cfg(test)]
mod tests;
