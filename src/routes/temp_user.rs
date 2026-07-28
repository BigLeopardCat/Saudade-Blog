use axum::{Json, extract::{State, Path}};
use sea_orm::{EntityTrait, Set, QueryFilter, ColumnTrait, ActiveModelTrait, DeleteMany};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::entity::user;
use crate::utils::encrypt_password;

#[derive(Deserialize)]
pub struct CreateTempUser {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct TempUserInfo {
    pub id: i32,
    pub username: String,
}

pub async fn list_temp_users(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<TempUserInfo>> {
    let users = user::Entity::find()
        .filter(user::Column::Role.eq("user"))
        .all(&state.db)
        .await
        .unwrap_or_default();
    Json(users.into_iter()
        .filter(|u| u.role == "user")
        .map(|u| TempUserInfo { id: u.id, username: u.username })
        .collect())
}

pub async fn create_temp_user(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTempUser>,
) -> Json<crate::utils::ApiResponse<String>> {
    let encrypted_username = encrypt_password(&payload.username);
    let encrypted_password = encrypt_password(&payload.password);

    let existing = user::Entity::find()
        .filter(user::Column::Username.eq(&encrypted_username))
        .one(&state.db)
        .await
        .unwrap_or(None);

    if existing.is_some() {
        return Json(crate::utils::ApiResponse::error("用户名已存在"));
    }

    let _ = user::ActiveModel {
        username: Set(encrypted_username),
        password: Set(encrypted_password),
        role: Set("user".into()),
        ..Default::default()
    }.save(&state.db).await;

    Json(crate::utils::ApiResponse::success("临时用户创建成功".to_string()))
}

pub async fn delete_temp_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i32>,
) -> Json<crate::utils::ApiResponse<String>> {
    // Delete chat history
    let _ = crate::entity::chat_history::Entity::delete_many()
        .filter(crate::entity::chat_history::Column::UserId.eq(user_id))
        .exec(&state.db).await;
    // Delete user
    let _ = user::Entity::delete_by_id(user_id)
        .exec(&state.db).await;
    Json(crate::utils::ApiResponse::success("用户已删除".to_string()))
}
