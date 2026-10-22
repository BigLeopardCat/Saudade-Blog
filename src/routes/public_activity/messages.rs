use super::{ActivityQuery, response, window};
use crate::{entity::talk, routes::AppState, utils::ApiResponsePage};
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
    display_name: String,
    display_name_length: i32,
    created_at: chrono::NaiveDateTime,
}

pub(super) fn query(params: &ActivityQuery, source: &str) -> sea_orm::Select<talk::Entity> {
    let mut query = talk::Entity::find()
        .filter(talk::Column::Src.eq(source))
        .filter(talk::Column::Approved.eq(1));
    if let Some(id) = params.id {
        query = query.filter(talk::Column::Id.eq(id));
    }
    query
        .order_by_desc(talk::Column::CreatedAt)
        .order_by_desc(talk::Column::Id)
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    params: &ActivityQuery,
    source: &str,
    limit: u64,
    offset: u64,
) -> Result<(Vec<Value>, i64), DbErr> {
    let query = query(params, source);
    let total = query.clone().count(db).await?;
    let cap = if params.id.is_some() { 2000 } else { 240 };
    let rows = query
        .select_only()
        .column(talk::Column::Id)
        .column(talk::Column::CreatedAt)
        .column_as(Expr::cust("LEFT(COALESCE(title,''),255)"), "title")
        .column_as(
            Expr::cust("CHAR_LENGTH(COALESCE(title,''))"),
            "title_length",
        )
        .column_as(Expr::cust(format!("LEFT(content,{cap})")), "content")
        .column_as(Expr::cust("CHAR_LENGTH(content)"), "content_length")
        .column_as(Expr::cust("LEFT(author,80)"), "display_name")
        .column_as(Expr::cust("CHAR_LENGTH(author)"), "display_name_length")
        .limit(limit)
        .offset(offset)
        .into_model::<Row>()
        .all(db)
        .await?;
    Ok((
        rows.into_iter()
            .map(|row| {
                json!({"id":row.id,"source":source,"approved":1,
        "title":row.title,"titleTruncated":row.title_length>255,
        "content":row.content,"contentTruncated":row.content_length>cap,
        "displayName":row.display_name,"displayNameTruncated":row.display_name_length>80,
        "createdAt":row.created_at})
            })
            .collect(),
        total as i64,
    ))
}

async fn list(
    state: Arc<AppState>,
    params: ActivityQuery,
    source: &str,
) -> Json<ApiResponsePage<Vec<Value>>> {
    let (limit, offset) = match window(&params) {
        Ok(value) => value,
        Err(error) => return Json(ApiResponsePage::error(error)),
    };
    response(read(&state.db, &params, source, limit, offset).await)
}

pub async fn guestbook(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ActivityQuery>,
) -> Json<ApiResponsePage<Vec<Value>>> {
    list(state, params, "board").await
}

pub async fn talks(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ActivityQuery>,
) -> Json<ApiResponsePage<Vec<Value>>> {
    list(state, params, "talk").await
}
