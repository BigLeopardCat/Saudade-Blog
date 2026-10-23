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
    let revision = hex::encode(Sha256::digest(
        serde_json::to_vec(&(&row.title, &row.content)).expect("serializable article"),
    ));
    CorpusDocument {
        id: row.id,
        title: row.title,
        content: row.content,
        revision,
    }
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
        .order_by_asc(note::Column::Id)
        .into_model::<DigestRow>()
        .all(&tx)
        .await?;
    let current = revision(&digests);
    if expected.is_some_and(|want| want != current) {
        tx.rollback().await?;
        return Ok(None);
    }
    let mut rows = note::Entity::find()
        .filter(public_condition())
        .filter(note::Column::Id.gt(after))
        .order_by_asc(note::Column::Id)
        .limit(limit + 1)
        .all(&tx)
        .await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|n| n.id)
    } else {
        None
    };
    let result = CorpusPage {
        schema_version: 1,
        revision: current,
        total: digests.len(),
        documents: rows.into_iter().map(document).collect(),
        next_cursor,
    };
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
    fn revision_covers_content_title_and_membership() {
        let rows = || {
            vec![DigestRow {
                id: 1,
                title: "one".into(),
                content_hash: "a".into(),
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
