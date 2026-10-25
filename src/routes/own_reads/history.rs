use crate::{
    entity::{chat_history, conversation},
    routes::AppState,
    utils::ApiResponse,
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub conversation_id: i32,
    pub before_id: Option<i32>,
    pub message_id: Option<i32>,
    pub content_offset: Option<i32>,
    pub limit: Option<u64>,
}

#[derive(FromQueryResult)]
struct Row {
    id: i32,
    role: String,
    content: String,
    content_length: i32,
    created_at: chrono::NaiveDateTime,
}

pub(super) fn query(uid: i32, params: &HistoryQuery) -> sea_orm::Select<chat_history::Entity> {
    let mut query = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(params.conversation_id));
    if let Some(before) = params.before_id {
        query = query.filter(chat_history::Column::Id.lt(before));
    }
    if let Some(id) = params.message_id {
        query = query.filter(chat_history::Column::Id.eq(id));
    }
    query.order_by_desc(chat_history::Column::Id)
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    params: &HistoryQuery,
    limit: u64,
) -> Result<Value, DbErr> {
    if !valid(params, limit) {
        return Err(DbErr::Custom("invalid history range".into()));
    }
    let offset = params.content_offset.unwrap_or(0);
    let owned = conversation::Entity::find()
        .select_only()
        .column(conversation::Column::Id)
        .filter(conversation::Column::Id.eq(params.conversation_id))
        .filter(conversation::Column::UserId.eq(uid))
        .into_tuple::<i32>()
        .one(db)
        .await?;
    if owned.is_none() {
        return Err(DbErr::RecordNotFound("conversation unavailable".into()));
    }
    let cap = if params.message_id.is_some() {
        2000
    } else {
        300
    };
    let mut rows = query(uid, params)
        .limit(limit + 1)
        .select_only()
        .columns([
            chat_history::Column::Id,
            chat_history::Column::Role,
            chat_history::Column::CreatedAt,
        ])
        .column_as(
            Expr::cust_with_values(
                "SUBSTRING(\"chat_history\".\"content\" FROM $1 FOR $2)",
                [offset + 1, cap],
            ),
            "content",
        )
        .column_as(
            Expr::cust("CHAR_LENGTH(\"chat_history\".\"content\")"),
            "content_length",
        )
        .into_model::<Row>()
        .all(db)
        .await?;
    let has_more = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    let next = if has_more {
        rows.last().map(|row| row.id)
    } else {
        None
    };
    let mut items = Vec::new();
    for row in rows.into_iter().rev() {
        if row.role != "user" && row.role != "assistant" {
            return Err(DbErr::Custom("unknown message role".into()));
        }
        if offset > row.content_length {
            return Err(DbErr::Custom(
                "history offset exceeds content length".into(),
            ));
        }
        let end = offset + row.content.chars().count() as i32;
        let next_offset = (end < row.content_length).then_some(end);
        items.push(json!({"id":row.id,"role":row.role,"content":row.content,
                         "contentTruncated":offset>0 || next_offset.is_some(),
                         "contentOffset":offset,"contentLength":row.content_length,
                         "nextContentOffset":next_offset,"createdAt":row.created_at}));
    }
    Ok(
        json!({"ownerId":uid,"conversationId":params.conversation_id,"items":items,
              "hasMore":has_more,"nextBeforeId":next,"includesImages":false}),
    )
}

fn valid(params: &HistoryQuery, limit: u64) -> bool {
    params.conversation_id > 0
        && (1..=10).contains(&limit)
        && params.before_id.is_none_or(|id| id > 0)
        && params.message_id.is_none_or(|id| id > 0)
        && !(params.before_id.is_some() && params.message_id.is_some())
        && params
            .content_offset
            .is_none_or(|offset| params.message_id.is_some() && (0..i32::MAX).contains(&offset))
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HistoryQuery>,
) -> Json<ApiResponse<Value>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let limit = params.limit.unwrap_or(5);
    if !valid(&params, limit) {
        return Json(ApiResponse::error("会话、消息或读取范围无效"));
    }
    let limit = if params.message_id.is_some() {
        1
    } else {
        limit
    };
    match read(&state.db, uid, &params, limit).await {
        Ok(data) => Json(ApiResponse::success(data)),
        Err(e) => {
            tracing::error!("own history failed uid={uid}: {e}");
            Json(ApiResponse::error("会话不可访问或消息读取失败"))
        }
    }
}
