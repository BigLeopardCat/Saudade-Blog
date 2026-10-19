use axum::{Json, extract::State, http::HeaderMap};
use sea_orm::{ActiveModelTrait, EntityTrait, ColumnTrait, QueryFilter, QueryOrder, QuerySelect, Set};
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

/// 从请求头中提取客户端真实 IP（限流按 IP+账号记账，见 `login` / `profile::change_password`）。
/// 20260922：改 `pub(crate)` —— 个人中心改密码那条路也要按 IP+账号记账（同一份凭据，
/// 不该因为是「已登录」就放宽爆破成本）。
///
/// ⚠️ **只信 nginx 覆写过的头**（20261004 修，此前读 `X-Forwarded-For` 的**第一段**）：
/// 本站 nginx 用的是 `$proxy_add_x_forwarded_for`，它的语义是
/// `"$http_x_forwarded_for, $remote_addr"`——**客户端自带的 XFF 前缀原样保留**。
/// 于是"取第一段"取到的正是攻击者随手填的值：登录限流只要发一个
/// `X-Forwarded-For: 1.2.3.4` 就换成全新配额，爆破次数无上限，而这条限流是本站
/// 唯一的在线爆破刹车。
///
/// 优先级（前两条都只认"最近的这一跳"）：
///   ① `X-Real-IP`：nginx 的 `proxy_set_header X-Real-IP $remote_addr` 是**覆写**语义，
///      客户端送什么都不作数，它就是本连接的对端地址；本站走的就是这条。
///   ② `X-Forwarded-For` 的**最后一段**（不是第一段）：`$proxy_add_x_forwarded_for`
///      把真实对端**追加在末尾**，攻击者只能污染前面。这条只给"挂在别的代理后面、
///      设 XFF 不设 X-Real-IP"的部署兜底，本站用不到。
///   ③ 都没有 → `"unknown"`：限流退化成**按账号**计（所有请求同一个 ip 键）。
///      这是**更严**而不是更松——比按一个可伪造的 IP 记账安全。
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
    headers: HeaderMap,
    Json(payload): Json<ResetPasswordRequest>,
) -> Json<ApiResponse<String>> {
    // 限流（20261020，安全审计 SAU-017 的伴生）：恢复码的哈希改成 **Argon2id** 之后，
    // 一次错码就是一次 19MiB × 数十毫秒的运算——而这条路**没有任何身份**。这与登录 /
    // 个人中心改密码是**同一份凭据**，所以按 IP+账号进同一个桶（同 `profile.rs` 那条：
    // 「拿到令牌的人不该因为已登录就获得无上限的爆破配额」，反过来也一样：登录有闸、
    // 换个入口猜恢复码没闸，那这道闸就等于没有）。
    //
    // 记账放在**外层**：`reset_password_inner` 只回 `Result`，于是"每一条失败路径都
    // 记账"是结构性的——以后往里面加一个 `return` 不会漏账。
    let ip = get_client_ip(&headers);
    if let Err(msg) = state.rate_limiter.check(&ip, &payload.username) {
        return Json(ApiResponse::error(&msg));
    }
    match reset_password_inner(&state, &payload).await {
        Ok(msg) => {
            state.rate_limiter.record_success(&ip, &payload.username);
            Json(ApiResponse::success(msg))
        }
        Err(msg) => {
            state.rate_limiter.record_failure(&ip, &payload.username);
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
    // 口令那一段走共用判据（20261017）：此前是 `payload.new_password.len() < 8`，
    // 而 `len()` 是**字节数** ⇒ 3 个汉字（9 字节）就能过。账号名/恢复码的判据留在原地
    // ——它们不是口令，共用那一个函数会把这三种语义搅在一起。
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

    // 恢复码的哈希 20261020 起是 **Argon2id**（随机盐，安全审计 SAU-017）⇒ **不能再拿
    // "哈希"当等值查询条件**（与主密码那次改造同一条理由）：按 `user_id` 取**未使用**的行，
    // 在 Rust 里逐条校验。
    //
    // `limit(4)` 不是"相信不会发生"，而是这条路径的成本是 **N × 19MiB**：
    // `create_password_reset_token` 每次签发都先删光该账号的全部旧行 ⇒ 正常只有 0 或 1 条；
    // 有条以上时只校验最近 4 条并留一条 WARNING——宁可让一条异常旧行验不过，
    // 也不让一个无身份请求把内存打满。
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
    // 旧格式（无盐 SHA-256）由 `verify_password` 一并认。**刻意不做惰性升级**：
    // 恢复码是**一次性**的（15 分钟、用过即废），升级一条马上要死的行只是多一次写。
    // 主密码那条路要惰性升级，是因为那个哈希还要活很多年——两者的理由不同，别照抄。
    let Some(token) = candidates.into_iter().find(|t| verify_password(code, &t.token_hash))
    else {
        return Err("账号或恢复码无效".to_string());
    };
    if token.expires_at <= now {
        return Err("恢复码已过期，请联系管理员重新生成".to_string());
    }
    // 冻结账号不能靠恢复码把口令换掉再进来（20260926）：冻结是管理员按下的一刀，
    // 被冻的人手里有旧的恢复码也不该能自己解开。放在**口令写入之前**，
    // 于是这条路上不会留下任何"改了一半"的痕迹。
    if crate::authz::is_frozen(account.status) {
        return Err("账号已被冻结，请联系管理员".to_string());
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
        return Err("密码修改失败，请稍后再试".to_string());
    }

    let mut token_active: password_reset_token::ActiveModel = token.into();
    token_active.used_at = Set(Some(now));
    if token_active.update(&state.db).await.is_err() {
        return Err("恢复码确认失败，请联系管理员检查账号状态".to_string());
    }
    Ok("密码修改成功，请使用新密码登录".to_string())
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
    /// **当前是否处于禁言期**（20261002 内容风控）。判据是 `authz::is_muted`
    /// （"现在 < 到期时刻"），**不是"那一列非空"**——到期之后旧值还留着，
    /// 而那时人已经能正常发言了。个人中心据它显示一条横幅。
    pub muted: bool,
    /// 禁言到期时刻的人话（`永久` / `至 2026-10-04 12:00`），未禁言时为 null。
    ///
    /// **由服务端从 `authz::mute_until_text` 产出**，前端只负责印出来：
    /// 让前端自己判"9999 年就是永久"等于把那个哨兵值抄了第二份，改的时候必然漏一处。
    /// 同一条纪律见 `TempUserInfo::muted_until`（那边回的是**原始库值**，因为它的
    /// 消费方里有一个是 agent 的工具层，它要的是事实而不是文案）。
    #[serde(rename = "mutedUntil")]
    pub muted_until: Option<String>,
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
                // 禁言两列现算（20261002）：`muted` 是判据、文案只在为真时给
                // ——未禁言的人拿到一个 `null`，前端据此整条横幅不渲染。
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
