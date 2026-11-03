//! One actor-owned deletion transaction for an explicitly selected set of todos.
use super::{deletion, dto, verify_actor, DeletedTodo};
use crate::{
    entity::dashboard_todo,
    routes::{todos::begin_list_write, AppState},
    utils::ApiResponse,
};
use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Deserialize;
use std::{collections::HashSet, sync::Arc};

const MAX_ITEMS: usize = 50;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub ids: Vec<i32>,
}

fn valid_ids(ids: &[i32]) -> bool {
    !ids.is_empty()
        && ids.len() <= MAX_ITEMS
        && ids.iter().all(|id| *id > 0)
        && ids.iter().copied().collect::<HashSet<_>>().len() == ids.len()
}

pub async fn prepare_deletions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Selection>,
) -> Json<ApiResponse<Vec<super::TodoDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if !valid_ids(&request.ids) {
        return Json(ApiResponse::error("请选择 1 至 50 项不同的待办"));
    }
    match dashboard_todo::Entity::find()
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .filter(dashboard_todo::Column::Id.is_in(request.ids.iter().copied()))
        .order_by_asc(dashboard_todo::Column::Id)
        .all(&state.db)
        .await
    {
        Ok(rows) if rows.len() == request.ids.len() => {
            Json(ApiResponse::success(rows.into_iter().map(dto).collect()))
        }
        Ok(_) => Json(ApiResponse::error(
            "部分待办不存在或不属于本人，请重新读取后选择",
        )),
        Err(e) => {
            tracing::error!(%e, uid, "todo batch preparation failed");
            Json(ApiResponse::error("待办读取失败"))
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Deletion {
    pub id: i32,
    pub version: String,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub items: Vec<Deletion>,
}

pub async fn delete_todos(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut request): Json<Batch>,
) -> Json<ApiResponse<Vec<DeletedTodo>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if !valid_ids(&request.items.iter().map(|item| item.id).collect::<Vec<_>>()) {
        return Json(ApiResponse::error("请选择 1 至 50 项不同的待办"));
    }
    request.items.sort_by_key(|item| item.id);
    let mut versions = Vec::new();
    for item in &request.items {
        match chrono::NaiveDateTime::parse_from_str(&item.version, "%Y-%m-%d %H:%M:%S%.f") {
            Ok(version) if !item.text.is_empty() && item.text.chars().count() <= 200 => {
                versions.push(version)
            }
            _ => return Json(ApiResponse::error("待办正文或版本无效")),
        }
    }
    let result = async {
        let (txn, actor) = begin_list_write(&state.db, uid).await?;
        let claims = crate::auth_jwt::claims_from_headers(&headers)
            .ok_or_else(|| sea_orm::DbErr::Custom("登录状态已变化".into()))?;
        verify_actor(&actor, claims.sub, claims.ver)?;
        for (item, version) in request.items.iter().zip(versions) {
            if deletion(uid, item.id, &item.text, version)
                .exec(&txn)
                .await?
                .rows_affected
                != 1
            {
                return Err(sea_orm::DbErr::Custom(
                    "部分待办已变化，整批未删除，请重新读取后确认".into(),
                ));
            }
        }
        txn.commit().await?;
        Ok(request
            .items
            .into_iter()
            .map(|item| DeletedTodo {
                id: item.id,
                version: item.version,
                deleted: true,
            })
            .collect())
    }
    .await;
    match result {
        Ok(items) => Json(ApiResponse::success(items)),
        Err(e) => {
            let message = if let sea_orm::DbErr::Custom(message) = e {
                message
            } else {
                tracing::error!(%e, uid, "todo batch deletion failed");
                "删除失败或结果未知，请查询待办状态".into()
            };
            Json(ApiResponse::error(&message))
        }
    }
}
