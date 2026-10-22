//! Public activity pages expose approved text without account or moderation metadata.

pub mod announcements;
pub mod messages;

use crate::utils::ApiResponsePage;
use axum::Json;
use sea_orm::DbErr;
use serde::Deserialize;
use serde_json::Value;

#[derive(Default, Deserialize)]
pub struct ActivityQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub id: Option<i32>,
}

fn window(params: &ActivityQuery) -> Result<(u64, u64), &'static str> {
    if params.id.is_some_and(|id| id <= 0) {
        return Err("内容编号无效");
    }
    super::pagination::bounded_window(params.page, params.page_size)
}

fn response(result: Result<(Vec<Value>, i64), DbErr>) -> Json<ApiResponsePage<Vec<Value>>> {
    match result {
        Ok((items, total)) => Json(ApiResponsePage::success(items, Some(total))),
        Err(error) => {
            tracing::error!("public activity read failed: {error}");
            Json(ApiResponsePage::error("公开内容读取失败，请稍后重试"))
        }
    }
}

#[cfg(test)]
mod tests;
