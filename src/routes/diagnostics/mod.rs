//! Administrator-only host diagnostics, independent of the optional Agent installation.
mod host;

use super::AppState;
use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde::Serialize;
use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::sync::Semaphore;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ServiceState {
    Running,
    Ready,
    Unavailable,
    NotConfigured,
}

#[derive(Serialize)]
struct Service {
    name: &'static str,
    state: ServiceState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    schema_version: u8,
    observed_at: String,
    scope: &'static str,
    host: host::Snapshot,
    services: Vec<Service>,
}

fn failure(status: StatusCode, reason: &'static str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(crate::utils::ApiResponse::<()>::error(reason)),
    )
        .into_response()
}

async fn database_state(state: &AppState) -> ServiceState {
    let ping = state.db.query_one(Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT 1 AS ready".to_owned(),
    ));
    match tokio::time::timeout(Duration::from_secs(1), ping).await {
        Ok(Ok(Some(row))) if matches!(row.try_get::<i32>("", "ready"), Ok(1)) => {
            ServiceState::Ready
        }
        _ => ServiceState::Unavailable,
    }
}

async fn agent_state(endpoint: Option<String>) -> ServiceState {
    let Some(url) = endpoint else {
        return ServiceState::NotConfigured;
    };
    static CLIENT: LazyLock<Result<reqwest::Client, reqwest::Error>> = LazyLock::new(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
    });
    let Ok(client) = &*CLIENT else {
        return ServiceState::Unavailable;
    };
    let Ok(mut response) = client.get(url).send().await else {
        return ServiceState::Unavailable;
    };
    if !response.status().is_success() {
        return ServiceState::Unavailable;
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 4096 => body.extend_from_slice(&chunk),
            Ok(None) => break,
            _ => return ServiceState::Unavailable,
        }
    }
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(value) if value.get("ready").and_then(|value| value.as_bool()) == Some(true) => {
            ServiceState::Ready
        }
        _ => ServiceState::Unavailable,
    }
}

pub(super) async fn read(State(state): State<Arc<AppState>>) -> Response {
    static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
    let permit = match SLOTS.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return failure(StatusCode::SERVICE_UNAVAILABLE, "diagnostics_busy"),
    };
    let host = tokio::task::spawn_blocking(move || {
        // Keep admission until the worker exits, including after an HTTP disconnect.
        let _permit = permit;
        host::collect()
    });
    let host = match tokio::time::timeout(Duration::from_secs(2), host).await {
        Ok(Ok(Ok(value))) => value,
        _ => return failure(StatusCode::SERVICE_UNAVAILABLE, "measurements_unavailable"),
    };
    let configured_agent = std::env::var("AGENT_URL").ok();
    let agent_endpoint = crate::ai_services::agent_ready_endpoint(configured_agent.as_deref());
    let (database, agent) = tokio::join!(database_state(&state), agent_state(agent_endpoint));
    let result = Diagnostics {
        schema_version: 1,
        observed_at: chrono::Utc::now().to_rfc3339(),
        scope: "blog_host",
        host,
        services: vec![
            Service {
                name: "blog",
                state: ServiceState::Running,
            },
            Service {
                name: "database",
                state: database,
            },
            Service {
                name: "agent",
                state: agent,
            },
        ],
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(crate::utils::ApiResponse::success(result)),
    )
        .into_response()
}

#[cfg(test)]
mod tests;
