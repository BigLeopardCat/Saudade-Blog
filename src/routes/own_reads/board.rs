use crate::{
    entity::talk,
    routes::{moderation::ReviewStatus, AppState},
    utils::ApiResponse,
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Default, Deserialize)]
pub struct BoardQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub id: Option<i32>,
    pub status: Option<ReviewStatus>,
}

#[derive(FromQueryResult)]
struct Row {
    id: i32,
    content: String,
    content_length: i32,
    author: String,
    approved: i16,
    reject_reason: Option<String>,
    created_at: chrono::NaiveDateTime,
}

pub(super) fn query(uid: i32, params: &BoardQuery) -> sea_orm::Select<talk::Entity> {
    let mut query = talk::Entity::find()
        .filter(talk::Column::UserId.eq(uid))
        .filter(talk::Column::Src.eq("board"));
    if let Some(id) = params.id {
        query = query.filter(talk::Column::Id.eq(id));
    }
    if let Some(status) = params.status {
        query = query.filter(talk::Column::Approved.eq(status.approved()));
    }
    query
        .order_by_desc(talk::Column::CreatedAt)
        .order_by_desc(talk::Column::Id)
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    params: &BoardQuery,
    limit: u64,
    offset: u64,
) -> Result<Value, DbErr> {
    let query = query(uid, params);
    let total = query.clone().count(db).await?;
    let cap = if params.id.is_some() { 2000 } else { 240 };
    let rows = query
        .limit(limit)
        .offset(offset)
        .select_only()
        .columns([
            talk::Column::Id,
            talk::Column::Author,
            talk::Column::Approved,
            talk::Column::RejectReason,
            talk::Column::CreatedAt,
        ])
        .column_as(
            Expr::cust(format!("LEFT(\"talk\".\"content\", {cap})")),
            "content",
        )
        .column_as(
            Expr::cust("CHAR_LENGTH(\"talk\".\"content\")"),
            "content_length",
        )
        .into_model::<Row>()
        .all(db)
        .await?;
    let mut items = Vec::new();
    for row in rows {
        let status = match row.approved {
            0 => "pending",
            1 => "passed",
            2 => "rejected",
            _ => return Err(DbErr::Custom("unknown board status".into())),
        };
        items.push(
            json!({"id":row.id,"ownerId":uid,"displayName":row.author,"status":status,
            "content":row.content,"contentTruncated":row.content_length>cap,
            "rejectReason":row.reject_reason,"createdAt":row.created_at}),
        );
    }
    Ok(
        json!({"ownerId":uid,"items":items,"total":total,"page":params.page.unwrap_or(1),
              "pageSize":limit,"hasMore":offset + (items.len() as u64) < total}),
    )
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<BoardQuery>,
) -> Json<ApiResponse<Value>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if params.id.is_some_and(|id| id <= 0) {
        return Json(ApiResponse::error("留言编号无效"));
    }
    let (limit, offset) =
        match super::super::pagination::bounded_window(params.page, params.page_size) {
            Ok(value) => value,
            Err(e) => return Json(ApiResponse::error(e)),
        };
    match read(&state.db, uid, &params, limit, offset).await {
        Ok(data) => Json(ApiResponse::success(data)),
        Err(e) => {
            tracing::error!("own board failed uid={uid}: {e}");
            Json(ApiResponse::error("本人留言读取失败，请稍后重试"))
        }
    }
}
