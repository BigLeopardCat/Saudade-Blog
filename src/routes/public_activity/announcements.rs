use super::{ActivityQuery, response, window};
use crate::{entity::announcement, routes::AppState, utils::ApiResponsePage};
use axum::{
    Json,
    extract::{Query, State},
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, sea_query::Expr,
};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(FromQueryResult)]
struct Row {
    id: i32,
    title: String,
    title_length: i32,
    content: String,
    content_length: i32,
    created_at: Option<chrono::NaiveDateTime>,
}

pub(super) fn query(params: &ActivityQuery) -> sea_orm::Select<announcement::Entity> {
    let mut query = announcement::Entity::find();
    if let Some(id) = params.id {
        query = query.filter(announcement::Column::Id.eq(id));
    }
    query.order_by_desc(announcement::Column::Id)
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    params: &ActivityQuery,
    limit: u64,
    offset: u64,
) -> Result<(Vec<Value>, i64), DbErr> {
    let query = query(params);
    let total = query.clone().count(db).await?;
    let cap = if params.id.is_some() { 2000 } else { 240 };
    let rows = query
        .select_only()
        .column(announcement::Column::Id)
        .column(announcement::Column::CreatedAt)
        .column_as(Expr::cust("LEFT(title,255)"), "title")
        .column_as(Expr::cust("CHAR_LENGTH(title)"), "title_length")
        .column_as(Expr::cust(format!("LEFT(content,{cap})")), "content")
        .column_as(Expr::cust("CHAR_LENGTH(content)"), "content_length")
        .limit(limit)
        .offset(offset)
        .into_model::<Row>()
        .all(db)
        .await?;
    Ok((
        rows.into_iter()
            .map(|row| {
                json!({"id":row.id,"title":row.title,
        "titleTruncated":row.title_length>255,"content":row.content,
        "contentTruncated":row.content_length>cap,"createdAt":row.created_at})
            })
            .collect(),
        total as i64,
    ))
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ActivityQuery>,
) -> Json<ApiResponsePage<Vec<Value>>> {
    let (limit, offset) = match window(&params) {
        Ok(value) => value,
        Err(error) => return Json(ApiResponsePage::error(error)),
    };
    response(read(&state.db, &params, limit, offset).await)
}
