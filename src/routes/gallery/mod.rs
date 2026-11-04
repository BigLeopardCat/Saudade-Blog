//! Curated image metadata; storage URLs and article references remain stable.

pub mod covers;
pub mod folders;
pub mod metadata;

use crate::{auth_jwt, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, DbErr, FromQueryResult, Statement, Value};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Default, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub image_key: i32,
    pub image_url: String,
    pub display_name: Option<String>,
    pub description: String,
    pub folder_id: i32,
    pub is_favorite: bool,
    pub version: String,
}

const SELECT: &str = "SELECT i.image_key,i.image_url,m.display_name, \
    COALESCE(m.description,'') AS description,COALESCE(m.folder_id,0) AS folder_id, \
    (f.image_id IS NOT NULL) AS is_favorite, \
    encode(sha256(convert_to(jsonb_build_array(i.image_key,i.image_url,m.display_name, \
    COALESCE(m.description,''),COALESCE(m.folder_id,0),f.image_id IS NOT NULL)::text,'UTF8')),'hex') AS version \
    FROM images i LEFT JOIN image_metadata m ON m.image_id=i.image_key \
    LEFT JOIN image_favorite f ON f.image_id=i.image_key AND f.user_id=$1";

pub(super) async fn actor(state: &AppState, headers: &HeaderMap) -> Result<i32, DbErr> {
    auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| DbErr::Custom("authentication required".into()))
}

pub(super) fn response<T: Default>(result: Result<T, DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("gallery request failed: {error}");
            Json(ApiResponse::error(
                "图库内容不存在、已变化或参数无效，请刷新后重试",
            ))
        }
    }
}

pub(super) fn valid_version(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) async fn read<C: ConnectionTrait>(db: &C, uid: i32, id: i32) -> Result<Image, DbErr> {
    Image::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!("{SELECT} WHERE i.image_key=$2"),
        vec![uid.into(), id.into()],
    ))
    .one(db)
    .await?
    .ok_or_else(|| DbErr::RecordNotFound("image missing".into()))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    pub before: Option<i32>,
    pub limit: Option<u64>,
    pub folder_id: Option<i32>,
    pub search: Option<String>,
    pub url: Option<String>,
    pub favorite: Option<bool>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Image>,
    pub next_cursor: Option<i32>,
}

pub(super) async fn page<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    q: ListQuery,
) -> Result<Page, DbErr> {
    let limit = q.limit.unwrap_or(30);
    if !(1..=100).contains(&limit)
        || q.before.is_some_and(|v| v <= 0)
        || q.folder_id.is_some_and(|v| v < 0)
        || q.search.as_ref().is_some_and(|v| v.chars().count() > 200)
    {
        return Err(DbErr::Custom("invalid gallery page".into()));
    }
    let mut sql = format!("{SELECT} WHERE true");
    let mut args: Vec<Value> = vec![uid.into()];
    if let Some(before) = q.before {
        args.push(before.into());
        sql.push_str(&format!(" AND i.image_key < ${}", args.len()));
    }
    if let Some(folder) = q.folder_id {
        args.push(folder.into());
        sql.push_str(&format!(" AND COALESCE(m.folder_id,0)=${}", args.len()));
    }
    if let Some(url) = q.url {
        if url.len() > 2048 {
            return Err(DbErr::Custom("invalid image URL".into()));
        }
        args.push(url.into());
        sql.push_str(&format!(" AND i.image_url=${}", args.len()));
    }
    if q.favorite == Some(true) {
        sql.push_str(" AND f.image_id IS NOT NULL");
    }
    if let Some(search) = q.search.filter(|v| !v.trim().is_empty()) {
        args.push(format!("%{}%", crate::search_core::like_escape(search.trim())).into());
        sql.push_str(&format!(" AND (COALESCE(m.display_name,i.image_url) ILIKE ${0} OR COALESCE(m.description,'') ILIKE ${0})", args.len()));
    }
    args.push(((limit + 1) as i64).into());
    sql.push_str(&format!(" ORDER BY i.image_key DESC LIMIT ${}", args.len()));
    let mut items = Image::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        args,
    ))
    .all(db)
    .await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    Ok(Page {
        next_cursor: if more {
            items.last().map(|v| v.image_key)
        } else {
            None
        },
        items,
    })
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Json<ApiResponse<Page>> {
    let result = async { page(&state.db, actor(&state, &headers).await?, q).await }.await;
    response(result)
}

pub async fn detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<Image>> {
    let result = async { read(&state.db, actor(&state, &headers).await?, id).await }.await;
    response(result)
}

#[cfg(test)]
mod tests;
