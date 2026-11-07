//! Versioned public corpus export. Pages are repeatable-read snapshots;
//! subsequent keyset pages must present the same revision or receive HTTP 409.
use super::{notes::public_condition, AppState};
use crate::{entity::note, utils::ApiResponse};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    sea_query::Expr, AccessMode, ColumnTrait, EntityTrait, FromQueryResult, IsolationLevel,
    QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Default, Deserialize)]
pub struct CorpusQuery {
    pub after: Option<i32>,
    pub limit: Option<u64>,
    pub revision: Option<String>,
}
#[derive(FromQueryResult, Serialize)]
struct DigestRow {
    id: i32,
    title: String,
    content_hash: String,
    #[serde(skip_serializing)]
    content_json_bytes: i64,
}
#[derive(Serialize)]
pub struct CorpusDocument {
    id: i32,
    title: String,
    content: String,
    revision: String,
}
#[derive(Serialize)]
pub struct CorpusPage {
    schema_version: u8,
    revision: String,
    total: usize,
    documents: Vec<CorpusDocument>,
    next_cursor: Option<i32>,
}
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 12 * 1024 * 1024;

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ApiResponse::<Option<CorpusPage>> {
            code: status.as_u16() as i32,
            message: message.to_owned(),
            data: None,
        }),
    )
        .into_response()
}
fn revision(rows: &[DigestRow]) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(rows).expect("serializable corpus metadata"),
    ))
}
fn document(row: note::Model) -> CorpusDocument {
    let revision = super::document_visibility::content_revision(&row.title, &row.content);
    CorpusDocument {
        id: row.id,
        title: row.title,
        content: row.content,
        revision,
    }
}
fn selected_ids(
    rows: &[DigestRow],
    after: i32,
    limit: usize,
    page_revision: &str,
) -> Result<Vec<i32>, sea_orm::DbErr> {
    let empty = CorpusPage {
        schema_version: 1,
        revision: page_revision.to_owned(),
        total: rows.len(),
        documents: vec![],
        // Reserve the largest positive i32 cursor in the envelope.
        next_cursor: Some(i32::MAX),
    };
    let mut bytes = serde_json::to_vec(&empty)
        .expect("serializable corpus page")
        .len();
    let mut selected = Vec::new();
    for row in rows.iter().filter(|row| row.id > after).take(limit) {
        let body_bytes = usize::try_from(row.content_json_bytes)
            .map_err(|_| sea_orm::DbErr::Custom("invalid document size".into()))?;
        let empty_document = CorpusDocument {
            id: row.id,
            title: row.title.clone(),
            content: String::new(),
            revision: "0".repeat(64),
        };
        let size = serde_json::to_vec(&empty_document)
            .expect("serializable corpus document")
            .len()
            .checked_add(body_bytes)
            .and_then(|value| value.checked_sub(2))
            .ok_or_else(|| sea_orm::DbErr::Custom("invalid document size".into()))?;
        if size > MAX_DOCUMENT_BYTES {
            return Err(sea_orm::DbErr::Custom(
                "corpus document exceeds byte limit".into(),
            ));
        }
        let with_separator = size + usize::from(!selected.is_empty());
        if bytes + with_separator > MAX_PAGE_BYTES {
            break;
        }
        bytes += with_separator;
        selected.push(row.id);
    }
    Ok(selected)
}

async fn page(
    state: &AppState,
    after: i32,
    limit: u64,
    expected: Option<&str>,
) -> Result<Option<CorpusPage>, sea_orm::DbErr> {
    let tx = state
        .db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    // Hash in PostgreSQL: do not transfer every article body on every page.
    // Content edits, deletions and visibility changes all invalidate this token.
    let digests = note::Entity::find()
        .filter(public_condition())
        .select_only()
        .column(note::Column::Id)
        .column(note::Column::Title)
        .expr_as(
            Expr::cust("encode(sha256(convert_to(\"content\", 'UTF8')), 'hex')"),
            "content_hash",
        )
        .expr_as(
            Expr::cust("octet_length(to_json(\"content\")::text)::bigint"),
            "content_json_bytes",
        )
        .order_by_asc(note::Column::Id)
        .into_model::<DigestRow>()
        .all(&tx)
        .await?;
    let current = revision(&digests);
    if expected.is_some_and(|want| want != current) {
        tx.rollback().await?;
        return Ok(None);
    }
    let ids = selected_ids(&digests, after, limit as usize, &current)?;
    let rows = if ids.is_empty() {
        Vec::new()
    } else {
        note::Entity::find()
            .filter(public_condition())
            .filter(note::Column::Id.is_in(ids.clone()))
            .order_by_asc(note::Column::Id)
            .all(&tx)
            .await?
    };
    if rows.iter().map(|row| row.id).collect::<Vec<_>>() != ids {
        return Err(sea_orm::DbErr::Custom("incomplete corpus page".into()));
    }
    let next_cursor = ids
        .last()
        .copied()
        .filter(|last| digests.last().is_some_and(|row| row.id > *last));
    let result = CorpusPage {
        schema_version: 1,
        revision: current,
        total: digests.len(),
        documents: rows.into_iter().map(document).collect(),
        next_cursor,
    };
    // Recheck the actual serialized frame before it leaves this boundary.
    if serde_json::to_vec(&result)
        .expect("serializable corpus page")
        .len()
        > MAX_PAGE_BYTES
        || result.documents.iter().any(|row| {
            serde_json::to_vec(row)
                .expect("serializable corpus document")
                .len()
                > MAX_DOCUMENT_BYTES
        })
    {
        return Err(sea_orm::DbErr::Custom(
            "corpus serialized byte limit exceeded".into(),
        ));
    }
    tx.commit().await?;
    Ok(Some(result))
}
pub async fn export(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CorpusQuery>,
) -> Response {
    let after = query.after.unwrap_or(0);
    let limit = query.limit.unwrap_or(50);
    let valid_revision = query
        .revision
        .as_deref()
        .is_none_or(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()));
    if after < 0
        || !(1..=100).contains(&limit)
        || !valid_revision
        || (after > 0 && query.revision.is_none())
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid corpus cursor, limit or revision",
        );
    }
    match page(&state, after, limit, query.revision.as_deref()).await {
        Ok(Some(page)) => {
            let mut response = Json(ApiResponse::success(page)).into_response();
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            );
            response
        }
        Ok(None) => error(StatusCode::CONFLICT, "corpus_revision_changed"),
        Err(e) => {
            tracing::error!("[rag] corpus export failed: {e}");
            error(StatusCode::SERVICE_UNAVAILABLE, "corpus_unavailable")
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{rate_limiter::LoginRateLimiter, risk::PostRateLimiter};
    use sea_orm::{DatabaseBackend, DbErr, MockDatabase};
    fn state(db: sea_orm::DatabaseConnection) -> Arc<AppState> {
        Arc::new(AppState {
            db,
            rate_limiter: LoginRateLimiter::new(5, 60, 300),
            post_limiter: PostRateLimiter::new(),
            report_limiter: LoginRateLimiter::new(120, 60, 300),
        })
    }
    #[tokio::test]
    async fn rejects_unversioned_cursor_before_database_access() {
        let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        let response = export(
            State(state(db)),
            Query(CorpusQuery {
                after: Some(1),
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    #[tokio::test]
    async fn database_error_is_unavailable_not_an_empty_corpus() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors([DbErr::Custom("unavailable fixture".into())])
            .into_connection();
        let response = export(State(state(db)), Query(CorpusQuery::default())).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    #[test]
    fn byte_bounded_pages_keep_whole_documents_and_advance_the_actual_cursor() {
        let rows: Vec<DigestRow> = (1..=4)
            .map(|id| DigestRow {
                id,
                title: "正文🐈".into(),
                content_hash: "a".repeat(64),
                content_json_bytes: 3_500_000,
            })
            .collect();
        let first = selected_ids(&rows, 0, 50, &"a".repeat(64)).unwrap();
        assert_eq!(first, [1, 2, 3]);
        let last = *first.last().unwrap();
        assert_eq!(selected_ids(&rows, last, 50, &"a".repeat(64)).unwrap(), [4]);
        assert!(selected_ids(&rows, 4, 50, &"a".repeat(64))
            .unwrap()
            .is_empty());
        assert_eq!(selected_ids(&rows, 0, 2, &"a".repeat(64)).unwrap(), [1, 2]);
    }

    #[test]
    fn escaped_json_size_and_envelope_count_toward_the_document_limit() {
        let row = DigestRow {
            id: 1,
            title: "unicode🐈 \"".into(),
            content_hash: "a".repeat(64),
            content_json_bytes: MAX_DOCUMENT_BYTES as i64,
        };
        // The body alone fits; its typed envelope makes the complete document too large.
        assert!(selected_ids(&[row], 0, 50, &"a".repeat(64)).is_err());
        let escaped = "\u{0001}".repeat(800_000);
        assert!(escaped.len() < MAX_DOCUMENT_BYTES);
        assert!(serde_json::to_vec(&escaped).unwrap().len() > MAX_DOCUMENT_BYTES);
    }

    #[tokio::test]
    async fn postgres_json_projection_matches_complete_wire_document_bytes() {
        use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            eprintln!("SKIP corpus JSON size PostgreSQL: TEST_PG_URL not set");
            return;
        };
        let db = Database::connect(url)
            .await
            .expect("configured test database is reachable");
        let content = "JSON \" \\ \r\n🐈 é \u{0001}";
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT octet_length(to_json($1::text)::text)::bigint AS bytes",
                vec![content.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        let bytes: i64 = row.try_get("", "bytes").unwrap();
        assert_eq!(bytes as usize, serde_json::to_vec(content).unwrap().len());
    }

    #[test]
    fn revision_covers_content_title_and_membership() {
        let rows = || {
            vec![DigestRow {
                id: 1,
                title: "one".into(),
                content_hash: "a".into(),
                content_json_bytes: 2,
            }]
        };
        let baseline = revision(&rows());
        let mut changed = rows();
        changed[0].content_hash = "b".into();
        assert_ne!(baseline, revision(&changed));
        changed = rows();
        changed[0].title = "two".into();
        assert_ne!(baseline, revision(&changed));
        assert_ne!(baseline, revision(&[]));
    }
}
