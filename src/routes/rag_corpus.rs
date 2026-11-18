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
    AccessMode, ColumnTrait, DbBackend, DbErr, EntityTrait, FromQueryResult, IsolationLevel,
    QueryFilter, QueryOrder, QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Default, Deserialize)]
pub struct CorpusQuery {
    pub after: Option<i32>,
    pub limit: Option<u64>,
    pub revision: Option<String>,
}
#[derive(FromQueryResult)]
struct CorpusState {
    revision: String,
    document_count: i64,
}
#[derive(FromQueryResult)]
struct PageMember {
    id: i32,
    revision: String,
    escaped_text_bytes: i32,
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
fn page_length(
    candidates: &[PageMember],
    total: usize,
    limit: usize,
    page_revision: &str,
) -> Result<usize, DbErr> {
    let empty = CorpusPage {
        schema_version: 1,
        revision: page_revision.to_owned(),
        total,
        documents: vec![],
        // Reserve the largest positive i32 cursor in the envelope.
        next_cursor: Some(i32::MAX),
    };
    let mut bytes = serde_json::to_vec(&ApiResponse::success(empty))
        .expect("serializable corpus page")
        .len();
    let mut selected = 0;
    for row in candidates.iter().take(limit) {
        let text_bytes = usize::try_from(row.escaped_text_bytes)
            .map_err(|_| DbErr::Custom("invalid document size".into()))?;
        let empty_document = CorpusDocument {
            id: row.id,
            title: String::new(),
            content: String::new(),
            revision: row.revision.clone(),
        };
        let size = serde_json::to_vec(&empty_document)
            .expect("serializable corpus document")
            .len()
            + text_bytes;
        if size > MAX_DOCUMENT_BYTES {
            return Err(sea_orm::DbErr::Custom(
                "corpus document exceeds byte limit".into(),
            ));
        }
        let with_separator = size + usize::from(selected > 0);
        if bytes + with_separator > MAX_PAGE_BYTES {
            break;
        }
        bytes += with_separator;
        selected += 1;
    }
    Ok(selected)
}

async fn page(
    state: &AppState,
    after: i32,
    limit: u64,
    expected: Option<&str>,
) -> Result<Option<CorpusPage>, DbErr> {
    let tx = state
        .db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let state = CorpusState::find_by_statement(Statement::from_string(
        DbBackend::Postgres,
        "SELECT revision, document_count FROM public.rag_corpus_snapshot",
    ))
    .one(&tx)
    .await?
    .ok_or_else(|| DbErr::Custom("missing public corpus state".into()))?;
    if expected.is_some_and(|want| want != state.revision) {
        tx.rollback().await?;
        return Ok(None);
    }
    let total = usize::try_from(state.document_count)
        .map_err(|_| DbErr::Custom("invalid corpus count".into()))?;
    let candidates = PageMember::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id, encode(revision, 'hex') AS revision, escaped_text_bytes \
         FROM public.rag_corpus_document WHERE id > $1 ORDER BY id LIMIT $2",
        [after.into(), (limit as i64 + 1).into()],
    ))
    .all(&tx)
    .await?;
    let count = page_length(&candidates, total, limit as usize, &state.revision)?;
    let members = &candidates[..count];
    let next_cursor = members
        .last()
        .filter(|_| count < candidates.len())
        .map(|row| row.id);
    let rows = if members.is_empty() {
        Vec::new()
    } else {
        note::Entity::find()
            .filter(public_condition())
            .filter(note::Column::Id.is_in(members.iter().map(|row| row.id)))
            .select_only()
            .columns([note::Column::Id, note::Column::Title, note::Column::Content])
            .order_by_asc(note::Column::Id)
            .into_tuple::<(i32, String, String)>()
            .all(&tx)
            .await?
    };
    if rows
        .iter()
        .map(|row| row.0)
        .ne(members.iter().map(|row| row.id))
    {
        return Err(DbErr::Custom("incomplete corpus page".into()));
    }
    let result = CorpusPage {
        schema_version: 1,
        revision: state.revision,
        total,
        documents: rows
            .into_iter()
            .zip(members)
            .map(|((id, title, content), member)| CorpusDocument {
                id,
                title,
                content,
                revision: member.revision.clone(),
            })
            .collect(),
        next_cursor,
    };
    if result.documents.iter().any(|row| {
        serde_json::to_vec(row)
            .expect("serializable corpus document")
            .len()
            > MAX_DOCUMENT_BYTES
    }) {
        return Err(DbErr::Custom(
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
            let body = serde_json::to_vec(&ApiResponse::success(page))
                .expect("serializable corpus response");
            if body.len() > MAX_PAGE_BYTES {
                tracing::error!("[rag] corpus response exceeds byte limit");
                return error(StatusCode::SERVICE_UNAVAILABLE, "corpus_unavailable");
            }
            (
                [
                    (axum::http::header::CONTENT_TYPE, "application/json"),
                    (axum::http::header::CACHE_CONTROL, "no-store"),
                ],
                body,
            )
                .into_response()
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
        let rows: Vec<PageMember> = (1..=4)
            .map(|id| PageMember {
                id,
                revision: "b".repeat(64),
                escaped_text_bytes: 3_500_000,
            })
            .collect();
        let rev = "a".repeat(64);
        let first = page_length(&rows, 4, 50, &rev).unwrap();
        assert_eq!(first, 3);
        assert_eq!(rows[first - 1].id, 3);
        assert_eq!(page_length(&rows[first..], 4, 50, &rev).unwrap(), 1);
        assert_eq!(page_length(&[], 4, 50, &rev).unwrap(), 0);
        assert_eq!(page_length(&rows, 4, 2, &rev).unwrap(), 2);
    }

    #[test]
    fn escaped_json_size_and_envelope_count_toward_the_document_limit() {
        let row = PageMember {
            id: 1,
            revision: "a".repeat(64),
            escaped_text_bytes: MAX_DOCUMENT_BYTES as i32,
        };
        assert!(page_length(&[row], 1, 50, &"a".repeat(64)).is_err());
        let escaped = "\u{0001}".repeat(800_000);
        assert!(escaped.len() < MAX_DOCUMENT_BYTES);
        assert!(serde_json::to_vec(&escaped).unwrap().len() > MAX_DOCUMENT_BYTES);
    }

    #[tokio::test]
    async fn postgres_json_projection_matches_complete_wire_document_bytes() {
        use sea_orm::{ConnectionTrait, Database};
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            eprintln!("SKIP corpus JSON size PostgreSQL: TEST_PG_URL not set");
            return;
        };
        let db = Database::connect(url)
            .await
            .expect("configured test database is reachable");
        let title = "🐈 \"";
        let content = "JSON \" \\ \r\n🐈 é \u{0001}";
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT encode(revision, 'hex') AS revision, escaped_text_bytes \
                 FROM public.rag_corpus_entry($1, $2)",
                [title.into(), content.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        let bytes: i32 = row.try_get("", "escaped_text_bytes").unwrap();
        let revision: String = row.try_get("", "revision").unwrap();
        assert_eq!(
            bytes as usize,
            serde_json::to_vec(&(title, content)).unwrap().len() - 7
        );
        assert_eq!(
            revision,
            super::super::document_visibility::content_revision(title, content)
        );
    }
}
