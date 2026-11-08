//! Curated image metadata; storage URLs and article references remain stable.

pub mod actions;
pub mod covers;
pub(crate) mod deletions;
pub mod folder_actions;
pub mod folders;
pub mod metadata;
pub mod storage;
pub mod transfers;
pub(crate) mod references;

use crate::{auth_jwt, routes::AppState, utils::ApiResponse};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, DbErr, FromQueryResult, Statement, Value};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Default, FromQueryResult, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub image_key: i32,
    pub image_url: String,
    #[serde(default)]
    pub storage: String,
    #[serde(default)]
    pub storage_path: String,
    pub display_name: Option<String>,
    pub description: String,
    pub folder_id: i32,
    pub folder_name: Option<String>,
    pub folder_parent_id: Option<i32>,
    pub is_favorite: bool,
    pub version: String,
}

const SELECT: &str = "SELECT i.image_key,i.image_url,m.display_name, \
    COALESCE(l.location->>'storage',CASE WHEN i.image_url LIKE '/api/protect/download/%' THEN 'local' ELSE 'r2' END) AS storage, \
    COALESCE(l.location->>'key',i.image_url) AS storage_path, \
    COALESCE(m.description,'') AS description,COALESCE(m.folder_id,0) AS folder_id, \
    g.name AS folder_name,g.parent_id AS folder_parent_id, \
    (f.image_id IS NOT NULL) AS is_favorite, \
    encode(sha256(convert_to(jsonb_build_array(i.image_key,i.image_url,m.display_name, \
    COALESCE(m.description,''),COALESCE(m.folder_id,0),f.image_id IS NOT NULL,l.location)::text,'UTF8')),'hex') AS version \
    FROM images i LEFT JOIN image_location l ON l.image_id=i.image_key LEFT JOIN image_metadata m ON m.image_id=i.image_key \
    LEFT JOIN image_folder g ON g.id=m.folder_id \
    LEFT JOIN image_favorite f ON f.image_id=i.image_key AND f.user_id=$1";

pub(crate) async fn actor(state: &AppState, headers: &HeaderMap) -> Result<i32, DbErr> {
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

pub(crate) async fn read<C: ConnectionTrait>(db: &C, uid: i32, id: i32) -> Result<Image, DbErr> {
    Image::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!("{SELECT} WHERE i.image_key=$2 AND NOT EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=i.image_key)"),
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
    pub storage: Option<storage::Kind>,
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
    let mut sql = format!(
        "{SELECT} WHERE NOT EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=i.image_key)"
    );
    let mut args: Vec<Value> = vec![uid.into()];
    if let Some(before) = q.before {
        args.push(before.into());
        sql.push_str(&format!(" AND i.image_key < ${}", args.len()));
    }
    if let Some(folder) = q.folder_id {
        args.push(folder.into());
        sql.push_str(&format!(" AND COALESCE(m.folder_id,0)=${}", args.len()));
    }
    if let Some(storage) = q.storage {
        args.push(storage.as_str().into());
        sql.push_str(&format!(" AND COALESCE(l.location->>'storage',CASE WHEN i.image_url LIKE '/api/protect/download/%' THEN 'local' ELSE 'r2' END)=${}", args.len()));
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

pub(super) fn placeholders(start: usize, count: usize) -> String {
    (start..start + count)
        .map(|i| format!("${i}"))
        .collect::<Vec<_>>()
        .join(",")
}

pub fn start_cleanup(db: sea_orm::DatabaseConnection) {
    deletions::start(db);
}
pub fn stop_cleanup() {
    deletions::stop();
}

pub(crate) async fn is_retired_url<C: ConnectionTrait>(db: &C, url: &str) -> Result<bool, DbErr> {
    Ok(db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT 1 FROM image_deletion WHERE image_url=$1 LIMIT 1",
            [url.into()],
        ))
        .await?
        .is_some())
}

fn valid_url(url: &str) -> bool {
    if url.is_empty() || url.len() > 2048 || url.chars().any(char::is_control) {
        return false;
    }
    if let Some(name) = url.strip_prefix("/api/protect/download/") {
        return deletions::safe_filename(name);
    }
    reqwest::Url::parse(url).is_ok_and(|value| {
        matches!(value.scheme(), "http" | "https")
            && value.has_host()
            && value.username().is_empty()
            && value.password().is_none()
            && value.query().is_none()
            && value.fragment().is_none()
    })
}

async fn register(
    db: &sea_orm::DatabaseConnection,
    url: &str,
    name: Option<&str>,
) -> Result<i32, DbErr> {
    use sea_orm::TransactionTrait;
    if !valid_url(url)
        || name.is_some_and(|name| {
            name.trim().is_empty()
                || name.chars().count() > 255
                || name.chars().any(char::is_control)
        })
    {
        return Err(DbErr::Custom("invalid gallery image identity".into()));
    }
    let txn = db
        .begin_with_config(Some(sea_orm::IsolationLevel::ReadCommitted), None)
        .await?;
    references::fence(&txn, true).await?;
    // Serialize same-URL registration without blocking unrelated uploads or holding I/O in the transaction.
    txn.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [url.into(), 0x53415544494d47_i64.into()],
    ))
    .await?;
    if is_retired_url(&txn, url).await? {
        return Err(DbErr::Custom("image storage URL is retired".into()));
    }
    let row=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT image_key FROM images WHERE image_url=$1 OR image_key IN (SELECT image_id FROM image_location WHERE source_url=$1) ORDER BY image_key LIMIT 1 FOR UPDATE",[url.into()])).await?;
    let id = if let Some(row) = row {
        row.try_get::<i32>("", "image_key")?
    } else {
        txn.query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO images(image_url) VALUES($1) RETURNING image_key",
            [url.into()],
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("image registration missing".into()))?
        .try_get("", "image_key")?
    };
    if let Some(name) = name {
        txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO image_metadata(image_id,display_name) VALUES($1,$2) ON CONFLICT(image_id) \
             DO UPDATE SET display_name=COALESCE(image_metadata.display_name,EXCLUDED.display_name)",
            [id.into(),name.into()])).await?;
    }
    let current=read(&txn,0,id).await?;
    if current.image_url!=storage::media_url(id) {
        let location=storage::resolve(&txn,&current).await?;
        transfers::publish::bind(&txn,id,&current.image_url,&location,true).await?;
    }
    txn.commit().await?;
    Ok(id)
}

pub(crate) async fn register_image(
    db: &sea_orm::DatabaseConnection,
    url: &str,
) -> Result<i32, DbErr> {
    register(db, url, None).await
}
pub(crate) async fn register_named_image(
    db: &sea_orm::DatabaseConnection,
    url: &str,
    name: &str,
) -> Result<i32, DbErr> {
    register(db, url, Some(name)).await
}
