use axum::{Json, extract::State};
use sea_orm::{EntityTrait, Set, ActiveModelTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::entity::knowledge_base;

#[derive(Deserialize)]
pub struct KbUpsert {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Serialize)]
pub struct KbItem {
    pub id: i32,
    pub title: String,
    pub content: String,
    pub category: String,
}

pub async fn list_knowledge(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<KbItem>> {
    let items = knowledge_base::Entity::find()
        .all(&state.db)
        .await
        .unwrap_or_default();
    Json(items.into_iter().map(|m| KbItem {
        id: m.id,
        title: m.title,
        content: m.content,
        category: m.category,
    }).collect())
}

pub async fn add_knowledge(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<KbUpsert>,
) -> Json<String> {
    let _ = knowledge_base::ActiveModel {
        title: Set(payload.title),
        content: Set(payload.content),
        category: Set(payload.category),
        ..Default::default()
    }.save(&state.db).await;
    Json("ok".into())
}

pub async fn delete_knowledge(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
) -> Json<String> {
    let _ = knowledge_base::Entity::delete_by_id(id)
        .exec(&state.db).await;
    Json("ok".into())
}
