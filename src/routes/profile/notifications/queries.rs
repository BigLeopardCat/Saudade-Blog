//! Scoped notification projections; pagination and matching run in PostgreSQL.

use crate::{
    entity::user_notification,
    routes::{
        profile::{visibility, NotificationDto},
        AppState,
    },
    utils::ApiResponse,
};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{
    sea_query::{extension::postgres::PgExpr, Expr},
    ColumnTrait, Condition, ConnectionTrait, DbErr, DerivePartialModel, EntityTrait,
    FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Content {
    #[serde(skip)]
    Detail,
    None,
    Preview,
    #[default]
    Full,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    #[serde(default)]
    pub unread_only: bool,
    pub query: Option<String>,
    #[serde(default)]
    pub content: Content,
}

impl ListQuery {
    fn window(&self) -> Result<(u64, u64), &'static str> {
        let (page, size) = (self.page.unwrap_or(1), self.page_size.unwrap_or(100));
        if !(1..=10000).contains(&page) || !(1..=100).contains(&size) {
            return Err("页码或条数超出范围");
        }
        if self
            .query
            .as_ref()
            .is_some_and(|q| q.trim().is_empty() || q.chars().count() > 120)
        {
            return Err("搜索词应为1至120字");
        }
        Ok((size, (page - 1) * size))
    }
}

#[derive(FromQueryResult)]
struct Row {
    id: i32,
    kind: String,
    title: String,
    content: String,
    content_truncated: bool,
    link: Option<String>,
    is_read: bool,
    created_at: chrono::NaiveDateTime,
}
impl From<Row> for NotificationDto {
    fn from(row: Row) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            title: row.title,
            content: row.content,
            content_truncated: row.content_truncated,
            link: row.link,
            is_read: row.is_read,
            created_at: row.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }
}

fn projected(
    query: sea_orm::Select<user_notification::Entity>,
    content: Content,
) -> sea_orm::Select<user_notification::Entity> {
    let cap = match content {
        Content::Detail => Some(2000),
        Content::None => Some(0),
        Content::Preview => Some(240),
        Content::Full => None,
    };
    let (body, truncated) = match cap {
        Some(0) => ("''".to_string(), "FALSE".to_string()),
        Some(cap) => (
            format!("LEFT(COALESCE(content,''),{cap})"),
            format!("CHAR_LENGTH(COALESCE(content,''))>{cap}"),
        ),
        None => ("COALESCE(content,'')".to_string(), "FALSE".to_string()),
    };
    query
        .select_only()
        .column(user_notification::Column::Id)
        .column_as(user_notification::Column::Kind, "kind")
        .column(user_notification::Column::Title)
        .expr_as(Expr::cust(body), "content")
        .expr_as(Expr::cust(truncated), "content_truncated")
        .column(user_notification::Column::Link)
        .column(user_notification::Column::IsRead)
        .column(user_notification::Column::CreatedAt)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    items: Vec<NotificationDto>,
    unread: i64,
    total: i64,
    page: u64,
    page_size: u64,
    has_more: bool,
    content_included: bool,
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    params: &ListQuery,
) -> Result<Page, DbErr> {
    let (size, offset) = params
        .window()
        .map_err(|error| DbErr::Custom(error.into()))?;
    let owned = || user_notification::Entity::find().filter(visibility::notifications(uid));
    let mut query = owned();
    if params.unread_only {
        query = query.filter(user_notification::Column::IsRead.eq(false));
    }
    if let Some(term) = &params.query {
        let pattern = format!(
            "%{}%",
            term.trim()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        query = query.filter(
            Condition::any()
                .add(Expr::col(user_notification::Column::Title).ilike(&pattern))
                .add(Expr::col(user_notification::Column::Content).ilike(&pattern)),
        );
    }
    let total = query.clone().count(db).await? as i64;
    let unread = owned()
        .filter(user_notification::Column::IsRead.eq(false))
        .count(db)
        .await? as i64;
    let rows = projected(query, params.content)
        .order_by_desc(user_notification::Column::CreatedAt)
        .order_by_desc(user_notification::Column::Id)
        .offset(offset)
        .limit(size)
        .into_model::<Row>()
        .all(db)
        .await?;
    Ok(Page {
        items: rows.into_iter().map(Into::into).collect(),
        unread,
        total,
        page: params.page.unwrap_or(1),
        page_size: size,
        has_more: offset.saturating_add(size) < total as u64,
        content_included: !matches!(params.content, Content::None),
    })
}

pub async fn list_notifications(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ListQuery>,
) -> Json<ApiResponse<Page>> {
    let uid = match crate::auth_jwt::auth_uid(&app.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    match read(&app.db, uid, &params).await {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::error!(%error,uid,"notification query failed");
            Json(ApiResponse::error("通知查询失败"))
        }
    }
}

#[derive(Default, Serialize)]
pub struct Detail {
    item: Option<NotificationDto>,
}

pub async fn notification_detail(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<Detail>> {
    let uid = match crate::auth_jwt::auth_uid(&app.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    if id <= 0 {
        return Json(ApiResponse::error("通知编号无效"));
    }
    let query = user_notification::Entity::find()
        .filter(visibility::notifications(uid))
        .filter(user_notification::Column::Id.eq(id));
    // Details remain bounded but include a reliable truncation indicator.
    let query = projected(query, Content::Detail);
    match query.into_model::<Row>().one(&app.db).await {
        Ok(value) => Json(ApiResponse::success(Detail {
            item: value.map(Into::into),
        })),
        Err(error) => {
            tracing::error!(%error,uid,id,"notification detail failed");
            Json(ApiResponse::error("通知详情查询失败"))
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateQuery {
    pub ids: Option<String>,
    #[serde(default)]
    pub unread_only: bool,
}
impl StateQuery {
    fn selected(&self) -> Result<Option<Vec<i32>>, &'static str> {
        let Some(raw) = &self.ids else {
            return Ok(None);
        };
        if self.unread_only {
            return Err("不能混合编号和全部未读范围");
        }
        let mut ids = raw
            .split(',')
            .map(str::parse::<i32>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "通知编号应为正整数")?;
        if ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| *id <= 0) {
            return Err("请指定1至100条通知");
        }
        ids.sort_unstable();
        ids.dedup();
        Ok(Some(ids))
    }
}
#[derive(DerivePartialModel, Serialize)]
#[sea_orm(entity = "user_notification::Entity", from_query_result)]
#[serde(rename_all = "camelCase")]
pub struct StateRow {
    id: i32,
    title: String,
    is_read: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadState {
    owner_user_id: i32,
    items: Vec<StateRow>,
    unread: i64,
    complete: bool,
}
pub(super) async fn read_state<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    params: &StateQuery,
) -> Result<ReadState, DbErr> {
    let mut query = user_notification::Entity::find().filter(visibility::notifications(uid));
    if let Some(ids) = params.selected().map_err(|e| DbErr::Custom(e.into()))? {
        query = query.filter(user_notification::Column::Id.is_in(ids));
    }
    if params.unread_only {
        query = query.filter(user_notification::Column::IsRead.eq(false));
    }
    let mut items = query
        .order_by_desc(user_notification::Column::CreatedAt)
        .order_by_desc(user_notification::Column::Id)
        .limit(101)
        .into_partial_model::<StateRow>()
        .all(db)
        .await?;
    let complete = items.len() <= 100;
    items.truncate(100);
    let unread = user_notification::Entity::find()
        .filter(visibility::notifications(uid))
        .filter(user_notification::Column::IsRead.eq(false))
        .count(db)
        .await? as i64;
    Ok(ReadState {
        owner_user_id: uid,
        items,
        unread,
        complete,
    })
}
pub async fn notification_state(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<StateQuery>,
) -> Json<ApiResponse<ReadState>> {
    let uid = match crate::auth_jwt::auth_uid(&app.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    match read_state(&app.db, uid, &params).await {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::error!(%error,uid,"notification state failed");
            Json(ApiResponse::error("通知状态查询失败"))
        }
    }
}
#[cfg(test)]
mod tests;
