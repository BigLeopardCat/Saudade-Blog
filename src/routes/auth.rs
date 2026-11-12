use axum::{Json, extract::State, http::HeaderMap};
use sea_orm::{ActiveModelTrait, EntityTrait, ColumnTrait, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait};
use chrono::Utc;
use std::sync::Arc;
use crate::entity::{password_reset_token, user};
use crate::routes::AppState;
use crate::utils::{ApiResponse, encrypt_password, hash_password_async, needs_rehash, verify_password_async};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    username: String,
    recovery_code: String,
    new_password: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub(crate) fn get_client_ip(headers: &HeaderMap) -> String {
    if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        let ip = ip.trim();
        if !ip.is_empty() {
            return ip.to_string();
        }
    }
    if let Some(val) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(last) = val.rsplit(',').next() {
            let ip = last.trim();
            if !ip.is_empty() {
                return ip.to_string();
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
    // 在凭据验证前原子计数，包含在途请求和每 IP 总量。
    let ip = get_client_ip(&headers);
    if let Err(msg) = state.rate_limiter.admit_auth(&ip, &payload.username) {
        return Json(ApiResponse::error(&msg));
    }

    for name in [payload.username.clone(), encrypt_password(&payload.username)] {
        let Some(u) = user::Entity::find()
            .filter(user::Column::Username.eq(&name))
            .one(&state.db)
            .await
            .unwrap_or(None)
        else {
            continue;
        };
        let verified = match verify_password_async(payload.password.clone(), u.password.clone()).await {
            Ok(v) => v,
            Err(msg) => return Json(ApiResponse::error(msg)),
        };
        if !verified {
            continue;
        }
        if crate::authz::is_frozen(u.status) {
            return Json(ApiResponse::error("账号已被冻结，请联系管理员"));
        }
        // 登录成功后升级 SHA-256 密码哈希；升级失败记日志，不中断本次登录。
        if needs_rehash(&u.password) {
            let uid = u.id;
            let password_hash = match hash_password_async(payload.password.clone()).await {
                Ok(v) => v,
                Err(msg) => return Json(ApiResponse::error(msg)),
            };
            let upgraded = user::Entity::update_many()
                .col_expr(user::Column::Password, sea_orm::sea_query::Expr::value(password_hash))
                .filter(user::Column::Id.eq(uid))
                .filter(user::Column::Password.eq(u.password.clone()))
                .filter(user::Column::TokenVersion.eq(u.token_version))
                .exec(&state.db).await;
            match upgraded {
                Ok(r) if r.rows_affected == 1 => tracing::info!("用户 {} 的密码哈希已升级为 Argon2id", uid),
                Ok(_) => return Json(ApiResponse::error("账号凭据已改变，请重新登录")),
                Err(e) => tracing::warn!("用户 {} 的密码哈希升级失败: {}", uid, e),
            }
        }
        let token = crate::auth_jwt::create_token(u.id, &u.role, u.token_version);
        return Json(ApiResponse::success(token));
    }

    // Return generic error if not found
    Json(ApiResponse::error("账号或密码错误"))
}

/// 无邮箱账号的安全找回：恢复码由管理员签发，15 分钟内只能使用一次。
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ResetPasswordRequest>,
) -> Json<ApiResponse<String>> {
    // 恢复码与登录共用预占窗口；按实际查询使用的 trim 后账号记账。
    let ip = get_client_ip(&headers);
    if let Err(msg) = state.rate_limiter.admit_auth(&ip, payload.username.trim()) {
        return Json(ApiResponse::error(&msg));
    }
    match reset_password_inner(&state, &payload).await {
        Ok(msg) => {
            Json(ApiResponse::success(msg))
        }
        Err(msg) => {
            Json(ApiResponse::error(&msg))
        }
    }
}

/// `reset_password` 的判据与写入。**错误文案就是返回给用户的文案**（都是"没成功、可以
/// 再试"那一类，没有内部细节）；限流在外层（见上）。
async fn reset_password_inner(
    state: &Arc<AppState>,
    payload: &ResetPasswordRequest,
) -> Result<String, String> {
    let username = payload.username.trim();
    let code = payload.recovery_code.trim();
    if username.is_empty() || code.len() < 16 {
        return Err("账号、恢复码或新密码格式不正确".to_string());
    }
    if let Some(msg) = crate::utils::password_reject(&payload.new_password) {
        return Err(msg.to_string());
    }

    let names = [username.to_string(), encrypt_password(username)];
    let Some(account) = user::Entity::find()
        .filter(user::Column::Username.is_in(names))
        .one(&state.db)
        .await
        .unwrap_or(None)
    else {
        return Err("账号或恢复码无效".to_string());
    };

    let now = Utc::now().naive_utc();
    let candidates = password_reset_token::Entity::find()
        .filter(password_reset_token::Column::UserId.eq(account.id))
        .filter(password_reset_token::Column::UsedAt.is_null())
        .order_by_desc(password_reset_token::Column::CreatedAt)
        .limit(4)
        .all(&state.db)
        .await
        .unwrap_or_default();
    if candidates.len() > 1 {
        tracing::warn!(
            "[auth] uid={} 有 {} 条未使用的恢复码（正常 ≤1，只校验最近 4 条）",
            account.id, candidates.len()
        );
    }
    // 一次性恢复码沿用密码校验器，不为即将失效的记录升级哈希。
    let mut matched = None;
    for candidate in candidates {
        if verify_password_async(code.to_string(), candidate.token_hash.clone()).await
            .map_err(str::to_string)? {
            matched = Some(candidate);
            break;
        }
    }
    let Some(token) = matched else {
        return Err("账号或恢复码无效".to_string());
    };
    if token.expires_at <= now {
        return Err("恢复码已过期，请联系管理员重新生成".to_string());
    }
    if crate::authz::is_frozen(account.status) {
        return Err("账号已被冻结，请联系管理员".to_string());
    }

    // 哈希在锁外计算；事务按“用户 → 恢复码”的顺序与签发入口保持一致。
    let password_hash = hash_password_async(payload.new_password.clone()).await.map_err(str::to_string)?;
    let txn = state.db.begin().await.map_err(|_| "密码修改失败，请稍后再试".to_string())?;
    let current = user::Entity::find_by_id(account.id).lock_exclusive().one(&txn).await
        .map_err(|_| "密码修改失败，请稍后再试".to_string())?
        .ok_or_else(|| "账号或恢复码无效".to_string())?;
    if crate::authz::is_frozen(current.status) {
        return Err("账号已被冻结，请联系管理员".to_string());
    }
    let claimed_at = Utc::now().naive_utc();
    let claimed = password_reset_token::Entity::update_many()
        .col_expr(password_reset_token::Column::UsedAt, sea_orm::sea_query::Expr::value(Some(claimed_at)))
        .filter(password_reset_token::Column::Id.eq(token.id))
        .filter(password_reset_token::Column::UserId.eq(current.id))
        .filter(password_reset_token::Column::UsedAt.is_null())
        .filter(password_reset_token::Column::ExpiresAt.gt(claimed_at))
        .exec(&txn).await.map_err(|_| "密码修改失败，请稍后再试".to_string())?;
    if claimed.rows_affected != 1 {
        return Err("账号或恢复码无效".to_string());
    }
    let new_ver = current.token_version + 1;
    let mut user_active: user::ActiveModel = current.into();
    user_active.password = Set(password_hash);
    user_active.token_version = Set(new_ver);
    user_active.update(&txn).await.map_err(|_| "密码修改失败，请稍后再试".to_string())?;
    txn.commit().await.map_err(|e| {
        tracing::error!("[auth] 提交密码找回失败: {e}");
        "密码修改失败，请稍后再试".to_string()
    })?;
    Ok("密码修改成功，请使用新密码登录".to_string())
}

/// 当前登录用户信息（任意角色，非仅 admin）：留言留名预填用
/// 挂公共路由但自身鉴权：无有效 token 返回 401 语义的错误
#[derive(Serialize, Default)]
pub struct ProfileDto {
    pub username: String,
    pub nickname: String,
    #[serde(rename = "nicknameAutoRenamed")]
    pub nickname_auto_renamed: bool,
    pub avatar: Option<String>,
    pub role: String,
    pub muted: bool,
    #[serde(rename = "mutedUntil")]
    pub muted_until: Option<String>,
}

pub async fn profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<ProfileDto>> {
    match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(id) => match user::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None) {
            Some(u) => {
                let nick = if u.nickname.is_empty() { u.username.clone() } else { u.nickname };
                let muted = crate::authz::is_muted(u.muted_until, chrono::Local::now().naive_local());
                let muted_until = if muted {
                    u.muted_until.map(crate::authz::mute_until_text)
                } else {
                    None
                };
                Json(ApiResponse::success(ProfileDto {
                    username: u.username,
                    nickname: nick,
                    nickname_auto_renamed: u.nickname_auto_renamed != 0,
                    avatar: u.avatar,
                    role: u.role,
                    muted,
                    muted_until,
                }))
            }
            None => Json(ApiResponse::error("账号不存在")),
        },
        Err(e) => Json(ApiResponse::error(e.message())),
    }
}
