use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use serde::{Deserialize, Serialize};
use axum::http::{HeaderMap, header};
use std::env;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i32,
    pub exp: usize,
    pub role: String,
}

pub fn create_token(user_id: i32, role: &str) -> String {
    let secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set in environment");
    let expiration = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::days(7))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        sub: user_id,
        exp: expiration,
        role: role.to_string(),
    };

    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_ref())).unwrap()
}

pub fn verify_token(token: &str) -> Option<Claims> {
    let secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set in environment");
    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_ref()), &Validation::default())
        .map(|data| data.claims)
        .ok()
}

/// 从 Authorization: Bearer 头提取用户 id（20260830 从 chat.rs 上移共享：
/// monitor 上报端点与 chat 链路同用；无 token / 无效 → None）
pub fn auth_uid(headers: &HeaderMap) -> Option<i32> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| verify_token(token))
        .map(|claims| claims.sub)
}
