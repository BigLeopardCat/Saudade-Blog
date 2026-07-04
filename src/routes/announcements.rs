use axum::{Json, extract::State};
use sea_orm::{EntityTrait, QueryOrder, Set};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::announcement;
use crate::routes::AppState;
use crate::utils::ApiResponse;

#[derive(Serialize)]
pub struct AnnouncementDto {
    pub id: i32,
    pub title: String,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

pub async fn list_announcements(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<AnnouncementDto>>> {
    let items = announcement::Entity::find()
        .order_by_desc(announcement::Column::Id)
        .all(&state.db).await.unwrap_or(vec![]);
    let dtos = items.into_iter().map(|a| AnnouncementDto {
        id: a.id,
        title: a.title,
        content: a.content,
        created_at: a.created_at.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_default(),
        updated_at: a.updated_at.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_default(),
    }).collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertAnnouncement {
    pub title: String,
    pub content: String,
}

pub async fn create_announcement(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertAnnouncement>,
) -> Json<ApiResponse<String>> {
    let a = announcement::ActiveModel {
        title: Set(payload.title),
        content: Set(payload.content),
        ..Default::default()
    };
    announcement::Entity::insert(a).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Created".to_string()))
}

pub async fn update_announcement(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
    Json(payload): Json<UpsertAnnouncement>,
) -> Json<ApiResponse<String>> {
    let a = announcement::ActiveModel {
        id: Set(id),
        title: Set(payload.title),
        content: Set(payload.content),
        ..Default::default()
    };
    announcement::Entity::update(a).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Updated".to_string()))
}

pub async fn delete_announcement(
    State(state): State<Arc<AppState>>,
    Json(ids): Json<Vec<i32>>,
) -> Json<ApiResponse<String>> {
    use sea_orm::ColumnTrait;
    use sea_orm::QueryFilter;
    announcement::Entity::delete_many()
        .filter(announcement::Column::Id.is_in(ids))
        .exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Deleted".to_string()))
}
