//! Public, revision-bound original text reads.
mod metadata;
mod sections;

use crate::{
    entity::{announcement, note, talk},
    routes::AppState,
    utils::ApiResponse,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    AccessMode, ColumnTrait, ConnectionTrait, EntityTrait, IsolationLevel, QueryFilter,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::Semaphore;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Note,
    Talk,
    Board,
    Announcement,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum View {
    #[default]
    Body,
    Outline,
    Metadata,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadQuery {
    #[serde(default)]
    pub view: View,
    pub section: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub revision: Option<String>,
    pub section_schema: Option<String>,
}

use super::document_visibility::content_revision;

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

struct Document {
    kind: Kind,
    id: i32,
    title: String,
    body: String,
    metadata: Value,
}

async fn document<C: ConnectionTrait>(
    db: &C,
    kind: Kind,
    id: i32,
) -> Result<Option<Document>, sea_orm::DbErr> {
    let result = match kind {
        Kind::Note => {
            let Some(row) = note::Entity::find_by_id(id)
                .filter(super::notes::public_condition())
                .one(db)
                .await?
            else {
                return Ok(None);
            };
            let (mut metadata, _) = super::catalog::articles::read_public(
                db,
                &super::catalog::articles::ArticleQuery {
                    id: Some(id),
                    ..Default::default()
                },
                1,
                0,
                false,
            )
            .await?;
            let Some(metadata) = metadata.pop() else {
                return Ok(None);
            };
            let mut metadata =
                serde_json::to_value(metadata).expect("serializable article metadata");
            let extra = metadata::article(db, &row).await?;
            if let (Value::Object(target), Value::Object(extra)) = (&mut metadata, extra) {
                target.extend(extra);
            }
            Document {
                kind,
                id,
                title: row.title,
                body: row.content,
                metadata,
            }
        }
        Kind::Talk | Kind::Board => {
            let source = if kind == Kind::Talk { "talk" } else { "board" };
            let Some(row) = talk::Entity::find_by_id(id)
                .filter(talk::Column::Src.eq(source))
                .filter(talk::Column::Approved.eq(1))
                .one(db)
                .await?
            else {
                return Ok(None);
            };
            Document {
                kind,
                id,
                title: if kind == Kind::Talk {
                    row.title.unwrap_or_default()
                } else {
                    String::new()
                },
                body: row.content,
                metadata: json!({"approved": 1, "createdAt": row.created_at}),
            }
        }
        Kind::Announcement => {
            let Some(row) = announcement::Entity::find_by_id(id).one(db).await? else {
                return Ok(None);
            };
            Document {
                kind,
                id,
                title: row.title,
                body: row.content,
                metadata: json!({"createdAt": row.created_at}),
            }
        }
    };
    Ok(Some(result))
}

fn validate_range(query: &ReadQuery) -> Result<(), (StatusCode, &'static str)> {
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(12000);
    let section = query.section.as_deref().unwrap_or("");
    if query.view == View::Metadata && (offset != 0 || !section.is_empty() || query.limit.is_some())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "metadata does not select body ranges",
        ));
    }
    if query.view == View::Outline && !section.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "outline does not select a body section",
        ));
    }
    let locator = offset > 0 || (section.starts_with('s') && section[1..].parse::<usize>().is_ok());
    if !(1..=24000).contains(&limit) || offset > i32::MAX as usize || section.chars().count() > 1024
    {
        return Err((StatusCode::BAD_REQUEST, "invalid document range"));
    }
    if locator
        && (query.revision.as_deref().unwrap_or("").is_empty()
            || query.section_schema.as_deref().unwrap_or("").is_empty())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "continuation requires revision and section_schema",
        ));
    }
    if query.revision.as_ref().is_some_and(|value| {
        value.len() != 64
            || !value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }) {
        return Err((StatusCode::BAD_REQUEST, "invalid content revision"));
    }
    if query
        .section_schema
        .as_ref()
        .is_some_and(|value| value.len() > 128)
    {
        return Err((StatusCode::BAD_REQUEST, "invalid section schema"));
    }
    Ok(())
}

fn frame(doc: Document, query: ReadQuery) -> Result<Value, (StatusCode, &'static str)> {
    validate_range(&query)?;
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(12000);
    let section = query.section.as_deref().unwrap_or("");
    let revision = content_revision(&doc.title, &doc.body);
    if query
        .revision
        .as_ref()
        .is_some_and(|want| want != &revision)
        || query
            .section_schema
            .as_deref()
            .is_some_and(|want| want != sections::SCHEMA)
    {
        return Err((
            StatusCode::CONFLICT,
            "document or section view changed; read again",
        ));
    }
    if doc.body.len() > 4 * 1024 * 1024 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "document exceeds read limit"));
    }
    if query.view == View::Metadata {
        return Ok(
            json!({"view":"metadata","type":doc.kind,"id":doc.id,"title":doc.title,
            "content":"","metadata":doc.metadata,"contentRevision":revision,
            "sectionSchema":sections::SCHEMA,"readOffset":0,"nextOffset":null,
            "totalChars":0,"readComplete":false,"sections":[],"sectionCount":0,
            "sectionsOffset":0,"nextSectionsOffset":null,"source":null}),
        );
    }
    let rows = sections::outline(&doc.body, &doc.title);
    let section_count = rows.iter().filter(|s| s.level > 0).count();
    let section_offset = if query.view == View::Outline {
        offset
    } else {
        0
    };
    if section_offset > section_count {
        return Err((StatusCode::BAD_REQUEST, "offset exceeds section directory"));
    }
    let available: Vec<Value> = rows.iter().filter(|s| s.level > 0).skip(section_offset).take(12)
        .map(|s| json!({"id":s.id,"title":s.title.chars().take(200).collect::<String>(),
                       "path":s.path.iter().map(|v| v.chars().take(200).collect::<String>()).collect::<Vec<_>>()})).collect();
    let section_end = section_offset + available.len();
    let next_section_offset = (section_end < section_count).then_some(section_end);
    if query.view == View::Outline {
        return Ok(
            json!({"view":"outline","type":doc.kind,"id":doc.id,"title":doc.title,
            "content":"","metadata":{},"contentRevision":revision,"sectionSchema":sections::SCHEMA,
            "readOffset":0,"nextOffset":null,"totalChars":doc.body.chars().count(),
            "readComplete":false,"sections":available,"sectionCount":section_count,
            "sectionsOffset":section_offset,"nextSectionsOffset":next_section_offset,
            "source":null}),
        );
    }
    let (selected_body, selected) = if section.is_empty() {
        (doc.body.as_str(), None)
    } else if let Some(index) = sections::select(&rows, section) {
        let end = sections::scope_end(&rows, index);
        let has_body = rows[index..=end]
            .iter()
            .any(|row| !doc.body[row.byte_start..row.byte_end].trim().is_empty());
        (
            if has_body {
                &doc.body[rows[index].byte_start..rows[end].byte_end]
            } else {
                ""
            },
            Some(&rows[index]),
        )
    } else {
        return Ok(
            json!({"view":"body","type":doc.kind,"id":doc.id,"title":doc.title,"content":"",
            "contentRevision":revision,"sectionSchema":sections::SCHEMA,"sections":available,
            "sectionCount":section_count,"sectionsOffset":0,"nextSectionsOffset":next_section_offset,
            "readSection":section,
            "readOffset":0,"nextOffset":null,"totalChars":0,"readComplete":false,
            "source":null,"note":"Section missing or ambiguous; choose an explicit section ID."}),
        );
    };
    let length = selected_body.chars().count();
    if offset > length {
        return Err((StatusCode::BAD_REQUEST, "offset exceeds selected content"));
    }
    let end = (offset + limit).min(length);
    let body: String = selected_body
        .chars()
        .skip(offset)
        .take(end - offset)
        .collect();
    Ok(
        json!({"view":"body","type":doc.kind,"id":doc.id,"title":doc.title,"content":body,
        "metadata":doc.metadata,"contentRevision":revision,"sectionSchema":sections::SCHEMA,
        "readOffset":offset,"nextOffset":if end < length {Some(end)} else {None},
        "totalChars":length,"readComplete":end==length,"sections":available,
        "sectionCount":section_count,"sectionsOffset":0,"nextSectionsOffset":next_section_offset,
        "readSection":selected.map(|s| s.title.chars().take(200).collect::<String>()),
        "source":{"type":doc.kind,"id":doc.id,"revision":revision,"section_schema":sections::SCHEMA,
                  "section_id":selected.map(|s|s.id.as_str()).unwrap_or(""),"offset":offset,"end":end}}),
    )
}

pub async fn read(
    State(state): State<Arc<AppState>>,
    Path((kind, id)): Path<(Kind, i32)>,
    Query(query): Query<ReadQuery>,
) -> Response {
    if id <= 0 {
        return error(StatusCode::BAD_REQUEST, "invalid document ID");
    }
    if let Err((status, message)) = validate_range(&query) {
        return error(status, message);
    }
    static READS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let Ok(permit) = READS
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
    else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "document reads busy");
    };
    let worker = tokio::spawn(async move {
        // Admission follows database/parsing completion, not the HTTP connection lifetime.
        let _permit = permit;
        let tx = tokio::time::timeout(
            Duration::from_secs(1),
            state.db.begin_with_config(
                Some(IsolationLevel::RepeatableRead),
                Some(AccessMode::ReadOnly),
            ),
        )
        .await
        .map_err(|_| sea_orm::DbErr::Custom("document database wait timed out".into()))??;
        tx.execute_unprepared("SET LOCAL statement_timeout = '2000ms'")
            .await?;
        let doc = document(&tx, kind, id).await?;
        tx.commit().await?;
        let Some(doc) = doc else {
            return Ok(Err((StatusCode::NOT_FOUND, "public document not found")));
        };
        tokio::task::spawn_blocking(move || frame(doc, query))
            .await
            .map_err(|err| sea_orm::DbErr::Custom(format!("document parser failed: {err}")))
    });
    match tokio::time::timeout(Duration::from_secs(3), worker).await {
        Ok(Ok(Ok(Ok(value)))) => {
            let mut response = Json(ApiResponse::success(value)).into_response();
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            );
            response
        }
        Ok(Ok(Ok(Err((status, message))))) => error(status, message),
        Ok(Ok(Err(err))) => {
            tracing::warn!(error=%err,"document read database unavailable");
            error(StatusCode::SERVICE_UNAVAILABLE, "document read unavailable")
        }
        Ok(Err(err)) => {
            tracing::warn!(error=%err,"document read worker failed");
            error(StatusCode::SERVICE_UNAVAILABLE, "document read unavailable")
        }
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "document read timed out"),
    }
}

#[cfg(test)]
mod tests;
