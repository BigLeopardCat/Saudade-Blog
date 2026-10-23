use super::announcement_actions::{self, Action, Fields, Intent, Target};
use crate::{entity::announcement, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, State},
    Json,
};
use sea_orm::{EntityTrait, IsolationLevel, QueryOrder, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
    let items = match announcement::Entity::find()
        .order_by_desc(announcement::Column::Id)
        .all(&state.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => return super::db_error("查询公告", &error),
    };
    let dtos = items
        .into_iter()
        .map(|a| AnnouncementDto {
            id: a.id,
            title: a.title,
            content: a.content,
            created_at: a
                .created_at
                .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_default(),
            updated_at: a
                .updated_at
                .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_default(),
        })
        .collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertAnnouncement {
    pub title: String,
    pub content: String,
}

async fn apply_legacy(state: &AppState, intents: Vec<Intent>) -> Result<String, sea_orm::DbErr> {
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await?;
    for intent in intents {
        announcement_actions::apply_current(&txn, intent).await?;
    }
    txn.commit().await?;
    Ok("Completed".to_owned())
}

pub async fn create_announcement(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertAnnouncement>,
) -> Json<ApiResponse<String>> {
    announcement_actions::response(
        apply_legacy(
            &state,
            vec![Intent {
                action: Action::Create,
                target: None,
                fields: Fields {
                    title: Some(payload.title),
                    content: Some(payload.content),
                },
            }],
        )
        .await,
    )
}

pub async fn update_announcement(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(payload): Json<UpsertAnnouncement>,
) -> Json<ApiResponse<String>> {
    announcement_actions::response(
        apply_legacy(
            &state,
            vec![Intent {
                action: Action::Update,
                target: Some(Target {
                    id: Some(id),
                    title: None,
                }),
                fields: Fields {
                    title: Some(payload.title),
                    content: Some(payload.content),
                },
            }],
        )
        .await,
    )
}

pub async fn delete_announcement(
    State(state): State<Arc<AppState>>,
    Json(ids): Json<Vec<i32>>,
) -> Json<ApiResponse<String>> {
    if ids.is_empty() || ids.len() > 100 {
        return Json(ApiResponse::error("每次需指定1至100个公告编号"));
    }
    let mut unique = std::collections::HashSet::new();
    if ids.iter().any(|id| !unique.insert(*id)) {
        return Json(ApiResponse::error("公告编号不能重复"));
    }
    announcement_actions::response(
        apply_legacy(
            &state,
            ids.into_iter()
                .map(|id| Intent {
                    action: Action::Delete,
                    target: Some(Target {
                        id: Some(id),
                        title: None,
                    }),
                    fields: Fields::default(),
                })
                .collect(),
        )
        .await,
    )
}
