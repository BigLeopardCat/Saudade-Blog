use axum::{Json, extract::State, http::HeaderMap};
use sea_orm::{ActiveModelTrait, EntityTrait, ColumnTrait, QueryFilter, Set};
use chrono::Utc;
use std::sync::Arc;
use crate::entity::{password_reset_token, user};
use crate::routes::AppState;
use crate::utils::{ApiResponse, encrypt_password, hash_password, needs_rehash, verify_password};
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

/// 从请求头中提取客户端真实 IP（nginx 反代后取 X-Forwarded-For 第一个地址）
/// 20260922：改 `pub(crate)` —— 个人中心改密码那条路也要按 IP+账号记账（同一份凭据，
/// 不该因为是「已登录」就放宽爆破成本）。
pub(crate) fn get_client_ip(headers: &HeaderMap) -> String {
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
        // 冻结账号（20260926）：口令对也进不来。判据放**口令校验之后**是有意的——
        // 口令错的人仍然只看到那句统一的「账号或密码错误」，冻结这件事只告诉
        // **已经证明自己拿着凭据**的人（否则它就成了一个账号存在性的探针）。
        if crate::authz::is_frozen(u.status) {
            return Json(ApiResponse::error("账号已被冻结，请联系管理员"));
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
        // 令牌里带上当前的 `token_version`（20260926）：此后只要库里的值变大
        // （改密码 / 管理员重置 / 冻结），这枚令牌当场失效——收回能力就在这一行。
        let token = crate::auth_jwt::create_token(u.id, &u.role, u.token_version);
        return Json(ApiResponse::success(token));
    }

    // H2 修复：记录失败尝试
    state.rate_limiter.record_failure(&ip, &payload.username);

    // Return generic error if not found
    Json(ApiResponse::error("账号或密码错误"))
}

/// 无邮箱账号的安全找回：恢复码由管理员签发，15 分钟内只能使用一次。
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ResetPasswordRequest>,
) -> Json<ApiResponse<String>> {
    let username = payload.username.trim();
    let code = payload.recovery_code.trim();
    if username.is_empty() || code.len() < 16 || payload.new_password.len() < 8 {
        return Json(ApiResponse::error("账号、恢复码或新密码格式不正确"));
    }

    let names = [username.to_string(), encrypt_password(username)];
    let Some(account) = user::Entity::find()
        .filter(user::Column::Username.is_in(names))
        .one(&state.db)
        .await
        .unwrap_or(None)
    else {
        return Json(ApiResponse::error("账号或恢复码无效"));
    };

    let token_hash = encrypt_password(code);
    let now = Utc::now().naive_utc();
    let Some(token) = password_reset_token::Entity::find()
        .filter(password_reset_token::Column::UserId.eq(account.id))
        .filter(password_reset_token::Column::TokenHash.eq(token_hash))
        .filter(password_reset_token::Column::UsedAt.is_null())
        .one(&state.db)
        .await
        .unwrap_or(None)
    else {
        return Json(ApiResponse::error("账号或恢复码无效"));
    };
    if token.expires_at <= now {
        return Json(ApiResponse::error("恢复码已过期，请联系管理员重新生成"));
    }
    // 冻结账号不能靠恢复码把口令换掉再进来（20260926）：冻结是管理员按下的一刀，
    // 被冻的人手里有旧的恢复码也不该能自己解开。放在**口令写入之前**，
    // 于是这条路上不会留下任何"改了一半"的痕迹。
    if crate::authz::is_frozen(account.status) {
        return Json(ApiResponse::error("账号已被冻结，请联系管理员"));
    }

    // 走这条路等于"凭据已经换了"（20260926）：令牌代次 +1，
    // 此前在**任何设备**上签发的令牌当场全部失效。找回密码本来就意味着
    // "我怀疑旧凭据不安全了"，那就必须连旧会话一起收掉。
    // 代次必须在 `into()` 之前抄下来——ActiveModel 里读不到"当前值"。
    let ver = account.token_version;
    let mut user_active: user::ActiveModel = account.into();
    user_active.password = Set(hash_password(&payload.new_password));
    user_active.token_version = Set(ver + 1);
    if user_active.update(&state.db).await.is_err() {
        return Json(ApiResponse::error("密码修改失败，请稍后再试"));
    }

    let mut token_active: password_reset_token::ActiveModel = token.into();
    token_active.used_at = Set(Some(now));
    if token_active.update(&state.db).await.is_err() {
        return Json(ApiResponse::error("恢复码确认失败，请联系管理员检查账号状态"));
    }
    Json(ApiResponse::success("密码修改成功，请使用新密码登录".to_string()))
}

/// 当前登录用户信息（任意角色，非仅 admin）：留言留名预填用
/// 挂公共路由但自身鉴权：无有效 token 返回 401 语义的错误
#[derive(Serialize, Default)]
pub struct ProfileDto {
    pub username: String,
    pub nickname: String,
    /// 昵称是否由**迁移自动加过后缀**（20261002 昵称唯一）：true 时个人中心显示一条
    /// 横幅提示本人改掉。本人改一次昵称就变 false（`nickname_auto_renamed` 清 0）。
    /// 用**驼峰**（本仓 DTO 的既定口径），与 `oldPassword` 同形。
    #[serde(rename = "nicknameAutoRenamed")]
    pub nickname_auto_renamed: bool,
    /// 头像 URL（20260922 个人中心）：NULL/空 = 没设过，展示端回退到站点主人头像
    pub avatar: Option<String>,
    /// 角色（20260926 用户点名：个人中心的昵称后面要显示权限身份标签）。
    /// **从库里现读**，不从令牌 claims 里取——令牌里的 role 是签发那一刻的快照，
    /// 而"管理员被降成普通用户"之后，那枚旧令牌会一直自称管理员（前端判据看的是
    /// 这里，所以标签必须跟着库走）。取值域见 `crate::authz`。
    pub role: String,
}

pub async fn profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<ProfileDto>> {
    // 20260926：这里原本自己手写了一遍"取头 → 验签 → 取 sub"，是全仓**第二份**
    // 身份解析。身份只有一个出口（`auth_jwt::auth_uid`），否则冻结/令牌收回这类
    // 加在出口上的判据会在这条路上被架空——而这条正是前端每次开面板都要走的路。
    match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(id) => match user::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None) {
            Some(u) => {
                let nick = if u.nickname.is_empty() { u.username.clone() } else { u.nickname };
                Json(ApiResponse::success(ProfileDto {
                    username: u.username,
                    nickname: nick,
                    nickname_auto_renamed: u.nickname_auto_renamed != 0,
                    avatar: u.avatar,
                    role: u.role,
                }))
            }
            None => Json(ApiResponse::error("账号不存在")),
        },
        Err(e) => Json(ApiResponse::error(e.message())),
    }
}
