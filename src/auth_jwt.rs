use axum::http::{header, HeaderMap};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use sea_orm::{DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};
use std::env;
pub mod delegation;
pub mod secret;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i32,
    pub exp: usize,
    pub role: String,
    #[serde(default)]
    pub ver: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aud: Option<String>,
}

/// Parse a validated login token for transaction services that recheck the locked actor row.
/// This does not replace the subsequent database token-generation and role checks.
pub fn claims_from_headers(headers: &HeaderMap) -> Option<Claims> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    verify_token(value.strip_prefix("Bearer ").unwrap_or(value))
}

pub fn create_token(user_id: i32, role: &str, token_version: i32) -> String {
    let secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set in environment");
    let expiration = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::days(7))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        sub: user_id,
        exp: expiration,
        role: role.to_string(),
        // 本函数签的令牌**一定带代次**（`Some`）——`None` 只出现在旧令牌与 agent 代理令牌上
        ver: Some(token_version),
        aud: Some("blog-session".into()),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )
    .unwrap()
}

#[derive(Debug, Serialize)]
struct AssertionClaims {
    sub: i32,
    aud: String,
    exp: usize,
    iat: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    delegation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    background_delegation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint: Option<CheckpointGrant>,
}

#[derive(Debug, Serialize)]
struct CheckpointGrant {
    conversation_id: i32,
    operation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

/// Issued only for an owned target persisted in the transactional cleanup outbox.
pub(crate) fn create_checkpoint_assertion(
    user_id: i32,
    conversation_id: i32,
    turn_id: &str,
) -> String {
    if user_id <= 0 || conversation_id <= 0 {
        return String::new();
    }
    let checkpoint = CheckpointGrant {
        conversation_id,
        operation: if turn_id.is_empty() {
            "delete_conversation"
        } else {
            "drop_turn"
        },
        turn_id: (!turn_id.is_empty()).then(|| turn_id.to_owned()),
    };
    sign_assertion(user_id, None, String::new(), None, Some(checkpoint))
}

pub fn create_agent_assertion(user_id: i32, role: Option<&str>) -> String {
    sign_assertion(user_id, role, String::new(), None, None)
}

pub async fn create_chat_assertion(
    db: &DatabaseConnection,
    user_id: i32,
    role: Option<&str>,
    expected_version: i32,
) -> String {
    let Some(actor) = crate::entity::user::Entity::find_by_id(user_id)
        .one(db)
        .await
        .ok()
        .flatten()
        .filter(|u| !crate::authz::is_frozen(u.status) && u.token_version == expected_version)
    else {
        return String::new();
    };
    create_tool_assertion(
        user_id,
        role.map(|_| actor.role.as_str()),
        actor.token_version,
    )
}

/// Only call after validating a real browser session against the current actor row.
/// Delegated credentials cannot reach chat/task proxy routes to renew themselves.
pub(crate) fn create_tool_assertion(user_id: i32, role: Option<&str>, version: i32) -> String {
    let now = chrono::Utc::now().timestamp() as usize;
    let Some(token) = delegation::issue(
        user_id,
        role.unwrap_or("user"),
        version,
        delegation::Scope::Tools,
        now,
    ) else {
        return String::new();
    };
    let background = role
        .filter(|role| crate::authz::can_access_console(role))
        .and_then(|role| {
            delegation::issue(user_id, role, version, delegation::Scope::Background, now)
        });
    sign_assertion(user_id, role, token, background, None)
}

fn sign_assertion(
    user_id: i32,
    role: Option<&str>,
    delegation: String,
    background_delegation: Option<String>,
    checkpoint: Option<CheckpointGrant>,
) -> String {
    let Some(secret) = env::var("AGENT_ASSERTION_SECRET")
        .ok()
        .filter(|s| s.len() >= 32)
    else {
        return String::new();
    };
    let now = chrono::Utc::now().timestamp() as usize;
    let claims = AssertionClaims {
        sub: user_id,
        aud: if checkpoint.is_some() {
            "agent-checkpoint"
        } else {
            "agent"
        }
        .to_string(),
        exp: now + 60,
        iat: now,
        role: role.map(str::to_string),
        delegation,
        background_delegation,
        checkpoint,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("assertion signing failed")
}

pub fn verify_token(token: &str) -> Option<Claims> {
    let secret = env::var("JWT_SECRET").ok()?;
    let mut validation = Validation::default();
    validation.set_audience(&["blog-session"]);
    // Existing seven-day sessions have ver but no aud; they expire naturally.
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &validation,
    )
    .map(|data| data.claims)
    .ok()
    .filter(|claims| claims.sub > 0 && claims.ver.is_some())
    .or_else(|| delegation::verify(token).map(|grant| grant.claims()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    /// 没令牌 / 令牌无效或已过期 / 账号已不存在 / 数据库不可用
    Missing,
    /// 账号被冻结
    Frozen,
    /// 令牌已被收回（改密码、管理员重置、紧急收回）
    Revoked,
}

impl AuthError {
    /// 直接回给前端的 message。**话术只在这里写一份**——同一个原因在十几个接口上
    /// 应该长得一样，各 handler 各编一句就会漂移。
    pub fn message(self) -> &'static str {
        match self {
            AuthError::Missing => "未登录",
            AuthError::Frozen => "账号已被冻结，请联系管理员",
            AuthError::Revoked => "登录状态已失效，请重新登录",
        }
    }
}

pub async fn auth_uid(db: &DatabaseConnection, headers: &HeaderMap) -> Result<i32, AuthError> {
    let claims = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(verify_token)
        .ok_or(AuthError::Missing)?;
    // 查不到人（token 有效但账号已删）与查库失败都按 `Missing` 处理：
    // 前者是真实情况，后者**必须失败关闭**——数据库不可用时不放行任何身份。
    let user = crate::entity::user::Entity::find_by_id(claims.sub)
        .one(db)
        .await
        .ok()
        .flatten()
        .ok_or(AuthError::Missing)?;
    crate::authz::check_token(user.status, user.token_version, claims.ver).map_err(|denial| {
        match denial {
            crate::authz::TokenDenial::Frozen => AuthError::Frozen,
            crate::authz::TokenDenial::Revoked => AuthError::Revoked,
        }
    })?;
    Ok(claims.sub)
}
