//! Public aggregate search. Visibility comes from the article read policy; board
//! signatures and comment parent titles are never indexed as searchable titles.
//! The database counts and ranks matches before paging; full bodies stay in PG.
use crate::{
    entity::note,
    routes::{db_error, AppState},
    utils::ApiResponse,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    ConnectionTrait, DbBackend, EntityTrait, QueryFilter, QuerySelect, QueryTrait, Statement,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;

mod terms;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchAllRequest {
    #[serde(default)]
    pub keyword: Option<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    #[serde(rename = "type")]
    pub kind: Option<SearchType>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchType {
    Note,
    Talk,
    Board,
    Comment,
}
impl SearchType {
    fn name(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Talk => "talk",
            Self::Board => "board",
            Self::Comment => "comment",
        }
    }
}
#[derive(Serialize, Default)]
pub struct SearchCounts {
    pub note: usize,
    pub talk: usize,
    pub board: usize,
    pub comment: usize,
}
#[derive(Serialize)]
pub struct SearchHit {
    #[serde(rename = "type")]
    pub kind: String,
    pub key: i32,
    pub title: String,
    pub snippet: String,
    pub author: String,
    #[serde(rename = "noteId")]
    pub note_id: Option<i32>,
    #[serde(rename = "createTime")]
    pub create_time: String,
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchAllData {
    pub total: usize,
    pub counts: SearchCounts,
    pub notes: Vec<SearchHit>,
    pub talks: Vec<SearchHit>,
    pub board: Vec<SearchHit>,
    pub comments: Vec<SearchHit>,
    pub page: u64,
    pub page_size: u64,
    pub has_more: bool,
    pub terms: Vec<String>,
}

fn page_window(payload: &SearchAllRequest) -> Result<(u64, u64), &'static str> {
    let page = payload.page.unwrap_or(1);
    let size = payload.page_size.unwrap_or(20);
    if !(1..=100).contains(&page) || !(1..=50).contains(&size) {
        return Err("搜索页码须为 1–100，每页须为 1–50 条");
    }
    Ok((page, size))
}
fn failure(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(ApiResponse::<SearchAllData>::error(&message.into())),
    )
        .into_response()
}

pub async fn search_all(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SearchAllRequest>,
) -> Response {
    let (page, size) = match page_window(&payload) {
        Ok(value) => value,
        Err(message) => return failure(StatusCode::BAD_REQUEST, message),
    };
    let keyword = payload.keyword.as_deref().unwrap_or("").trim();
    if keyword.chars().count() > 128 || keyword.len() > 512 {
        return failure(StatusCode::BAD_REQUEST, "搜索词最多 128 个字符");
    }
    if keyword.is_empty() {
        return Json(ApiResponse::success(SearchAllData {
            page,
            page_size: size,
            ..Default::default()
        }))
        .into_response();
    }
    static LIMITER: OnceLock<crate::rate_limiter::LoginRateLimiter> = OnceLock::new();
    let ip = super::auth::get_client_ip(&headers);
    if ip.len() > 128
        || LIMITER
            .get_or_init(|| crate::rate_limiter::LoginRateLimiter::new(120, 60, 30))
            .hit(&ip, "aggregate-search")
            .is_err()
    {
        return failure(StatusCode::TOO_MANY_REQUESTS, "搜索过于频繁，请稍后再试");
    }
    static SLOTS: Semaphore = Semaphore::const_new(4);
    let Ok(_permit) = SLOTS.try_acquire() else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "搜索繁忙，请稍后重试");
    };
    // Dictionary initialization/segmentation cannot block an async runtime worker.
    let keyword = keyword.to_string();
    let task = async {
        let query = keyword.clone();
        let terms = tokio::task::spawn_blocking(move || terms::tokenize(&query))
            .await
            .map_err(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "搜索暂时不可用，请重试"))?
            .map_err(|message| failure(StatusCode::BAD_REQUEST, message))?;
        if terms.is_empty() {
            return Ok(SearchAllData {
                page,
                page_size: size,
                ..Default::default()
            });
        }
        let filter = payload.kind.map(SearchType::name).unwrap_or("all");
        read(&state.db, &keyword, terms, filter, page, size)
            .await
            .map_err(|error| db_error::<SearchAllData>("聚合搜索", &error).into_response())
    };
    match tokio::time::timeout(Duration::from_secs(4), task).await {
        Ok(Ok(data)) => Json(ApiResponse::success(data)).into_response(),
        Ok(Err(response)) => response,
        Err(_) => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "搜索超时，请缩短搜索词后重试",
        ),
    }
}

async fn read(
    db: &sea_orm::DatabaseConnection,
    keyword: &str,
    terms: Vec<String>,
    filter: &str,
    page: u64,
    size: u64,
) -> Result<SearchAllData, sea_orm::DbErr> {
    let visible = note::Entity::find()
        .select_only()
        .columns([note::Column::Id, note::Column::Title])
        .filter(super::notes::public_condition())
        .build(DbBackend::Postgres)
        .to_string();
    // Only framework-generated SQL is substituted. Every user value is bound.
    let sql = include_str!("search/query.sql").replace("{visible_notes}", &visible);
    let tx = db.begin().await?;
    tx.execute_unprepared("SET TRANSACTION READ ONLY").await?;
    tx.execute_unprepared("SET LOCAL statement_timeout = '2500ms'")
        .await?;
    tx.execute_unprepared("SET LOCAL work_mem = '4MB'").await?;
    let rows = tx
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [
                serde_json::to_string(&terms)
                    .expect("string array serialization")
                    .into(),
                filter.to_string().into(),
                (size as i64).into(),
                (((page - 1) * size) as i64).into(),
                keyword.to_lowercase().into(),
            ],
        ))
        .await?;
    let mut data = SearchAllData {
        page,
        page_size: size,
        terms,
        ..Default::default()
    };
    for row in rows {
        data.counts = SearchCounts {
            note: row.try_get::<i64>("", "notes")? as usize,
            talk: row.try_get::<i64>("", "talks")? as usize,
            board: row.try_get::<i64>("", "board")? as usize,
            comment: row.try_get::<i64>("", "comments")? as usize,
        };
        let Some(key) = row.try_get::<Option<i32>>("", "id")? else {
            continue;
        };
        let kind: String = row.try_get("", "kind")?;
        let hit = SearchHit {
            kind: kind.clone(),
            key,
            title: row.try_get("", "title")?,
            snippet: crate::search_core::snippet(&row.try_get::<String>("", "excerpt")?, 164),
            author: row.try_get("", "author")?,
            note_id: row.try_get("", "note_id")?,
            create_time: row
                .try_get::<chrono::NaiveDateTime>("", "created_at")?
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        };
        match kind.as_str() {
            "note" => data.notes.push(hit),
            "talk" => data.talks.push(hit),
            "board" => data.board.push(hit),
            "comment" => data.comments.push(hit),
            _ => unreachable!("SQL fixes the search types"),
        }
    }
    tx.commit().await?;
    data.total = data.counts.note + data.counts.talk + data.counts.board + data.counts.comment;
    let available = match filter {
        "note" => data.counts.note,
        "talk" => data.counts.talk,
        "board" => data.counts.board,
        "comment" => data.counts.comment,
        _ => data.total,
    };
    data.has_more = (page * size) < available as u64;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_are_explicit_not_silently_truncated() {
        let request = |page, page_size| SearchAllRequest {
            keyword: None,
            page,
            page_size,
            kind: None,
        };
        assert_eq!(page_window(&request(None, None)), Ok((1, 20)));
        for (page, size) in [(0, 20), (101, 20), (1, 0), (1, 51)] {
            assert!(page_window(&request(Some(page), Some(size))).is_err());
        }
    }
}
