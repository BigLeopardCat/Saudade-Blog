use axum::{Json, extract::{State, Path}};
use sea_orm::{EntityTrait, ActiveModelTrait, Set, QueryFilter, ColumnTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::friend;
use crate::routes::AppState;
use crate::utils::ApiResponse;
use serde_json::Value;

#[derive(Serialize)]
pub struct FriendDto {
    #[serde(rename = "friendKey")]
    pub id: i32,
    #[serde(rename = "siteName")]
    pub name: String,
    #[serde(rename = "siteUrl")]
    pub url: String,
    pub avatar: String,
    pub description: String,
    pub status: i32,
}

pub async fn list_friends(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<FriendDto>>> {
    let friends = friend::Entity::find().all(&state.db).await.unwrap_or(vec![]);
    let dtos = friends.into_iter().map(|f| FriendDto {
        id: f.id,
        name: f.name,
        url: f.link,
        avatar: f.avatar.unwrap_or_default(),
        description: f.description.unwrap_or_default(),
        status: f.status.unwrap_or(0),
    }).collect();
    Json(ApiResponse::success(dtos))
}

pub async fn list_public_friends(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<FriendDto>>> {
    let friends = friend::Entity::find()
        .filter(friend::Column::Status.eq(1))
        .all(&state.db)
        .await
        .unwrap_or(vec![]);
    let dtos = friends.into_iter().map(|f| FriendDto {
        id: f.id,
        name: f.name,
        url: f.link,
        avatar: f.avatar.unwrap_or_default(),
        description: f.description.unwrap_or_default(),
        status: f.status.unwrap_or(0),
    }).collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertFriend {
    #[serde(rename = "siteName")]
    name: String,
    #[serde(rename = "siteUrl")]
    url: String,
    avatar: String,
    description: String,
    status: Option<i32>,
}

// A6 修复：友链 URL 仅允许 http/https，杜绝 javascript:/data: 等协议注入（前端渲染防不住后端入库）
fn validate_site_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

pub async fn create_friend(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertFriend>,
) -> Json<ApiResponse<String>> {
    if !validate_site_url(&payload.url) {
        return Json(ApiResponse::error("siteUrl 仅允许 http/https 协议"));
    }
    let f = friend::ActiveModel {
        name: Set(payload.name),
        link: Set(payload.url),
        avatar: Set(Some(payload.avatar)),
        description: Set(Some(payload.description)),
        status: Set(payload.status.or(Some(0))),
        ..Default::default()
    };
    friend::Entity::insert(f).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Created".to_string()))
}

pub async fn update_friend(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(payload): Json<UpsertFriend>,
) -> Json<ApiResponse<String>> {
    if !validate_site_url(&payload.url) {
        return Json(ApiResponse::error("siteUrl 仅允许 http/https 协议"));
    }
    let f = friend::Entity::find_by_id(id).one(&state.db).await.unwrap();
    if let Some(x) = f {
        let mut a: friend::ActiveModel = x.into();
        a.name = Set(payload.name);
        a.link = Set(payload.url);
        a.avatar = Set(Some(payload.avatar));
        a.description = Set(Some(payload.description));
        a.status = Set(payload.status.or(Some(1)));
        a.update(&state.db).await.unwrap();
        Json(ApiResponse::success("Updated".to_string()))
    } else {
        Json(ApiResponse::error("Not found"))
    }
}

pub async fn delete_friend(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    friend::Entity::delete_by_id(id).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Deleted".to_string()))
}

pub async fn delete_friends(
    State(state): State<Arc<AppState>>,
    Json(keys_raw): Json<Vec<Value>>,
) -> Json<ApiResponse<String>> {
    let keys: Vec<i32> = keys_raw.iter().filter_map(|v| {
        if let Some(n) = v.as_i64() {
            Some(n as i32)
        } else if let Some(s) = v.as_str() {
            s.parse::<i32>().ok()
        } else {
            None
        }
    }).collect();

    if keys.is_empty() {
        return Json(ApiResponse::error("No valid keys provided"));
    }

    match friend::Entity::delete_many()
        .filter(friend::Column::Id.is_in(keys))
        .exec(&state.db)
        .await {
            Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
            Err(e) => Json(ApiResponse::error(&format!("Error: {}", e)))
        }
}
