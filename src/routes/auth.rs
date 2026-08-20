use axum::{Json, extract::State, http::HeaderMap};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter};
use std::sync::Arc;
use crate::entity::user;
use crate::routes::AppState;
use crate::utils::{ApiResponse, encrypt_password};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

/// 从请求头中提取客户端真实 IP（nginx 反代后取 X-Forwarded-For 第一个地址）
fn get_client_ip(headers: &HeaderMap) -> String {
    if let Some(val) = headers.get("x-forwarded-for") {
        if let Ok(val) = val.to_str() {
            if let Some(first) = val.split(',').next() {
                let ip = first.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
    }
    if let Some(val) = headers.get("x-real-ip") {
        if let Ok(val) = val.to_str() {
            if !val.is_empty() {
                return val.to_string();
            }
        }
    }
    "unknown".to_string()
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Json<ApiResponse<String>> {
    // H2 修复：按 IP+用户名 限流检查
    let ip = get_client_ip(&headers);
    if let Err(msg) = state.rate_limiter.check(&ip, &payload.username) {
        return Json(ApiResponse::error(&msg));
    }

    let encrypted_password = encrypt_password(&payload.password);

    // Try plain username first (new temp users), fallback to encrypted (legacy users)
    let user = user::Entity::find()
        .filter(user::Column::Username.eq(&payload.username))
        .filter(user::Column::Password.eq(&encrypted_password))
        .one(&state.db)
        .await
        .unwrap_or(None);

    if let Some(u) = user {
        state.rate_limiter.record_success(&ip, &payload.username);
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
        state.rate_limiter.record_success(&ip, &payload.username);
        let token = crate::auth_jwt::create_token(u.id, &u.role);
        return Json(ApiResponse::success(token));
    }

    // H2 修复：记录失败尝试
    state.rate_limiter.record_failure(&ip, &payload.username);

    // Return generic error if not found
    Json(ApiResponse::error("账号或密码错误"))
}

/// 当前登录用户信息（任意角色，非仅 admin）：留言留名预填用
/// 挂公共路由但自身鉴权：无有效 token 返回 401 语义的错误
#[derive(Serialize, Default)]
pub struct ProfileDto {
    pub username: String,
    pub nickname: String,
}

pub async fn profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<ProfileDto>> {
    let uid = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| crate::auth_jwt::verify_token(token))
        .map(|claims| claims.sub);

    match uid {
        Some(id) => match user::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None) {
            Some(u) => {
                let nick = if u.nickname.is_empty() { u.username.clone() } else { u.nickname };
                Json(ApiResponse::success(ProfileDto {
                    username: u.username,
                    nickname: nick,
                }))
            }
            None => Json(ApiResponse::error("账号不存在")),
        },
        None => Json(ApiResponse::error("未登录")),
    }
}
