use axum::{Json, extract::State, http::HeaderMap};
use sea_orm::{ActiveModelTrait, EntityTrait, ColumnTrait, QueryFilter, Set};
use std::sync::Arc;
use crate::entity::user;
use crate::routes::AppState;
use crate::utils::{ApiResponse, encrypt_password, hash_password, needs_rehash, verify_password};
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

    // 20260917：密码改用 Argon2id（带随机盐）⇒ **不能再拿"密码哈希"当等值查询条件**，
    // 必须按用户名取行、在 Rust 里校验。两条路径与改造前保持一致：
    //   ① 用户名明文（新用户）；② 用户名也是哈希（web_info 写入的 legacy Java 用户）。
    // 关于用户名枚举：①先按用户名取行、密码不对再落到②，所以"用户不存在"会比
    // "用户存在但密码错"快一点（少一次 argon2 校验）。IP+用户名限流已在这条路之前
    // 兜着，对一个个人博客来说这点时序差不值得再引一个常数时间假校验。
    for name in [payload.username.clone(), encrypt_password(&payload.username)] {
        let Some(u) = user::Entity::find()
            .filter(user::Column::Username.eq(&name))
            .one(&state.db)
            .await
            .unwrap_or(None)
        else {
            continue;
        };
        if !verify_password(&payload.password, &u.password) {
            continue;
        }
        // 惰性迁移：旧格式（SHA-256）哈希在**登录成功的这一刻**换成 Argon2id——
        // 用户无感、不需要改密码，也不需要一次性刷全表（刷表会让所有人登不进来）。
        // 失败只记日志不影响登录（下次登录再试）。
        if needs_rehash(&u.password) {
            let uid = u.id;
            let mut am: user::ActiveModel = u.clone().into();
            am.password = Set(hash_password(&payload.password));
            match am.update(&state.db).await {
                Ok(_) => tracing::info!("用户 {} 的密码哈希已升级为 Argon2id", uid),
                Err(e) => tracing::warn!("用户 {} 的密码哈希升级失败（本次登录不受影响）: {}", uid, e),
            }
        }
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
