//! Account catalog projects only permitted fields and filters roles before counting.

use axum::{
    extract::{Query, State},
    Json,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, DerivePartialModel, EntityTrait, FromQueryResult,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{authz, entity::user, routes::AppState, utils::ApiResponsePage};

#[derive(Default, Deserialize)]
pub struct AccountQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub username: Option<String>,
    pub id: Option<i32>,
}

#[derive(DerivePartialModel, FromQueryResult)]
#[sea_orm(entity = "user::Entity")]
pub struct AccountRow {
    pub id: i32,
    pub username: String,
    pub role: String,
    pub status: i16,
    pub chat_quota_used: i32,
    pub muted_until: Option<chrono::NaiveDateTime>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i32,
    pub username: String,
    pub role: String,
    pub frozen: bool,
    pub quota_used: i32,
    pub quota_limit: i32,
    pub muted: bool,
    pub muted_until: Option<String>,
}

pub(super) fn query(params: &AccountQuery) -> sea_orm::Select<user::Entity> {
    let roles: Vec<&str> = authz::KNOWN_ROLES
        .into_iter()
        .filter(|role| authz::is_listable_role(role))
        .collect();
    let mut query = user::Entity::find().filter(user::Column::Role.is_in(roles));
    if let Some(name) = &params.username {
        query = query.filter(user::Column::Username.eq(name));
    }
    if let Some(id) = params.id {
        query = query.filter(user::Column::Id.eq(id));
    }
    query.order_by_asc(user::Column::Id)
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    params: &AccountQuery,
    limit: u64,
    offset: u64,
) -> Result<(Vec<Account>, i64), DbErr> {
    let query = query(params);
    let total = query.clone().count(db).await? as i64;
    let rows = query
        .limit(limit)
        .offset(offset)
        .into_partial_model::<AccountRow>()
        .all(db)
        .await?;
    let now = chrono::Local::now().naive_local();
    let items = rows
        .into_iter()
        .map(|row| Account {
            id: row.id,
            username: row.username,
            frozen: row.status != 0,
            quota_used: row.chat_quota_used,
            quota_limit: super::super::quota::limit_of(&row.role),
            muted: authz::is_muted(row.muted_until, now),
            muted_until: row
                .muted_until
                .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()),
            role: row.role,
        })
        .collect();
    Ok((items, total))
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AccountQuery>,
) -> Json<ApiResponsePage<Vec<Account>>> {
    if !super::valid_text(params.username.as_deref()) || params.id.is_some_and(|id| id <= 0) {
        return Json(ApiResponsePage::error("账号名或编号无效"));
    }
    let (limit, offset) = match super::window(params.page, params.page_size) {
        Ok(value) => value,
        Err(message) => return Json(ApiResponsePage::error(message)),
    };
    super::response(read(&state.db, &params, limit, offset).await)
}
