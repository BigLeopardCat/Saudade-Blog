//! Bounded public metadata. Counts and articles share the publication boundary.

pub mod categories;
pub mod tags;

use crate::{
    entity::note,
    routes::{
        catalog::articles::{Article, ArticleQuery},
        AppState,
    },
    utils::ApiResponsePage,
};
use axum::{
    extract::{Query, State},
    Json,
};
use sea_orm::{DbErr, EntityTrait, QueryFilter};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Default, Deserialize)]
pub struct ListQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub category_id: Option<i32>,
    pub top_only: Option<bool>,
}

pub(super) fn visible_notes() -> sea_orm::Select<note::Entity> {
    note::Entity::find().filter(super::notes::public_condition())
}

pub async fn articles(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListQuery>,
) -> Json<ApiResponsePage<Vec<Article>>> {
    if params.category_id.is_some_and(|id| id <= 0) {
        return Json(ApiResponsePage::error("分类编号无效"));
    }
    let (limit, offset) = match super::pagination::bounded_window(params.page, params.page_size) {
        Ok(value) => value,
        Err(message) => return Json(ApiResponsePage::error(message)),
    };
    let filter = ArticleQuery {
        category_id: params.category_id,
        ..Default::default()
    };
    response(
        super::catalog::articles::read_public(
            &state.db,
            &filter,
            limit,
            offset,
            params.top_only.unwrap_or(false),
        )
        .await,
    )
}

fn response<T: Default>(result: Result<(T, i64), DbErr>) -> Json<ApiResponsePage<T>> {
    match result {
        Ok((items, total)) => Json(ApiResponsePage::success(items, Some(total))),
        Err(error) => {
            tracing::error!("public catalog read failed: {error}");
            Json(ApiResponsePage::error("公开资料读取失败，请稍后重试"))
        }
    }
}

#[cfg(test)]
mod tests;
