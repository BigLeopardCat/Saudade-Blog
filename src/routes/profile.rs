//! 个人中心一期（20260922）：用户设置 / 收藏的文章 / 通知（红点）/ 站内信箱 / 我的留言记录。
//!
//! **为什么整个模块挂 `public_routes` 而不是 `protected_routes`**：后者的 `route_layer`
//! 末尾挂了 `auth_guard`（域内全部接口仅管理员可用，见 `routes/mod.rs`），而本模块每一
//! 个接口都面向**任意登录用户**。先例是 `/api/protected/profile`（auth.rs）与
//! `/api/protect/board/mine`（talks.rs）：挂公开路由、**handler 内部自身鉴权**。
//!
//! 三条纪律（本模块每一处都照它写）：
//!   1. handler 第一行取 uid，取不到就返回「未登录」——**没有任何 uid 缺省值**；
//!   2. 所有查询都带 `user_id = uid` 条件（越权靠 SQL 堵住，不靠前端"不传别人的 id"）；
//!   3. 时间列一律 +08:00 本地钟面（`chrono::Local::now().naive_local()`），与全库一致。
//!
//! 头像上传是本站**唯一**面向普通用户的文件写入面，因此校验写在这里：
//! 类型按**字节头**判（不认客户端给的 content-type/扩展名），只收 jpg/png/webp/gif，
//! SVG 这类能带脚本的格式一律拒绝（它由本站同源下发，内联渲染即 XSS）；
//! 大小显式拦 2MiB（nginx 是 20m，路由上单独放开到 4MiB 好让我们自己给出中文错误）。

use axum::{Json, extract::State, http::HeaderMap};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

use crate::entity::{
    note, talk, user, user_favorite, user_message, user_message_draft, user_notification,
};
use crate::routes::AppState;
use crate::utils::{upload_dir, ApiResponse, hash_password, verify_password};

/// 头像字节上限（裁切后的产物通常 100KB 以内）。路由上的 `DefaultBodyLimit` 放到 4MiB
/// 是**为了让超限走我们自己的中文错误**——axum 默认 2MiB 会在 extractor 层直接 413、
/// 前端只能看到一句英文。
pub const AVATAR_MAX_BYTES: usize = 2 * 1024 * 1024;

// ── 用户设置 ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateProfileRequest {
    pub nickname: String,
}

/// PUT /api/protected/profile：改昵称（个人中心「用户设置」）。
/// 昵称是**展示名**（留言/说说/信箱里显示的那个），不是登录账号——账号不可改。
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
    let mut am: user::ActiveModel = u.into();
    am.nickname = Set(nick.to_string());
    match am.update(&state.db).await {
        Ok(u) => Json(ApiResponse::success(super::auth::ProfileDto {
            username: u.username,
            nickname: u.nickname,
            avatar: u.avatar,
            role: u.role,
        })),
        Err(e) => {
            tracing::error!("[profile] 改昵称失败 uid={}: {}", uid, e);
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

/// 改密码的返回：**新令牌**。
///
/// 为什么要把令牌回给前端（20260926）：改密码会把 `token_version` +1 ⇒ 此前签发的
/// **全部**令牌当场失效，包括发起这次请求的这台设备手里的那枚。这是"其他设备下线"
/// 的必然代价，但让本人也跟着被踢出去是没必要的——服务端在这一刻顺手签发一枚
/// 带新代次的令牌还给本机，语义正好是「本机保持登录，其他设备全部下线」。
#[derive(Serialize, Default)]
pub struct PasswordChangedDto {
    /// 新令牌（与登录返回值同形：裸 JWT，不带 Bearer 前缀）
    pub token: String,
}

/// PUT /api/protected/profile/password：改密码（必须验旧的）。
///
/// 新密码下限 8 位与「忘记密码」那条路（auth.rs `reset_password`）保持一致。
///
/// **改密码会让其他设备立刻下线**（20260926 起；此前这里是如实写着的"做不到"——
/// 令牌无状态、无服务端会话表，改密码收不回旧令牌。现在 `user.token_version` 就是
/// 那份服务端状态，判据在 `authz::check_token`，不再是无状态的）。
/// 顺序是：密码与代次在**同一次 UPDATE** 里落库 ⇒ 不存在"密码换了但令牌没收回"的窗口。
pub async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordRequest>,
) -> Json<ApiResponse<PasswordChangedDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if payload.new_password.chars().count() < 8 {
        return Json(ApiResponse::error("新密码至少 8 位"));
    }
    let Some(u) = user::Entity::find_by_id(uid).one(&state.db).await.unwrap_or(None) else {
        return Json(ApiResponse::error("账号不存在"));
    };
    // 旧密码错误与登录失败同源记账（同一份凭据），按 **IP + 账号** 记——
    // 拿到令牌的人不该因为"已经登录"就获得无上限的旧密码爆破配额。
    let ip = super::auth::get_client_ip(&headers);
    let uname = u.username.clone();
    if let Err(msg) = state.rate_limiter.check(&ip, &uname) {
        return Json(ApiResponse::error(&msg));
    }
    if !verify_password(&payload.old_password, &u.password) {
        state.rate_limiter.record_failure(&ip, &uname);
        return Json(ApiResponse::error("原密码不正确"));
    }
    let new_ver = u.token_version + 1;
    let role = u.role.clone();
    let mut am: user::ActiveModel = u.into();
    am.password = Set(hash_password(&payload.new_password));
    am.token_version = Set(new_ver);
    match am.update(&state.db).await {
        Ok(_) => {
            state.rate_limiter.record_success(&ip, &uname);
            // 令牌用**刚落库的那个代次**签发；用旧值签会立刻被自己收回。
            let token = crate::auth_jwt::create_token(uid, &role, new_ver);
            Json(ApiResponse::success(PasswordChangedDto { token }))
        }
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

/// 按**字节头**认图片类型。客户端给的 content-type 与文件名都是客户端说了算的，
/// 不参与判定。只认这四种；认不出即拒绝（SVG/HTML 都在"认不出"这一侧）。
fn sniff_image_ext(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 3 && data[0..3] == [0xFF, 0xD8, 0xFF] {
        return Some("jpg");
    }
    if data.len() >= 8 && data[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("png");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    if data.len() >= 6 && (&data[0..6] == b"GIF87a" || &data[0..6] == b"GIF89a") {
        return Some("gif");
    }
    None
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
        return Json(ApiResponse::error("只支持 JPG/PNG/WebP/GIF 图片"));
    };

    let dir = upload_dir().join("avatars");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::error!("[profile] 建头像目录失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("服务端存储不可用，请稍后再试"));
    }
    // 文件名由服务端拼（uid 来自已验签的令牌、时间是本地钟面），客户端那串名字一个
    // 字节都不参与——路径穿越在这里结构上不可能。
    let fname = format!("{}_{}.{}", uid, chrono::Local::now().format("%Y%m%d%H%M%S"), ext);
    let path = dir.join(&fname);
    let mut f = match tokio::fs::File::create(&path).await {
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
            if !name.contains('/') && name.starts_with(&format!("{}_", uid)) {
                let _ = tokio::fs::remove_file(upload_dir().join("avatars").join(name)).await;
            }
        }
    }
    Json(ApiResponse::success(AvatarDto { avatar: url }))
}

// ── 收藏的文章 ──────────────────────────────────────────────────────────────

/// 公开可见判据（与 `notes.rs` 的列表/详情/搜索**逐字同源**：is_public 且非 draft）。
/// 收藏只认公开可见的文章——否则收藏列表会把草稿标题漏给普通用户。
fn visible_note(n: &note::Model) -> bool {
    n.is_public && n.status.as_deref() != Some("draft")
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

/// GET /api/protected/favorites：我的收藏（个人中心「收藏的文章」）。
pub async fn list_favorites(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<FavoriteDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let favs = match user_favorite::Entity::find()
        .filter(user_favorite::Column::UserId.eq(uid))
        .order_by_desc(user_favorite::Column::CreatedAt)
        .order_by_desc(user_favorite::Column::Id)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[profile] 收藏列表查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    if favs.is_empty() {
        return Json(ApiResponse::success(vec![]));
    }
    let ids: Vec<i32> = favs.iter().map(|f| f.note_id).collect();
    let notes = note::Entity::find()
        .filter(note::Column::Id.is_in(ids))
        .all(&state.db)
        .await
        .unwrap_or_default();
    let mut by_id: HashMap<i32, note::Model> = notes.into_iter().map(|n| (n.id, n)).collect();
    let dtos = favs
        .into_iter()
        // 文章被隐藏/转草稿/删掉的不再列出（删掉的连行都没了，这里管的是"还在但不公开"）
        .filter_map(|f| {
            let n = by_id.remove(&f.note_id)?;
            if !visible_note(&n) {
                return None;
            }
            Some(FavoriteDto {
                note_id: n.id,
                title: n.title.clone(),
                status: n.status.unwrap_or_else(|| "published".to_string()),
                created_at: f.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
            })
        })
        .collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct FavoriteRequest {
    #[serde(rename = "noteId")]
    pub note_id: i32,
}

/// POST /api/protected/favorites：收藏（重复收藏幂等成功——`uq_favorite_user_note` 是
/// 数据库那一层的保证，这里先查一次是为了给出稳定的语义，不靠捕获唯一键冲突的错码）。
pub async fn add_favorite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<FavoriteRequest>,
) -> Json<ApiResponse<String>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let Some(n) = note::Entity::find_by_id(payload.note_id).one(&state.db).await.unwrap_or(None) else {
        return Json(ApiResponse::error("这篇文章不存在"));
    };
    if !visible_note(&n) {
        return Json(ApiResponse::error("这篇文章不可见，无法收藏"));
    }
    let existed = user_favorite::Entity::find()
        .filter(user_favorite::Column::UserId.eq(uid))
        .filter(user_favorite::Column::NoteId.eq(payload.note_id))
        .one(&state.db)
        .await
        .unwrap_or(None)
        .is_some();
    if !existed {
        let am = user_favorite::ActiveModel {
            user_id: Set(uid),
            note_id: Set(payload.note_id),
            ..Default::default()
        };
        if let Err(e) = am.insert(&state.db).await {
            // 并发下两个请求同时走到这里 → `uq_favorite_user_note` 拦下第二个。
            // **不能只看错误类型断言"是撞唯一键"**（MySQL 侧是 sqlx 的数据库错误，
            // 各驱动形状不一）——回查一次：现在真有一行就是"已收藏"，否则才是真失败。
            let now_exists = user_favorite::Entity::find()
                .filter(user_favorite::Column::UserId.eq(uid))
                .filter(user_favorite::Column::NoteId.eq(payload.note_id))
                .one(&state.db)
                .await
                .unwrap_or(None)
                .is_some();
            if !now_exists {
                tracing::error!("[profile] 收藏失败 uid={} note={}: {}", uid, payload.note_id, e);
                return Json(ApiResponse::error("收藏失败，请稍后再试"));
            }
        }
    }
    Json(ApiResponse::success("已收藏".to_string()))
}

/// DELETE /api/protected/favorites/:noteId：取消收藏（没收藏过也返回成功——同一个按钮
/// 点两次不该出错）。
pub async fn remove_favorite(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(note_id): axum::extract::Path<i32>,
) -> Json<ApiResponse<String>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    match user_favorite::Entity::delete_many()
        .filter(user_favorite::Column::UserId.eq(uid))
        .filter(user_favorite::Column::NoteId.eq(note_id))
        .exec(&state.db)
        .await
    {
        Ok(_) => Json(ApiResponse::success("已取消收藏".to_string())),
        Err(e) => {
            tracing::error!("[profile] 取消收藏失败 uid={} note={}: {}", uid, note_id, e);
            Json(ApiResponse::error("取消失败，请稍后再试"))
        }
    }
}

// ── 通知（红点数据源）与站内公告 ────────────────────────────────────────────

#[derive(Serialize, Default)]
pub struct NotificationDto {
    pub id: i32,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub content: String,
    pub link: Option<String>,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Default)]
pub struct NotificationListDto {
    pub unread: i64,
    pub items: Vec<NotificationDto>,
}

/// 未读汇总：头像红点的唯一数据源（一次请求拿全，前端不必并发几次）。
#[derive(Serialize, Default)]
pub struct UnreadDto {
    pub notifications: i64,
    pub messages: i64,
    pub total: i64,
    /// 等人工裁决的留言条数（后台首页那行"N 条评论待人工审核"；非管理员恒 0）。
    /// **不计进 `total`**：红点是"你有事没看"，待审是"后台有事等你处理"，
    /// 两件不同的事——`total` 只服务红点（前端拿它决定亮不亮）。
    #[serde(rename = "pendingReview")]
    pub pending_review: i64,
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
/// 这里只要一个数——**不为一行提示把整张表拉进内存**（原来后台首页就是这么干的）。
async fn board_pending_count(db: &sea_orm::DatabaseConnection) -> i64 {
    talk::Entity::find()
        .filter(talk::Column::Src.eq("board"))
        .filter(talk::Column::Approved.eq(0))
        .count(db)
        .await
        .unwrap_or(0) as i64
}

async fn unread_counts(db: &sea_orm::DatabaseConnection, uid: i32) -> UnreadDto {
    let n = user_notification::Entity::find()
        .filter(user_notification::Column::UserId.eq(uid))
        .filter(user_notification::Column::IsRead.eq(false))
        .count(db)
        .await
        .unwrap_or(0) as i64;
    let m = user_message::Entity::find()
        .filter(user_message::Column::ToUserId.eq(uid))
        .filter(user_message::Column::IsRead.eq(false))
        .count(db)
        .await
        .unwrap_or(0) as i64;
    // 待审数只在"能进后台的人"这里算：它是后台的待办，不该出现在普通用户的红点数据里
    // （角色的判据在 is_console_user，这里只是决定要不要发这一条 COUNT）
    let pending_review = if is_console_user(db, uid).await {
        board_pending_count(db).await
    } else {
        0
    };
    UnreadDto { notifications: n, messages: m, total: n + m, pending_review }
}

/// GET /api/protected/notifications/summary：红点（未读数）。
/// **红点 = 通知未读 + 私信未读**：公告在发布时按用户展开成 `type=announcement`
/// 的通知行（见 announcements.rs），所以公告天然计入，不需要第二套计数。
pub async fn notification_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<UnreadDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    Json(ApiResponse::success(unread_counts(&state.db, uid).await))
}

/// GET /api/protected/notifications：通知列表（含公告类）。
pub async fn list_notifications(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<NotificationListDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let rows = match user_notification::Entity::find()
        .filter(user_notification::Column::UserId.eq(uid))
        .order_by_desc(user_notification::Column::CreatedAt)
        .order_by_desc(user_notification::Column::Id)
        .limit(100)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[profile] 通知列表查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let unread = rows.iter().filter(|r| !r.is_read).count() as i64;
    let items = rows
        .into_iter()
        .map(|r| NotificationDto {
            id: r.id,
            kind: r.kind,
            title: r.title,
            content: r.content.unwrap_or_default(),
            link: r.link,
            is_read: r.is_read,
            created_at: r.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        })
        .collect();
    Json(ApiResponse::success(NotificationListDto { unread, items }))
}

#[derive(Deserialize)]
pub struct ReadRequest {
    #[serde(default)]
    pub ids: Vec<i32>,
    /// true = 全部标记已读（`ids` 一起传时忽略它，语义不混）
    #[serde(default)]
    pub all: bool,
}

/// POST /api/protected/notifications/read：标记已读（按 id 或全部）。
/// 返回标记后的未读汇总，前端拿它直接刷新红点，省一次往返。
pub async fn read_notifications(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ReadRequest>,
) -> Json<ApiResponse<UnreadDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let now = chrono::Local::now().naive_local();
    let mut q = user_notification::Entity::update_many()
        .col_expr(
            user_notification::Column::IsRead,
            sea_orm::sea_query::Expr::value(true),
        )
        .col_expr(
            user_notification::Column::ReadAt,
            sea_orm::sea_query::Expr::value(Some(now)),
        )
        .filter(user_notification::Column::UserId.eq(uid))
        .filter(user_notification::Column::IsRead.eq(false));
    if !payload.all {
        if payload.ids.is_empty() {
            return Json(ApiResponse::success(unread_counts(&state.db, uid).await));
        }
        q = q.filter(user_notification::Column::Id.is_in(payload.ids.clone()));
    }
    if let Err(e) = q.exec(&state.db).await {
        tracing::error!("[profile] 标记已读失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("操作失败，请稍后再试"));
    }
    Json(ApiResponse::success(unread_counts(&state.db, uid).await))
}

// ── 站内信箱 ────────────────────────────────────────────────────────────────

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
    /// 信件标题（20260922 起）。null = 对方没填标题（含所有历史信件）——
    /// 前端据此显示「（无标题）」，不拿正文首行顶替。
    pub title: Option<String>,
    pub content: String,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Default)]
pub struct MailboxDto {
    pub inbox: Vec<MessageDto>,
    pub outbox: Vec<MessageDto>,
    pub unread: i64,
}

const MESSAGE_MAX_CHARS: usize = 500;
/// 信件标题上限（20260922 起）。比正文短得多——标题是列表里一行扫过去的东西，
/// 前端输入框 maxLength 也是 60，两处同值。
const MESSAGE_TITLE_MAX_CHARS: usize = 60;

/// 两个人的展示信息：`(展示名, 头像)`，查不到就退化成「用户#id」——
/// 宁可显示得笨，也不编一个名字出来。
async fn peer_map(
    db: &sea_orm::DatabaseConnection,
    ids: &[i32],
) -> HashMap<i32, (String, Option<String>)> {
    if ids.is_empty() {
        return HashMap::new();
    }
    let users = user::Entity::find()
        .filter(user::Column::Id.is_in(ids.to_vec()))
        .all(db)
        .await
        .unwrap_or_default();
    users
        .into_iter()
        .map(|u| {
            let name = if u.nickname.trim().is_empty() { u.username.clone() } else { u.nickname };
            (u.id, (name, u.avatar))
        })
        .collect()
}

fn to_message_dto(
    m: user_message::Model,
    uid: i32,
    peers: &HashMap<i32, (String, Option<String>)>,
) -> MessageDto {
    let peer_id = if m.from_user_id == uid { m.to_user_id } else { m.from_user_id };
    let (name, avatar) = peers
        .get(&peer_id)
        .cloned()
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

/// GET /api/protected/messages：我的信箱（收件箱 + 发件箱，各最近 100 条）。
pub async fn list_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<MailboxDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let inbox = match user_message::Entity::find()
        .filter(user_message::Column::ToUserId.eq(uid))
        .order_by_desc(user_message::Column::CreatedAt)
        .order_by_desc(user_message::Column::Id)
        .limit(100)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[profile] 收件箱查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let outbox = user_message::Entity::find()
        .filter(user_message::Column::FromUserId.eq(uid))
        .order_by_desc(user_message::Column::CreatedAt)
        .order_by_desc(user_message::Column::Id)
        .limit(100)
        .all(&state.db)
        .await
        .unwrap_or_default();
    let unread = inbox.iter().filter(|m| !m.is_read).count() as i64;
    let mut ids: Vec<i32> = inbox.iter().map(|m| m.from_user_id).collect();
    ids.extend(outbox.iter().map(|m| m.to_user_id));
    ids.sort_unstable();
    ids.dedup();
    let peers = peer_map(&state.db, &ids).await;
    Json(ApiResponse::success(MailboxDto {
        inbox: inbox.into_iter().map(|m| to_message_dto(m, uid, &peers)).collect(),
        outbox: outbox.into_iter().map(|m| to_message_dto(m, uid, &peers)).collect(),
        unread,
    }))
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    #[serde(rename = "toUsername")]
    pub to_username: String,
    /// 信件标题（20260922 起，**选填**）：`default` 是刻意的——旧版前端不带这个字段，
    /// 缺字段要按"没填标题"处理，不能整个请求反序列化失败。
    #[serde(default)]
    pub title: Option<String>,
    pub content: String,
}

/// POST /api/protected/messages：发一条站内信。
///
/// 收件人**按账号或 UID 精确匹配**（20260923 用户要求：「收件逻辑按收件人账号或者 UID，
/// 昵称不能保证唯一性」——原昵称通道整条撤掉，它最多只能做到"唯一命中才认"，
/// 而唯一性本身不该由发信人赌）。
///
/// 顺序 = 先账号、后 UID：账号是这个站唯一且不可改的标识，先认它不会认错；
/// **只在账号没命中且输入是纯数字时才退回 UID 通道**（账号允许含数字，反过来先认 UID
/// 就会让一个叫 "7" 的账号永远收不到信）。
/// 本站不提供用户名录接口——收件人要自己填，避免把全站用户暴露成可枚举的资源。
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
    let name = if t.nickname.trim().is_empty() { t.username.clone() } else { t.nickname.clone() };
    let peers = HashMap::from([(t.id, (name, t.avatar.clone()))]);
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
        .filter(user_message::Column::ToUserId.eq(uid))
        .filter(user_message::Column::IsRead.eq(false));
    if !payload.all {
        if payload.ids.is_empty() {
            return list_messages(State(state), headers).await;
        }
        q = q.filter(user_message::Column::Id.is_in(payload.ids.clone()));
    }
    if let Err(e) = q.exec(&state.db).await {
        tracing::error!("[profile] 私信标记已读失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("操作失败，请稍后再试"));
    }
    list_messages(State(state), headers).await
}

// ── 我的留言记录 ────────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
pub struct MyTalkDto {
    pub id: i32,
    /// 来源。**20260922 起本接口只回河灯留言（`board`）**，所以恒等于 "board"；
    /// 字段保留不删是为了 JSON 契约稳定（前端按它做显示侧兜底，见 UserCenter 的 boardTalks）。
    pub src: String,
    pub title: String,
    pub content: String,
    pub cat: String,
    pub v: i32,
    pub author: String,
    /// 1=通过（公开可见）/ 0=待审 / 2=未通过（驳回）——**如实回传**，本人的记录自己看得到状态
    pub approved: i32,
    /// 驳回理由（20260923）：仅 approved=2 时可能有值，其余恒 null。与灯影集「我的河灯」
    /// 同源（都读 `talk.reject_reason`），个人中心这张表在未通过行里显示它。
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// GET /api/protected/my/talks：我的留言记录（**只含河灯留言**，按时间倒序）。
///
/// 20260922 用户反馈「说说不是留言，为什么还出现在这里并且有审核状态」——
/// 说说（`src='talk'`）是站内随笔，发布时恒 `approved=1`、**不进审核**（见 talks.rs
/// `insert_talk`），混进这张名为"留言记录"的表里既名不副实、又让人读成"说说也要审核"。
/// ⇒ 本接口加 `src='board'` 过滤；说说本人内容仍可在「说说」页看到，入口没有丢。
///
/// 与灯影集「我的河灯」（`/api/protect/board/mine`）并行存在：那个接口含收回操作、
/// 是灯影集页签的数据源；这里是个人中心的一览，只读。
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

// ── 站内信草稿箱（20260923）─────────────────────────────────────────────────
//
// 用户原话：「收件箱，发件箱和写站内信在一个层级，再加上草稿箱，这四个作为站内信箱的
// 二级签页」。草稿要有地方存 ⇒ 新表 `user_message_draft`（**迁移没跑之前这三个端点会
// 报「查询失败」**——表不存在。flag `user_message_draft_20260923`）。
//
// 三条纪律与站内信本身一致：uid 取自 handler 首行（无缺省值）、每个查询都带
// `user_id = uid`、时间列是 +08:00 本地钟面。

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
        // ── 改：必须是自己那条（越权在这里被 SQL 挡住，不是靠前端"不传别人的 id"）──
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
        // ── 新建 ──
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
