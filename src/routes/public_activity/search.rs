//! Batch literal matching, deduplicated pagination and counts in one PostgreSQL snapshot.

use crate::{routes::AppState, utils::ApiResponse};
use axum::{extract::State, Json};
use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchQuery {
    pub keywords: Vec<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Counts {
    pub announcements: i64,
    pub board: i64,
    pub talk: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct KeywordCounts {
    pub keyword: String,
    pub total: i64,
    pub counts: Counts,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchData {
    pub keywords: Vec<String>,
    pub keyword_mode: &'static str,
    pub keyword_counts: Vec<KeywordCounts>,
    pub match_mode: &'static str,
    pub sources: [&'static str; 3],
    pub counts: Counts,
    pub total: i64,
    pub items: Vec<Value>,
    pub page: u64,
    pub page_size: u64,
    pub has_more: bool,
}

const MAX_RESULT_CHARS: usize = 7500;

impl SearchData {
    fn bounded_projection(mut self) -> Result<Self, DbErr> {
        // Match scope, counts and page membership remain unchanged; only display text shrinks.
        for content_limit in [240_usize, 120, 60, 30, 15, 0] {
            for item in &mut self.items {
                for (key, flag, limit) in [
                    ("title", "titleTruncated", content_limit / 2),
                    ("content", "contentTruncated", content_limit),
                    ("displayName", "displayNameTruncated", content_limit / 3),
                ] {
                    if let Some(text) = item.get(key).and_then(Value::as_str) {
                        if text.chars().count() > limit {
                            let visible: String = text.chars().take(limit).collect();
                            item[key] = json!(visible);
                            item[flag] = json!(true);
                        }
                    }
                }
            }
            let encoded = serde_json::to_string(&self)
                .map_err(|_| DbErr::Custom("Invalid activity search projection".into()))?;
            if encoded.chars().count() <= MAX_RESULT_CHARS {
                return Ok(self);
            }
        }
        Err(DbErr::Custom(
            "Activity search metadata exceeds the result limit".into(),
        ))
    }
}

impl SearchQuery {
    fn normalized_keywords(&self) -> Result<Vec<String>, &'static str> {
        if !(1..=8).contains(&self.keywords.len()) {
            return Err("每次检索须提供1至8个关键词");
        }
        let mut seen = HashSet::new();
        let mut keywords = Vec::new();
        for value in &self.keywords {
            let keyword = value.trim();
            if keyword.is_empty()
                || keyword.chars().count() > 128
                || value.chars().any(char::is_control)
            {
                return Err("搜索词须为1至128个字符，不含控制字符");
            }
            if seen.insert(keyword.to_lowercase()) {
                keywords.push(keyword.to_string());
            }
        }
        Ok(keywords)
    }

    fn window(&self) -> Result<(u64, u64), &'static str> {
        let window = super::super::pagination::bounded_window(self.page, self.page_size)?;
        if window.0 > 10 {
            return Err("每页最多10条");
        }
        Ok(window)
    }
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    keywords: &[String],
    limit: u64,
    offset: u64,
) -> Result<SearchData, DbErr> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            include_str!("search.sql"),
            [
                json!(keywords
                    .iter()
                    .map(|keyword| json!({
                        "keyword": keyword,
                        "pattern": format!("%{}%", crate::search_core::like_escape(keyword))
                    }))
                    .collect::<Vec<_>>())
                .into(),
                (limit as i64).into(),
                (offset as i64).into(),
            ],
        ))
        .await?;
    let mut data = SearchData {
        keywords: keywords.to_vec(),
        keyword_mode: "any",
        match_mode: "literal_case_insensitive",
        sources: ["announcements", "board", "talk"],
        page: offset / limit + 1,
        page_size: limit,
        ..Default::default()
    };
    let summary = rows
        .first()
        .ok_or_else(|| DbErr::Custom("Missing activity search totals".into()))?;
    data.counts = Counts {
        announcements: summary.try_get("", "announcements")?,
        board: summary.try_get("", "board")?,
        talk: summary.try_get("", "talk")?,
    };
    data.keyword_counts = serde_json::from_value(summary.try_get::<Value>("", "keyword_counts")?)
        .map_err(|_| DbErr::Custom("Invalid activity keyword counts".into()))?;
    for row in rows {
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
            "createdAt": created,
            "matchedKeywordIndices": row.try_get::<Value>("", "matched_keyword_indices")?});
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
    data.bounded_projection()
}

pub async fn search(
    State(state): State<Arc<AppState>>,
    Json(params): Json<SearchQuery>,
) -> Json<ApiResponse<SearchData>> {
    let keywords = match params.normalized_keywords() {
        Ok(value) => value,
        Err(message) => return Json(ApiResponse::error(message)),
    };
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
        let data = read(&tx, &keywords, limit, offset).await?;
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
