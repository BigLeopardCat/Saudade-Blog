use axum::{Json, extract::{Query, State}, http::HeaderMap};

mod deletion;
mod mailbox;
mod message_reads;
mod notifications;
mod favorites;
pub use favorites::{add_favorite, favorite_state, list_favorites, remove_favorite};
mod unread;
mod inbox_overview;
pub use inbox_overview::get_inbox_overview;
mod visibility;
pub use deletion::{delete_message, delete_notification};
pub use notifications::{
    list_notifications, notification_detail, notification_state, pending_announcement,
    read_notifications,
};
pub use unread::notification_summary;
pub use message_reads::{message_detail, recent_messages};
pub use mailbox::{list_messages, MailboxQuery};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

use crate::entity::{note_comment, talk, user, user_message, user_message_draft};
use crate::routes::AppState;
use crate::utils::{
    hash_password_async, sniff_image_ext, upload_dir, verify_password_async, ApiResponse,
    ALLOWED_IMAGE_EXTS_TEXT,
};

/// 头像字节上限（裁切后的产物通常 100KB 以内）。路由上的 `DefaultBodyLimit` 放到 4MiB
/// 是**为了让超限走我们自己的中文错误**——axum 默认 2MiB 会在 extractor 层直接 413、
/// 前端只能看到一句英文。
pub const AVATAR_MAX_BYTES: usize = 2 * 1024 * 1024;

// 用户设置

#[derive(Deserialize)]
pub struct UpdateProfileRequest {
    pub nickname: String,
}

const NICKNAME_TAKEN: &str = "这个昵称已经有人用了，换一个吧";

fn is_duplicate_key(e: &sea_orm::DbErr) -> bool {
    use sea_orm::error::RuntimeErr;
    let rt = match e {
        sea_orm::DbErr::Exec(rt) | sea_orm::DbErr::Query(rt) => rt,
        _ => return false,
    };
    // 载荷类型在 sea-orm 0.12 的小版本间从 `sqlx::Error` 变成过 `Box<sqlx::Error>`，
    // 不写死引用形状：方法调用会自动解引用，两种都能编过。
    let RuntimeErr::SqlxError(err) = rt else { return false };
    err.as_database_error()
        .and_then(|d| d.code())
        .map(|c| matches!(c.as_ref(), "23505" | "23000" | "1062"))
        .unwrap_or(false)
}

pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<UpdateProfileRequest>,
) -> Json<ApiResponse<super::auth::ProfileDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let nick = payload.nickname.trim();
    // 按**字符**数而不是字节数限制（中文昵称按字节算会被莫名砍短）
    if nick.is_empty() || nick.chars().count() > 20 {
        return Json(ApiResponse::error("昵称长度需在 1-20 个字符之间"));
    }
    let Some(u) = user::Entity::find_by_id(uid).one(&state.db).await.unwrap_or(None) else {
        return Json(ApiResponse::error("账号不存在"));
    };

    // 预检。`nickname = ?` 走列的 utf8mb4_0900_ai_ci ⇒ 与函数索引**同一口径**
    // （大小写、重音不敏感），不会出现"索引说重复、预检说没事"的两份判据。
    // 这里没有 NULLIF/TRIM：写进来的一律是上面 trim 过的非空串。
    // Rust 侧的 `u.nickname != nick` 是**区分大小写**的，因此"只把 Alice 改成 alice"
    // 会照常走预检——而 precheck 排除了自己那一行，所以能改成（这是想要的：
    // 唯一性约束管的是"和别人撞"，不是"不能改大小写"）。
    if u.nickname != nick {
        let taken = user::Entity::find()
            .filter(user::Column::Id.ne(uid))
            .filter(user::Column::Nickname.eq(nick))
            .one(&state.db)
            .await
            .unwrap_or(None);
        if taken.is_some() {
            return Json(ApiResponse::error(NICKNAME_TAKEN));
        }
    }

    let mut am: user::ActiveModel = u.into();
    am.nickname = Set(nick.to_string());
    am.nickname_auto_renamed = Set(0);
    match am.update(&state.db).await {
        Ok(u) => {
            let muted = crate::authz::is_muted(u.muted_until, chrono::Local::now().naive_local());
            let muted_until = if muted {
                u.muted_until.map(crate::authz::mute_until_text)
            } else {
                None
            };
            Json(ApiResponse::success(super::auth::ProfileDto {
                username: u.username,
                nickname: u.nickname,
                nickname_auto_renamed: u.nickname_auto_renamed != 0,
                avatar: u.avatar,
                role: u.role,
                muted,
                muted_until,
            }))
        }
        Err(e) => {
            tracing::error!("[profile] 改昵称失败 uid={}: {}", uid, e);
            if is_duplicate_key(&e) {
                return Json(ApiResponse::error(NICKNAME_TAKEN));
            }
            Json(ApiResponse::error("保存失败，请稍后再试"))
        }
    }
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    // 走前端 fetch 的驼峰口径（与本仓既有 `noteTitle`/`coverFocusX` 等待收件人一致），
    // 不是 Rust 字段名本身——前端个人中心直接发这两个键名。
    #[serde(rename = "oldPassword")]
    pub old_password: String,
    #[serde(rename = "newPassword")]
    pub new_password: String,
}

#[derive(Serialize, Default)]
pub struct PasswordChangedDto {
    /// 新令牌（与登录返回值同形：裸 JWT，不带 Bearer 前缀）
    pub token: String,
}

pub async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordRequest>,
) -> Json<ApiResponse<PasswordChangedDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if let Some(msg) = crate::utils::password_reject(&payload.new_password) {
        return Json(ApiResponse::error(msg));
    }
    let Some(u) = user::Entity::find_by_id(uid).one(&state.db).await.unwrap_or(None) else {
        return Json(ApiResponse::error("账号不存在"));
    };
    // 旧密码校验与登录共用预占窗口（同一份凭据），按 **IP + 账号** 记——
    // 拿到令牌的人不该因为"已经登录"就获得无上限的旧密码爆破配额。
    let ip = super::auth::get_client_ip(&headers);
    let uname = u.username.clone();
    if let Err(msg) = state.rate_limiter.admit_auth(&ip, &uname) {
        return Json(ApiResponse::error(&msg));
    }
    let verified = match verify_password_async(payload.old_password.clone(), u.password.clone()).await {
        Ok(v) => v,
        Err(msg) => return Json(ApiResponse::error(msg)),
    };
    if !verified {
        return Json(ApiResponse::error("原密码不正确"));
    }
    let new_ver = u.token_version + 1;
    let role = u.role.clone();
    let password_hash = match hash_password_async(payload.new_password.clone()).await {
        Ok(v) => v,
        Err(msg) => return Json(ApiResponse::error(msg)),
    };
    // 与管理员重置/找回并发时，只接受仍是刚校验过的那份凭据。
    let updated = user::Entity::update_many()
        .col_expr(user::Column::Password, sea_orm::sea_query::Expr::value(password_hash))
        .col_expr(user::Column::TokenVersion, sea_orm::sea_query::Expr::value(new_ver))
        .filter(user::Column::Id.eq(uid))
        .filter(user::Column::Password.eq(u.password))
        .filter(user::Column::TokenVersion.eq(u.token_version))
        .exec(&state.db).await;
    match updated {
        Ok(result) if result.rows_affected == 1 => {
            let token = crate::auth_jwt::create_token(uid, &role, new_ver);
            Json(ApiResponse::success(PasswordChangedDto { token }))
        }
        Ok(_) => Json(ApiResponse::error("账号凭据已改变，请重新登录后再试")),
        Err(e) => {
            tracing::error!("[profile] 改密码失败 uid={}: {}", uid, e);
            Json(ApiResponse::error("修改失败，请稍后再试"))
        }
    }
}

#[derive(Serialize, Default)]
pub struct AvatarDto {
    pub avatar: String,
}

/// 落盘目录：`<UPLOAD_DIR>/avatars/`，对外 URL 前缀 `/api/protect/download/avatars/`
/// ——`ServeDir` 已经把整个 UPLOAD_DIR 挂在 `/api/protect/download` 下（公开、无鉴权），
/// 所以子目录天然可访问。头像不进 `image` 表：那张表是编辑器素材库（后台图片管理列表
/// 直接列它），把头像塞进去会污染素材库。
const AVATAR_URL_PREFIX: &str = "/api/protect/download/avatars/";

/// POST /api/protected/profile/avatar：上传裁切后的头像（multipart，单文件）。
/// 前端按 GitHub 那套走：先选图 → 本地裁成 1:1 → 再上传，这里收到的就是裁好的结果。
pub async fn upload_avatar(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: axum::extract::Multipart,
) -> Json<ApiResponse<AvatarDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let Ok(Some(field)) = multipart.next_field().await else {
        return Json(ApiResponse::error("没有收到文件"));
    };
    let data = match field.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("[profile] 读上传体失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("文件读取失败（可能超过大小上限）"));
        }
    };
    if data.is_empty() {
        return Json(ApiResponse::error("文件是空的"));
    }
    if data.len() > AVATAR_MAX_BYTES {
        return Json(ApiResponse::error("头像不能超过 2MB"));
    }
    let Some(ext) = sniff_image_ext(&data) else {
        return Json(ApiResponse::error(&format!("只支持这些图片格式：{ALLOWED_IMAGE_EXTS_TEXT}")));
    };
    // 后缀与内容两条都要过。这里的 `ext` 是刚从**字节头**认出来的，所以这一条今天
    // 恒真 —— 留着是为了让"头像这扇门与图库那把尺子同源"这件事在代码里看得见：
    // 哪天有人给 sniff 加一种"能认但不在白名单"的格式，这里就是拦它的地方。
    if !crate::utils::image_ext_allowed(ext) {
        return Json(ApiResponse::error(&format!("只支持这些图片格式：{ALLOWED_IMAGE_EXTS_TEXT}")));
    }

    let dir = upload_dir().join("avatars");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::error!("[profile] 建头像目录失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("服务端存储不可用，请稍后再试"));
    }
    // 文件名由服务端拼（uid 来自已验证的账号、后缀为随机 UUID），客户端那串名字一个
    // 字节都不参与——路径穿越在这里结构上不可能。
    let fname = format!("{}_{}.{}", uid, uuid::Uuid::new_v4().simple(), ext);
    let path = dir.join(&fname);
    let mut f = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("[profile] 建头像文件失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    if f.write_all(&data).await.is_err() || f.flush().await.is_err() {
        let _ = tokio::fs::remove_file(&path).await; // 半截文件不留在盘上
        return Json(ApiResponse::error("保存失败，请稍后再试"));
    }
    drop(f);

    let url = format!("{}{}", AVATAR_URL_PREFIX, fname);
    let Some(u) = user::Entity::find_by_id(uid).one(&state.db).await.unwrap_or(None) else {
        let _ = tokio::fs::remove_file(&path).await;
        return Json(ApiResponse::error("账号不存在"));
    };
    let old = u.avatar.clone();
    let mut am: user::ActiveModel = u.into();
    am.avatar = Set(Some(url.clone()));
    if let Err(e) = am.update(&state.db).await {
        tracing::error!("[profile] 写头像 URL 失败 uid={}: {}", uid, e);
        let _ = tokio::fs::remove_file(&path).await; // 库没记上就不留孤儿文件
        return Json(ApiResponse::error("保存失败，请稍后再试"));
    }
    // 换头像后清掉上一张：**只删本用户的头像文件**（前缀 + uid_ 同时成立才删，
    // 且必须是纯文件名），避免任何"删了别人文件"的可能。
    if let Some(old_url) = old {
        if let Some(name) = old_url.strip_prefix(AVATAR_URL_PREFIX) {
            if old_url != url && !name.contains('/') && name.starts_with(&format!("{}_", uid)) {
                let _ = tokio::fs::remove_file(upload_dir().join("avatars").join(name)).await;
            }
        }
    }
    Json(ApiResponse::success(AvatarDto { avatar: url }))
}

#[derive(Serialize, Default)]
pub struct FavoriteDto {
    #[serde(rename = "noteId")]
    pub note_id: i32,
    pub title: String,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// 通知（红点数据源）与站内公告

#[derive(Serialize, Default)]
pub struct NotificationDto {
    pub id: i32,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub content: String,
    #[serde(rename = "contentTruncated")]
    pub content_truncated: bool,
    pub link: Option<String>,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// 未读汇总：头像红点的唯一数据源（一次请求拿全，前端不必并发几次）。
#[derive(Serialize, Default)]
pub struct UnreadDto {
    pub notifications: i64,
    pub messages: i64,
    pub total: i64,
    #[serde(rename = "pendingReview")]
    pub pending_review: i64,
    #[serde(rename = "pendingQuota")]
    pub pending_quota: i64,
    #[serde(rename = "pendingComments")]
    pub pending_comments: i64,
}

/// uid 能不能进后台（角色**从库查**、不信 token 里那个可能是旧的 role——
/// 与 `middleware::auth_guard` 同一条纪律，判据收敛在 `authz::can_access_console`）。
/// 查不到这个人（token 有效但用户已删）按不能处理。
async fn is_console_user(db: &sea_orm::DatabaseConnection, uid: i32) -> bool {
    matches!(
        user::Entity::find_by_id(uid).one(db).await,
        Ok(Some(u)) if crate::authz::can_access_console(&u.role)
    )
}

/// 等人工裁决的河灯留言条数（`src='board'` 且 `approved=0`）。
/// 后台留言管理页看的是同一批数据（`talks::list_board_admin` 不过滤 approved、那页自己分档），
/// 这里只要一个数——**不为一行提示把整张表拉进内存**。
async fn board_pending_count(db: &sea_orm::DatabaseConnection) -> i64 {
    talk::Entity::find()
        .filter(talk::Column::Src.eq("board"))
        .filter(talk::Column::Approved.eq(0))
        .count(db)
        .await
        .unwrap_or(0) as i64
}

/// 等人工裁决的**文章评论**条数（`approved = 0` 且 `is_deleted = 0`）。
///
/// 与 `board_pending_count` 逐条同形，但**不是同一批数据**（那张数 `talk`、这张数
/// `note_comment`）。`is_deleted = 0` 这一条是评论独有的：评论是**软删**（后台留着行
/// 溯源、公开侧看不见），已删的行再审没有意义，`audit_comment` 也明确拒它 ⇒ 它不该
/// 出现在"等着你处理"的计数里（否则主人会看见一个点进去办不了的数字）。
async fn comment_pending_count(db: &sea_orm::DatabaseConnection) -> i64 {
    note_comment::Entity::find()
        .filter(note_comment::Column::Approved.eq(0))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .count(db)
        .await
        .unwrap_or(0) as i64
}

#[derive(Deserialize)]
pub struct ReadRequest {
    #[serde(default)]
    pub ids: Vec<i32>,
    /// true = 全部标记已读（`ids` 一起传时忽略它，语义不混）
    #[serde(default)]
    pub all: bool,
}


// 站内信箱

#[derive(Serialize, Default)]
pub struct MessageDto {
    pub id: i32,
    #[serde(rename = "fromUserId")]
    pub from_user_id: i32,
    #[serde(rename = "toUserId")]
    pub to_user_id: i32,
    /// 对方的展示名（昵称优先，没设昵称就是账号）——前端不再自己去查人
    #[serde(rename = "peerName")]
    pub peer_name: String,
    #[serde(rename = "peerAvatar")]
    pub peer_avatar: Option<String>,
    pub title: Option<String>,
    pub content: String,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Default)]
pub struct MailboxDto {
    #[serde(rename = "inboxComplete")]
    pub inbox_complete: bool,
    pub inbox: Vec<MessageDto>,
    pub outbox: Vec<MessageDto>,
    pub unread: i64,
}

const MESSAGE_MAX_CHARS: usize = 500;
const MESSAGE_TITLE_MAX_CHARS: usize = 60;

pub(crate) struct PeerInfo {
    /// **展示名**：昵称优先，空串（没设过）退回账号。见 [`peer_map`]
    pub name: String,
    pub avatar: Option<String>,
    /// 角色（权限身份徽章用）。**从库里现读**，不是令牌快照
    pub role: String,
}

/// 一批 uid → [`PeerInfo`]。空 ids 直接回空表（不发 `IN (NULL)` 白查询）。
pub(crate) async fn peer_map(
    db: &sea_orm::DatabaseConnection,
    ids: &[i32],
) -> HashMap<i32, PeerInfo> {
    if ids.is_empty() {
        return HashMap::new();
    }
    user::Entity::find()
        .select_only()
        .column(user::Column::Id)
        .column(user::Column::Username)
        .column(user::Column::Nickname)
        .column(user::Column::Avatar)
        .column(user::Column::Role)
        .filter(user::Column::Id.is_in(ids.to_vec()))
        .into_tuple::<(i32, String, String, Option<String>, String)>()
        .all(db)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(id, username, nickname, avatar, role)| {
            let name = if nickname.trim().is_empty() { username.clone() } else { nickname };
            (id, PeerInfo { name, avatar, role })
        })
        .collect()
}

fn to_message_dto(
    m: user_message::Model,
    uid: i32,
    peers: &HashMap<i32, PeerInfo>,
) -> MessageDto {
    let peer_id = if m.from_user_id == uid { m.to_user_id } else { m.from_user_id };
    let (name, avatar) = peers
        .get(&peer_id)
        .map(|p| (p.name.clone(), p.avatar.clone()))
        .unwrap_or_else(|| (format!("用户#{}", peer_id), None));
    MessageDto {
        id: m.id,
        from_user_id: m.from_user_id,
        to_user_id: m.to_user_id,
        peer_name: name,
        peer_avatar: avatar,
        title: m.title,
        content: m.content,
        is_read: m.is_read,
        created_at: m.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    #[serde(rename = "toUsername")]
    pub to_username: String,
    #[serde(default)]
    pub title: Option<String>,
    pub content: String,
}

pub async fn send_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SendMessageRequest>,
) -> Json<ApiResponse<MessageDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let content = payload.content.trim();
    if content.is_empty() {
        return Json(ApiResponse::error("内容不能为空"));
    }
    if content.chars().count() > MESSAGE_MAX_CHARS {
        return Json(ApiResponse::error("内容过长（最多 500 字）"));
    }
    // 标题选填：trim 之后空串一律存 NULL——"没填"只有一种表示，前端不必区分
    // 空串与 null（历史行全是 NULL）。先取出成 owned String，再去碰 payload 的其它字段。
    let title: Option<String> = payload
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    if let Some(t) = title.as_deref() {
        if t.chars().count() > MESSAGE_TITLE_MAX_CHARS {
            return Json(ApiResponse::error("标题过长（最多 60 字）"));
        }
    }
    // Reserve before target lookup: concurrent sends and changing recipients share one budget.
    static SEND_LIMITER: std::sync::OnceLock<crate::rate_limiter::LoginRateLimiter> =
        std::sync::OnceLock::new();
    if SEND_LIMITER
        .get_or_init(|| crate::rate_limiter::LoginRateLimiter::new(20, 60, 60))
        .hit("private-message", &uid.to_string())
        .is_err()
    {
        return Json(ApiResponse::error("站内信发送过于频繁，请稍后再试"));
    }
    let who = payload.to_username.trim();
    if who.is_empty() {
        return Json(ApiResponse::error("请填写收件人"));
    }
    let mut target = user::Entity::find()
        .filter(user::Column::Username.eq(who))
        .one(&state.db)
        .await
        .unwrap_or(None);
    if target.is_none() {
        // UID 通道：只在账号没命中、且这串字确实是正整数时才走（见函数头注的顺序理由）
        if let Ok(id) = who.parse::<i32>() {
            if id > 0 {
                target = user::Entity::find()
                    .filter(user::Column::Id.eq(id))
                    .one(&state.db)
                    .await
                    .unwrap_or(None);
            }
        }
    }
    let Some(t) = target else {
        return Json(ApiResponse::error("找不到这个用户（请填对方账号或 UID）"));
    };
    if t.id == uid {
        return Json(ApiResponse::error("不能给自己发站内信"));
    }
    let am = user_message::ActiveModel {
        from_user_id: Set(uid),
        to_user_id: Set(t.id),
        title: Set(title),
        content: Set(content.to_string()),
        ..Default::default()
    };
    let saved = match am.insert(&state.db).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("[profile] 发信失败 uid={} to={}: {}", uid, t.id, e);
            return Json(ApiResponse::error("发送失败，请稍后再试"));
        }
    };
    let name = if t.nickname.trim().is_empty() {
        t.username.clone()
    } else {
        t.nickname.clone()
    };
    let peers = HashMap::from([(
        t.id,
        PeerInfo {
            name,
            avatar: t.avatar.clone(),
            role: t.role.clone(),
        },
    )]);
    Json(ApiResponse::success(to_message_dto(saved, uid, &peers)))
}

/// POST /api/protected/messages/read：标记已读（**只动收件箱里我的信**）。
pub async fn read_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ReadRequest>,
) -> Json<ApiResponse<MailboxDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let now = chrono::Local::now().naive_local();
    let mut q = user_message::Entity::update_many()
        .col_expr(user_message::Column::IsRead, sea_orm::sea_query::Expr::value(true))
        .col_expr(
            user_message::Column::ReadAt,
            sea_orm::sea_query::Expr::value(Some(now)),
        )
        .filter(visibility::inbox(uid))
        .filter(user_message::Column::IsRead.eq(false));
    if !payload.all {
        if payload.ids.is_empty() {
            return list_messages(State(state), headers, Query(MailboxQuery::default())).await;
        }
        q = q.filter(user_message::Column::Id.is_in(payload.ids.clone()));
    }
    if let Err(e) = q.exec(&state.db).await {
        tracing::error!("[profile] 私信标记已读失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("操作失败，请稍后再试"));
    }
    list_messages(State(state), headers, Query(MailboxQuery::default())).await
}

// 我的留言记录

#[derive(Serialize, Default)]
pub struct MyTalkDto {
    pub id: i32,
    pub src: String,
    pub title: String,
    pub content: String,
    pub cat: String,
    pub v: i32,
    pub author: String,
    /// 1=通过（公开可见）/ 0=待审 / 2=未通过（驳回）——**如实回传**，本人的记录自己看得到状态
    pub approved: i32,
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

pub async fn list_my_talks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<MyTalkDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let rows = match talk::Entity::find()
        .filter(talk::Column::UserId.eq(uid))
        .filter(talk::Column::Src.eq("board"))
        .order_by_desc(talk::Column::CreatedAt)
        .order_by_desc(talk::Column::Id)
        .limit(200)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[profile] 留言记录查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let dtos = rows
        .into_iter()
        .map(|t| MyTalkDto {
            id: t.id,
            src: t.src,
            title: t.title.unwrap_or_default(),
            content: t.content,
            cat: t.cat,
            v: t.v as i32,
            author: t.author,
            approved: t.approved as i32,
            reject_reason: t.reject_reason,
            created_at: t.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        })
        .collect();
    Json(ApiResponse::success(dtos))
}


/// 每人草稿上限。够用即可——这个数只为挡住"把草稿箱当网盘"的写法，
/// 不是产品限制（真正想存东西的人 100 条以内也该发出去了）。
const DRAFT_MAX_PER_USER: u64 = 100;

#[derive(Serialize, Default)]
pub struct DraftDto {
    pub id: i32,
    /// 收件人**原文**（账号或 UID）——草稿允许是个还没核实的名字，所以这里不回解析结果，
    /// 也不做存在性校验：真正的校验在发送那一刻（见 `send_message`）。
    #[serde(rename = "toUsername")]
    pub to_username: Option<String>,
    pub title: Option<String>,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

fn to_draft_dto(d: user_message_draft::Model) -> DraftDto {
    DraftDto {
        id: d.id,
        to_username: d.to_username,
        title: d.title,
        content: d.content,
        created_at: d.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: d.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

#[derive(Deserialize)]
pub struct SaveDraftRequest {
    /// 带 id = 改这条草稿（**必须是自己的**，否则按"不存在"处理）；不带 = 新建一条。
    ///
    /// ⚠️ 前端必须把返回值里的 id 接住：一次写信会话里第一次"存草稿"是新建，
    /// 之后每次都用返回的 id 再 POST ⇒ 走 UPDATE，**否则会攒出一堆内容相同的草稿**。
    #[serde(default)]
    pub id: Option<i32>,
    #[serde(rename = "toUsername", default)]
    pub to_username: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// 草稿正文允许为空（可能只想先把收件人记下来）——但三个字段全空没意义，见下。
    #[serde(default)]
    pub content: String,
}

/// GET /api/protected/messages/drafts：我的草稿（按最近改过的在前，最多 100 条）。
pub async fn list_drafts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<DraftDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let rows = match user_message_draft::Entity::find()
        .filter(user_message_draft::Column::UserId.eq(uid))
        .order_by_desc(user_message_draft::Column::UpdatedAt)
        .order_by_desc(user_message_draft::Column::Id)
        .limit(100)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[profile] 草稿查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    Json(ApiResponse::success(rows.into_iter().map(to_draft_dto).collect()))
}

/// POST /api/protected/messages/drafts：存草稿（带 id 改、不带 id 新建）。
///
/// 长度上限与站内信**同一组常量**：草稿能存进去却发不出去是最糟的形态。
pub async fn save_draft(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SaveDraftRequest>,
) -> Json<ApiResponse<DraftDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if payload.content.chars().count() > MESSAGE_MAX_CHARS {
        return Json(ApiResponse::error("内容过长（最多 500 字）"));
    }
    // trim 后空串一律存 NULL——"没填"只有一种表示（与 send_message 同一口径）
    let to_username: Option<String> = payload
        .to_username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let title: Option<String> = payload
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(t) = title.as_deref() {
        if t.chars().count() > MESSAGE_TITLE_MAX_CHARS {
            return Json(ApiResponse::error("标题过长（最多 60 字）"));
        }
    }
    let content = payload.content.trim();
    // 三个字段全空 ⇒ 没有东西可存。空手点「存草稿」不该在草稿箱里多出一行空壳。
    if to_username.is_none() && title.is_none() && content.is_empty() {
        return Json(ApiResponse::error("草稿是空的，先写点什么再存"));
    }
    match payload.id {
        // 改：必须是自己那条（越权在这里被 SQL 挡住，不是靠前端"不传别人的 id"）
        Some(id) => {
            let owned = user_message_draft::Entity::find()
                .filter(user_message_draft::Column::Id.eq(id))
                .filter(user_message_draft::Column::UserId.eq(uid))
                .one(&state.db)
                .await
                .unwrap_or(None);
            let Some(row) = owned else {
                return Json(ApiResponse::error("草稿不存在（可能已被删除）"));
            };
            let am = user_message_draft::ActiveModel {
                id: Set(row.id),
                to_username: Set(to_username),
                title: Set(title),
                content: Set(content.to_string()),
                // 时间显式写一次本地钟面：`ON UPDATE CURRENT_TIMESTAMP` 走的是连接时区，
                // 显式 Set 让它与全库那套（`chrono::Local::now().naive_local()`）必然一致。
                updated_at: Set(chrono::Local::now().naive_local()),
                ..Default::default()
            };
            match am.update(&state.db).await {
                Ok(m) => Json(ApiResponse::success(to_draft_dto(m))),
                Err(e) => {
                    tracing::error!("[profile] 存草稿(改)失败 uid={} id={}: {}", uid, id, e);
                    Json(ApiResponse::error("保存失败，请稍后再试"))
                }
            }
        }
        // 新建
        None => {
            let count = user_message_draft::Entity::find()
                .filter(user_message_draft::Column::UserId.eq(uid))
                .count(&state.db)
                .await
                .unwrap_or(0);
            if count >= DRAFT_MAX_PER_USER {
                return Json(ApiResponse::error("草稿太多了（最多 100 条），先清理一些再存"));
            }
            let am = user_message_draft::ActiveModel {
                user_id: Set(uid),
                to_username: Set(to_username),
                title: Set(title),
                content: Set(content.to_string()),
                ..Default::default()
            };
            match am.insert(&state.db).await {
                Ok(m) => Json(ApiResponse::success(to_draft_dto(m))),
                Err(e) => {
                    tracing::error!("[profile] 存草稿(新)失败 uid={}: {}", uid, e);
                    Json(ApiResponse::error("保存失败，请稍后再试"))
                }
            }
        }
    }
}

/// DELETE /api/protected/messages/drafts/:id：删草稿。
/// 没这条 / 不是自己的 / 已经删过了，一律返回成功——同一个按钮点两次不该出错
/// （与 `remove_favorite` 同一取向：删除是幂等的，"删不到"不构成错误）。
pub async fn delete_draft(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i32>,
) -> Json<ApiResponse<String>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    match user_message_draft::Entity::delete_many()
        .filter(user_message_draft::Column::Id.eq(id))
        .filter(user_message_draft::Column::UserId.eq(uid))
        .exec(&state.db)
        .await
    {
        Ok(_) => Json(ApiResponse::success("已删除草稿".to_string())),
        Err(e) => {
            tracing::error!("[profile] 删草稿失败 uid={} id={}: {}", uid, id, e);
            Json(ApiResponse::error("删除失败，请稍后再试"))
        }
    }
}
