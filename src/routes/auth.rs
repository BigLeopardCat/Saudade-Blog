use axum::{Json, extract::State};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter};
use std::sync::Arc;
use crate::entity::user;
use crate::routes::AppState;
use crate::utils::{ApiResponse, encrypt_password};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LoginRequest>,
) -> Json<ApiResponse<String>> {
    let encrypted_password = encrypt_password(&payload.password);

    // Try plain username first (new temp users), fallback to encrypted (legacy users)
    let user = user::Entity::find()
        .filter(user::Column::Username.eq(&payload.username))
        .filter(user::Column::Password.eq(&encrypted_password))
        .one(&state.db)
        .await
        .unwrap_or(None);

    if let Some(u) = user {
        let token = crate::auth_jwt::create_token(u.id, &u.role);
        return Json(ApiResponse::success(token));
    }

    // Fallback: try encrypted username (legacy Java-compatible users)
    let encrypted_username = encrypt_password(&payload.username);
    let user = user::Entity::find()
        .filter(user::Column::Username.eq(encrypted_username))
        .filter(user::Column::Password.eq(encrypted_password))
        .one(&state.db)
        .await
        .unwrap_or(None);

    if let Some(u) = user {
        let token = crate::auth_jwt::create_token(u.id, &u.role);
        return Json(ApiResponse::success(token));
    }

    // Return generic error if not found
    Json(ApiResponse::error("账号或密码错误"))
}
