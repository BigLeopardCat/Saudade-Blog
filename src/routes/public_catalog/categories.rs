use crate::{
    entity::{category, note},
    routes::AppState,
    utils::ApiResponsePage,
};
use axum::{
    extract::{Query, State},
    Json,
};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

#[derive(Default, Deserialize)]
pub struct CategoryQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i32,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub path_name: Option<String>,
    #[sea_orm(skip)]
    pub public_article_count: i64,
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    limit: u64,
    offset: u64,
) -> Result<(Vec<Category>, i64), DbErr> {
    let total = category::Entity::find().count(db).await? as i64;
    let mut items = category::Entity::find()
        .select_only()
        .columns([
            category::Column::Id,
            category::Column::Name,
            category::Column::Color,
            category::Column::Icon,
            category::Column::PathName,
        ])
        .order_by_asc(category::Column::Id)
        .limit(limit)
        .offset(offset)
        .into_model::<Category>()
        .all(db)
        .await?;
    let ids: Vec<i32> = items.iter().map(|row| row.id).collect();
    if !ids.is_empty() {
        let counts: HashMap<Option<i32>, i64> = super::visible_notes()
            .select_only()
            .column(note::Column::CategoryId)
            .column_as(Expr::col(note::Column::Id).count(), "count")
            .filter(note::Column::CategoryId.is_in(ids))
            .group_by(note::Column::CategoryId)
            .into_tuple::<(Option<i32>, i64)>()
            .all(db)
            .await?
            .into_iter()
            .collect();
        for row in &mut items {
            row.public_article_count = counts.get(&Some(row.id)).copied().unwrap_or(0);
        }
    }
    Ok((items, total))
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CategoryQuery>,
) -> Json<ApiResponsePage<Vec<Category>>> {
    let (limit, offset) =
        match super::super::pagination::bounded_window(params.page, params.page_size) {
            Ok(value) => value,
            Err(message) => return Json(ApiResponsePage::error(message)),
        };
    super::response(read(&state.db, limit, offset).await)
}
