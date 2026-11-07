//! Validate corpus candidates without transferring titles or bodies out of PostgreSQL.
use crate::{entity::note, routes::AppState, utils::ApiResponse};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter,
    QuerySelect, TransactionTrait,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, OnceLock},
    time::Duration,
};

pub(crate) const CONTENT_HASH: &str = "encode(sha256(convert_to('[' || to_json(\"title\")::text || ',' || to_json(\"content\")::text || ']', 'UTF8')), 'hex')";
#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentType {
    Note,
}

pub(crate) fn content_revision(title: &str, body: &str) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(&(title, body)).expect("serializable text"),
    ))
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ApiResponse::<Value> {
            code: status.as_u16() as i32,
            message: message.into(),
            data: Value::Null,
        }),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub documents: Vec<Input>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    #[serde(rename = "type")]
    pub kind: DocumentType,
    pub id: i32,
    pub revision: String,
}
#[derive(FromQueryResult)]
struct Visible {
    id: i32,
    revision: String,
}

pub(super) fn identities(input: &[Input]) -> Result<Vec<i32>, &'static str> {
    if input.len() > 256
        || input.iter().any(|row| {
            row.kind != DocumentType::Note
                || row.id <= 0
                || row.revision.len() != 64
                || !row
                    .revision
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
    {
        return Err("invalid document validation request");
    }
    let ids: Vec<i32> = input
        .iter()
        .map(|row| row.id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.len() > 64 {
        return Err("at most 64 distinct documents can be validated");
    }
    Ok(ids)
}

pub(super) async fn current<C: ConnectionTrait>(
    db: &C,
    ids: &[i32],
) -> Result<Value, sea_orm::DbErr> {
    let visible: BTreeMap<i32, String> = if ids.is_empty() {
        BTreeMap::new()
    } else {
        note::Entity::find()
            .filter(super::notes::public_condition())
            .filter(note::Column::Id.is_in(ids.to_vec()))
            .select_only()
            .column(note::Column::Id)
            .column_as(Expr::cust(CONTENT_HASH), "revision")
            .into_model::<Visible>()
            .all(db)
            .await?
            .into_iter()
            .map(|row| (row.id, row.revision))
            .collect()
    };
    Ok(
        json!({"schemaVersion":1,"documents":ids.iter().map(|id|json!({"type":"note","id":id,
        "visible":visible.contains_key(id),"contentRevision":visible.get(id)})).collect::<Vec<_>>()}),
    )
}

fn reserve(slots: &Arc<Semaphore>) -> Result<OwnedSemaphorePermit, Response> {
    slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "document validation busy"))
}

async fn read_current(
    state: Arc<AppState>,
    ids: Vec<i32>,
    permit: OwnedSemaphorePermit,
) -> Result<Value, sea_orm::DbErr> {
    // The worker owns admission until its transaction finishes, even after HTTP disconnects.
    let _permit = permit;
    let tx = tokio::time::timeout(Duration::from_secs(1), state.db.begin())
        .await
        .map_err(|_| sea_orm::DbErr::Custom("document database wait timed out".into()))??;
    tx.execute_unprepared("SET TRANSACTION READ ONLY").await?;
    tx.execute_unprepared("SET LOCAL statement_timeout = '2000ms'")
        .await?;
    let data = current(&tx, &ids).await?;
    tx.commit().await?;
    Ok(data)
}

pub async fn validate(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Request>,
) -> Response {
    let ids = match identities(&request.documents) {
        Ok(ids) => ids,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    if ids.is_empty() {
        return Json(ApiResponse::success(json!({"schemaVersion":1,
        "documents":[]})))
        .into_response();
    }
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let permit = match reserve(SLOTS.get_or_init(|| Arc::new(Semaphore::new(4)))) {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    let worker = tokio::spawn(read_current(state, ids, permit));
    match tokio::time::timeout(Duration::from_secs(3), worker).await {
        Ok(Ok(Ok(value))) => Json(ApiResponse::success(value)).into_response(),
        Ok(Ok(Err(err))) => {
            tracing::warn!(error=%err, "document visibility database unavailable");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "document visibility unavailable",
            )
        }
        Ok(Err(err)) => {
            tracing::warn!(error=%err, "document visibility worker failed");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "document visibility unavailable",
            )
        }
        Err(_) => {
            tracing::warn!("document validation response deadline exceeded");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "document validation timed out",
            )
        }
    }
}

#[cfg(test)]
mod tests;
