//! Current-user favorite relationships and atomic mutation facts.

use super::FavoriteDto;
use crate::{
    entity::{note, user_favorite},
    routes::AppState,
    utils::ApiResponse,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

pub async fn list_favorites(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<FavoriteDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let favs = match user_favorite::Entity::find()
        .filter(user_favorite::Column::UserId.eq(uid))
        .order_by_desc(user_favorite::Column::CreatedAt)
        .order_by_desc(user_favorite::Column::Id)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[profile] 收藏列表查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    if favs.is_empty() {
        return Json(ApiResponse::success(vec![]));
    }
    let ids: Vec<i32> = favs.iter().map(|f| f.note_id).collect();
    let notes = match note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .column(note::Column::Title)
        .column(note::Column::Status)
        .column(note::Column::IsPublic)
        .filter(note::Column::Id.is_in(ids))
        .filter(crate::routes::notes::public_condition())
        .into_tuple::<(i32, String, Option<String>, bool)>()
        .all(&state.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, uid, "favorite metadata read failed");
            return Json(ApiResponse::error("收藏文章读取失败，请稍后重试"));
        }
    };
    let mut by_id: HashMap<i32, (String, Option<String>, bool)> = notes
        .into_iter()
        .map(|(id, title, status, is_public)| (id, (title, status, is_public)))
        .collect();
    let dtos = favs
        .into_iter()
        // 文章被隐藏/转草稿/删掉的不再列出（删掉的连行都没了，这里管的是"还在但不公开"）
        .filter_map(|f| {
            let (title, status, is_public) = by_id.remove(&f.note_id)?;
            if !is_public || !matches!(status.as_deref(), Some("public") | Some("published")) {
                return None;
            }
            Some(FavoriteDto {
                note_id: f.note_id,
                title,
                status: status.unwrap_or_else(|| "published".to_string()),
                created_at: f.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
            })
        })
        .collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteRequest {
    pub note_id: i32,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteState {
    pub owner_user_id: i32,
    pub note_id: i32,
    pub is_favorite: bool,
    pub article_available: bool,
    pub title: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteMutation {
    pub owner_user_id: i32,
    pub note_id: i32,
    pub is_favorite: bool,
    pub changed: bool,
}

fn statement(sql: &str, uid: i32, note_id: i32) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, [uid.into(), note_id.into()])
}

async fn exists<C: ConnectionTrait>(db: &C, uid: i32, note_id: i32) -> Result<bool, DbErr> {
    let row = db
        .query_one(statement(
            "SELECT EXISTS(SELECT 1 FROM user_favorite WHERE user_id=$1 AND note_id=$2) AS present",
            uid,
            note_id,
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("收藏状态缺失".into()))?;
    row.try_get("", "present")
}

pub(super) async fn state<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    note_id: i32,
) -> Result<FavoriteState, DbErr> {
    if note_id <= 0 {
        return Err(DbErr::Custom("文章编号无效".into()));
    }
    let is_favorite = exists(db, uid, note_id).await?;
    // Hidden and absent articles reveal the same metadata, even for existing favorites.
    let title = note::Entity::find_by_id(note_id)
        .filter(crate::routes::notes::public_condition())
        .select_only()
        .column(note::Column::Title)
        .into_tuple::<String>()
        .one(db)
        .await?;
    Ok(FavoriteState {
        owner_user_id: uid,
        note_id,
        is_favorite,
        article_available: title.is_some(),
        title,
    })
}

pub async fn favorite_state(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
) -> Json<ApiResponse<FavoriteState>> {
    let uid = match crate::auth_jwt::auth_uid(&app.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    match state(&app.db, uid, note_id).await {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::error!(%error, uid, note_id, "favorite state failed");
            Json(ApiResponse::error("无法核对收藏状态，请稍后重试"))
        }
    }
}

pub(super) async fn add_in<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    note_id: i32,
) -> Result<FavoriteMutation, DbErr> {
    if note_id <= 0 {
        return Err(DbErr::Custom("文章编号无效".into()));
    }
    // Keep publication eligibility stable until this short transaction commits.
    let visible = note::Entity::find_by_id(note_id)
        .filter(crate::routes::notes::public_condition())
        .select_only()
        .column(note::Column::Id)
        .lock_shared()
        .into_tuple::<i32>()
        .one(db)
        .await?;
    if visible.is_none() {
        return Err(DbErr::Custom("文章不可见，无法收藏".into()));
    }
    let inserted = db
        .query_one(statement(
            "INSERT INTO user_favorite(user_id,note_id) VALUES($1,$2) \
         ON CONFLICT(user_id,note_id) DO NOTHING RETURNING note_id",
            uid,
            note_id,
        ))
        .await?;
    let changed = inserted.is_some();
    if !changed && !exists(db, uid, note_id).await? {
        return Err(DbErr::Custom("收藏状态已变化，请重新核对".into()));
    }
    Ok(FavoriteMutation {
        owner_user_id: uid,
        note_id,
        is_favorite: true,
        changed,
    })
}

pub(super) async fn remove_in<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    note_id: i32,
) -> Result<FavoriteMutation, DbErr> {
    if note_id <= 0 {
        return Err(DbErr::Custom("文章编号无效".into()));
    }
    let removed = db
        .query_one(statement(
            "DELETE FROM user_favorite WHERE user_id=$1 AND note_id=$2 RETURNING note_id",
            uid,
            note_id,
        ))
        .await?;
    Ok(FavoriteMutation {
        owner_user_id: uid,
        note_id,
        is_favorite: false,
        changed: removed.is_some(),
    })
}

pub async fn add_favorite(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<FavoriteRequest>,
) -> Json<ApiResponse<FavoriteMutation>> {
    let uid = match crate::auth_jwt::auth_uid(&app.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    let outcome = async {
        let tx = app.db.begin().await?;
        let result = add_in(&tx, uid, request.note_id).await?;
        tx.commit().await?;
        Ok::<_, DbErr>(result)
    }
    .await;
    match outcome {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::error!(%error, uid, "favorite add failed");
            Json(ApiResponse::error("无法确认收藏结果，请查询收藏状态"))
        }
    }
}

pub async fn remove_favorite(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
) -> Json<ApiResponse<FavoriteMutation>> {
    let uid = match crate::auth_jwt::auth_uid(&app.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    match remove_in(&app.db, uid, note_id).await {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::error!(%error, uid, note_id, "favorite remove failed");
            Json(ApiResponse::error("无法确认取消收藏结果，请查询收藏状态"))
        }
    }
}

#[cfg(test)]
mod tests;
