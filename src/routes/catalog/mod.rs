//! Bounded administrator catalogs; legacy editor and account APIs remain separate.

pub mod accounts;
pub mod articles;

use crate::utils::ApiResponsePage;
use axum::Json;

pub fn window(page: Option<u64>, size: Option<u64>) -> Result<(u64, u64), &'static str> {
    super::pagination::window(Some(page.unwrap_or(1)), Some(size.unwrap_or(5)))?
        .ok_or("分页参数缺失")
}

pub fn pattern(value: &str) -> String {
    format!(
        "%{}%",
        value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

pub fn valid_text(value: Option<&str>) -> bool {
    value.is_none_or(|s| !s.trim().is_empty() && s.chars().count() <= 100)
}

fn response<T: Default>(result: Result<(T, i64), sea_orm::DbErr>) -> Json<ApiResponsePage<T>> {
    match result {
        Ok((items, total)) => Json(ApiResponsePage::success(items, Some(total))),
        Err(error) => {
            tracing::error!("administrator catalog failed: {error}");
            Json(ApiResponsePage::error("读取失败，请核对筛选条件或稍后重试"))
        }
    }
}

#[cfg(test)]
mod tests;
