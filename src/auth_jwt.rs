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
    /// 令牌代次（20260926）。与 `user.token_version` 比对，**不相等即作废**
    /// （见 `crate::authz::check_token`）——这是无状态 JWT 补上"收回"能力的那半。
    ///
    /// `Option` + `#[serde(default)]` 是**刻意的、且关乎上线安全**：本字段是一个全新声明，
    /// 部署那一刻线上所有在用的令牌都没有它。没有 `default` ⇒ 解签直接失败
    /// ⇒ **一次部署把所有人踢下线**（哪怕 `token_version` 全是 0）。
    ///
    /// 而 `None` 之所以**不能**简化成"缺省当 0"：agent 的 60 秒代调令牌
    /// （`saudade-blog-agent/tools/base.py::_sign_local_jwt`）签的就是 `{sub, exp, role}`
    /// 三字段——把它当成"代次 0"会让"改过密码的管理员 + 管理助手"这个组合整体 401。
    /// `None` 的语义与失败取向都在 `authz::check_token` 的注释里。
    #[serde(default)]
    pub ver: Option<i32>,
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

/// 服务间身份断言（20260917）：向 agent 证明「这个 user_id 是 Rust 认证过的」。
///
/// 为什么需要：agent 的 user_id 直接来自请求体，还被它用来签 IoT 用户 JWT（能操作
/// 那个人的设备）。目前靠「agent 只听回环」兜着——一旦 systemd 改成 0.0.0.0、
/// nginx 误反代、或本机某个进程被攻破，就能伪造任意 user_id 去动别人的设备。
/// 带上这条断言之后，边界从"回环假设"变成"签名"：agent 验签通过才认这个 uid。
///
/// 用同一个 JWT_SECRET 签（不引新密钥）、60 秒有效、aud 限死 "agent"（防这条
/// 断言被当成登录 token 复用）。agent 侧验签见 saudade-blog-agent/server.py 的
/// `_verify_assertion_claims` / `_resolve_principal`。
///
/// 20260920 起额外带 `role`：agent 只有 uid 的话，"这个人能让我做什么"无处表达，
/// 秘书（以某人的名义按授予范围办事）就落不了地。角色由调用方查 DB 得到
/// （见 chat.rs prepare_chat），agent 侧只认签名里的这个值。
#[derive(Debug, Serialize)]
struct AssertionClaims {
    sub: i32,
    aud: String,
    exp: usize,
    iat: usize,
    /// 角色（20260920，秘书类功能地基）：agent 侧据此决定"我能代表他做什么"
    /// （`saudade-blog-agent/agent/authz.py` 的角色→scope 表）。
    /// 取值为 `user.role` 原值，**由调用方从 DB 查**（不信登录 token 里可能是
    /// 7 天前的角色——与 `middleware::auth_guard` 同一条纪律）。
    /// 查不到时为 None，序列化为 null：agent 按"身份不明 = 零权限"处理，
    /// 不做任何默认授予。
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

/// 身份被拒的原因。**做成有类型的枚举而不是一个字符串**（20260926）：调用方要能分支——
/// 聊天链路必须把"访客"（本来就没有令牌）与"你的令牌已被收回"分成两条不同的回复，
/// 靠比对错误文案来分支是下一个人一定会改坏的那种写法。
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

/// 从 Authorization: Bearer 头提取用户 id，并**确认这个令牌此刻仍然有效**。
///
/// 20260830 从 chat.rs 上移共享（monitor 上报端点与 chat 链路同用）。
/// 20260926 起**由纯签名校验改成"签名 + 查库"**——无状态 JWT 在签发之后、过期之前
/// 收不回来（改密码、封号都拦不住设备上的旧令牌），补上收回能力必须有服务端状态：
/// 这里按主键读一次 `user`，由 `crate::authz::check_token` 判账号状态与令牌代次。
///
/// **为什么把查库塞进这个函数，而不是各 handler 自己再查一次**：这是身份的**唯一出口**，
/// 收回判据长在出口上就结构性地不可能被漏掉；散在 handler 里则"新加一个接口忘了查"
/// 就是一条绕过收回的通道（本仓对这类"判据分两处"的教训见 message-shell 家族）。
/// 代价是每个已登录请求多一次主键查询，如实记在 `docs/security-boundary.md`。
///
/// 返回值 20260926 由 `Option<i32>` 改成 `Result<i32, AuthError>`：`None` 一个值
/// 承载不了"未登录"与"已被冻结"这两种后果完全不同的拒绝。
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
