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
    QuerySelect,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
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

pub async fn validate(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Request>,
) -> Response {
    let ids = match identities(&request.documents) {
        Ok(ids) => ids,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    match current(&state.db, &ids).await {
        Ok(value) => Json(ApiResponse::success(value)).into_response(),
        Err(err) => {
            tracing::warn!("document visibility failed: {err}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "document visibility unavailable",
            )
        }
    }
}

#[cfg(test)]
mod tests;
