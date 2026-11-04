//! Literal full-text filtering and per-source totals in one PostgreSQL snapshot.

use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    Json,
    extract::{Query, State},
};
use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub keyword: String,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

#[derive(Default, Serialize)]
pub struct Counts {
    pub announcements: i64,
    pub board: i64,
    pub talk: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchData {
    pub keyword: String,
    pub match_mode: &'static str,
    pub sources: [&'static str; 3],
    pub counts: Counts,
    pub total: i64,
    pub items: Vec<Value>,
    pub page: u64,
    pub page_size: u64,
    pub has_more: bool,
}

impl SearchQuery {
    fn window(&self) -> Result<(u64, u64), &'static str> {
        let keyword = self.keyword.trim();
        if keyword.is_empty()
            || keyword.chars().count() > 128
            || keyword.chars().any(char::is_control)
        {
            return Err("搜索词须为1至128个字符，不含控制字符");
        }
        let window = super::super::pagination::bounded_window(self.page, self.page_size)?;
        if window.0 > 10 {
            return Err("每页最多10条");
        }
        Ok(window)
    }
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    keyword: &str,
    limit: u64,
    offset: u64,
) -> Result<SearchData, DbErr> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            include_str!("search.sql"),
            [
                format!("%{}%", crate::search_core::like_escape(keyword)).into(),
                (limit as i64).into(),
                (offset as i64).into(),
                keyword.into(),
            ],
        ))
        .await?;
    let mut data = SearchData {
        keyword: keyword.into(),
        match_mode: "literal_case_insensitive",
        sources: ["announcements", "board", "talk"],
        page: offset / limit + 1,
        page_size: limit,
        ..Default::default()
    };
    for row in rows {
        data.counts = Counts {
            announcements: row.try_get("", "announcements")?,
            board: row.try_get("", "board")?,
            talk: row.try_get("", "talk")?,
        };
        let Some(id) = row.try_get::<Option<i32>>("", "id")? else {
            continue;
        };
        let source: String = row.try_get("", "source")?;
        let created: Option<chrono::NaiveDateTime> = row.try_get("", "created_at")?;
        let mut item = json!({"id": id, "source": source,
            "title": row.try_get::<String>("", "title")?,
            "titleTruncated": row.try_get::<bool>("", "title_truncated")?,
            "content": row.try_get::<String>("", "content")?,
            "contentTruncated": row.try_get::<bool>("", "content_truncated")?,
            "createdAt": created});
        if source != "announcements" {
            item["approved"] = json!(1);
            item["displayName"] = json!(row.try_get::<String>("", "display_name")?);
            item["displayNameTruncated"] =
                json!(row.try_get::<bool>("", "display_name_truncated")?);
        }
        data.items.push(item);
    }
    data.total = data.counts.announcements + data.counts.board + data.counts.talk;
    data.has_more = offset + (data.items.len() as u64) < data.total as u64;
    Ok(data)
}

pub async fn search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQuery>,
) -> Json<ApiResponse<SearchData>> {
    let (limit, offset) = match params.window() {
        Ok(value) => value,
        Err(message) => return Json(ApiResponse::error(message)),
    };
    static SLOTS: Semaphore = Semaphore::const_new(4);
    let Ok(_permit) = SLOTS.try_acquire() else {
        return Json(ApiResponse::error("公开检索繁忙，请稍后重试"));
    };
    let task = async {
        let tx = state.db.begin().await?;
        tx.execute_unprepared("SET TRANSACTION READ ONLY").await?;
        tx.execute_unprepared("SET LOCAL statement_timeout = '2000ms'")
            .await?;
        let data = read(&tx, params.keyword.trim(), limit, offset).await?;
        tx.commit().await?;
        Ok::<_, DbErr>(data)
    };
    match tokio::time::timeout(Duration::from_secs(3), task).await {
        Ok(Ok(data)) => Json(ApiResponse::success(data)),
        Ok(Err(error)) => super::super::db_error("公开活动检索", &error),
        Err(_) => Json(ApiResponse::error("公开检索超时，请稍后重试")),
    }
}

#[cfg(test)]
mod tests;
