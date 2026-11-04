use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use serde::{Deserialize, Serialize};
use axum::http::{HeaderMap, header};
use sea_orm::{DatabaseConnection, EntityTrait};
use std::env;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i32,
    pub exp: usize,
    pub role: String,
    #[serde(default)]
    pub ver: Option<i32>,
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
    };

    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_ref())).unwrap()
}

#[derive(Debug, Serialize)]
struct AssertionClaims {
    sub: i32,
    aud: String,
    exp: usize,
    iat: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
}

pub fn create_agent_assertion(user_id: i32, role: Option<&str>) -> String {
    let secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set in environment");
    let now = chrono::Utc::now().timestamp() as usize;
    let claims = AssertionClaims {
        sub: user_id,
        aud: "agent".to_string(),
        exp: now + 60,
        iat: now,
        role: role.map(|r| r.to_string()),
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
