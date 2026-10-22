//! Bounded administrator catalogs; legacy editor and account APIs remain separate.

pub mod accounts;
pub mod articles;

use crate::utils::ApiResponsePage;
use axum::Json;

pub use super::pagination::bounded_window as window;

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
