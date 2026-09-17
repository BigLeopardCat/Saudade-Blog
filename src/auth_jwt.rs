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

/// 服务间身份断言（20260917）：向 agent 证明「这个 user_id 是 Rust 认证过的」。
///
/// 为什么需要：agent 的 user_id 直接来自请求体，还被它用来签 IoT 用户 JWT（能操作
/// 那个人的设备）。目前靠「agent 只听回环」兜着——一旦 systemd 改成 0.0.0.0、
/// nginx 误反代、或本机某个进程被攻破，就能伪造任意 user_id 去动别人的设备。
/// 带上这条断言之后，边界从"回环假设"变成"签名"：agent 验签通过才认这个 uid。
///
/// 用同一个 JWT_SECRET 签（不引新密钥）、60 秒有效、aud 限死 "agent"（防这条
/// 断言被当成登录 token 复用）。agent 侧验签见 saudade-blog-agent/server.py 的
/// `_verify_user_assertion` / `_resolve_user_id`。
#[derive(Debug, Serialize)]
struct AssertionClaims {
    sub: i32,
    aud: String,
    exp: usize,
    iat: usize,
}

pub fn create_agent_assertion(user_id: i32) -> String {
    let secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set in environment");
    let now = chrono::Utc::now().timestamp() as usize;
    let claims = AssertionClaims {
        sub: user_id,
        aud: "agent".to_string(),
        exp: now + 60,
        iat: now,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_ref()))
        .expect("断言签名失败（key 已校验）")
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
