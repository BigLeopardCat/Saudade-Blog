//! 文章评论（20261002）：文章详情页底部的讨论区。
//!
//! 用户原话：「文章详情页底部增加讨论区，用户可以发布评论或者讨论，提供站内的表情包
//! 使用，注意防止 XSS 攻击，用户之间也可以在评论下面评论，相互回复。」
//!
//! ── 与河灯留言板的**关系**：审核链共用，存储各一张表 ──────────────────────
//! 审核走 `talks::decide_review`——留言板那条闸的**同一份实现**（不是照抄一份）；
//! 开关是**另一对键**（`web_info::COMMENT_REVIEW_KEYS`），两类内容可以分别开关。
//! 存储是 `note_comment` 表：评论挂文章、留言挂留言板，要展示的列完全不同
//! （理由见迁移文件头注）。
//!
//! ── 两层结构：回复的回复不另起一层 ────────────────────────────────────────
//! 请求体**只收 `parentId`**；`root_id` / `reply_to_uid` 全部由服务端从父行派生
//! （见 [`create_comment`]）。这既是"不信任客户端"的一般纪律，也是"回复的回复仍挂在
//! 同一个顶层评论下"的机械保证——客户端想造第三层都没有字段可填。
//!
//! ── XSS：防线在**渲染侧**，不在这一侧 ─────────────────────────────────────
//! 服务端只校验形状（trim、剥控制字符、限 300 字），**不做 HTML 转义**：转义会把
//! "用户打的字"和"库里存的字"变成两份真相，还会与渲染端的 markdown 管线二次处理。
//! 真正的防线是前端那条完整管线
//! （`frontend/src/utils/chatMarkdown.ts::renderBlogMarkdown` ——
//! remark-parse → gfm/breaks/gemoji/math → remarkStickers → rehype-raw → rehype-sanitize），
//! 评论、文章、看板娘对话框共用它。**任何地方都不许对评论原文直接 innerHTML。**
//!
//! ── 域：公开三条挂 `public_routes` ─────────────────────────────────────────
//! 评论要对全体登录用户（乃至未登录访客）开放，而 `protected_routes` 域内由
//! `auth_guard` 全量要求管理员——挂错了就是普通用户 403。所以公开读写挂
//! `public_routes`、后台管理挂 `protected_routes`，路由见 `routes/mod.rs`。

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set};
use serde::{Deserialize, Serialize};

use crate::entity::{note, note_comment};
use crate::utils::ApiResponse;

use super::AppState;

/// 评论正文上限（**字符数**不是字节数）。与留言板的 500 分开定：讨论区是短回复，
/// 300 字足够表达一个观点，也让两层的排版不会一条占满整屏。
const MAX_COMMENT_CHARS: usize = 300;

/// 后台列表一次最多回多少条（与其它后台列表同量级；讨论区量与留言板同级，不分页）。
const ADMIN_PAGE_LIMIT: u64 = 500;

/// 文章是否**公开可见**——与 `notes::list_public_notes` 的 STRICT FILTER 同一口径
/// （`is_public = 1` 且 `status <> 'draft'`）。两条读取路径**必须**同口径：否则会出现
/// "评论读得到、文章打不开"（或反过来）这种自相矛盾的组合。
async fn note_visible(db: &sea_orm::DatabaseConnection, note_id: i32) -> bool {
    note::Entity::find()
        .filter(note::Column::Id.eq(note_id))
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .one(db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// 正文的**形状**归一：剥掉除 `\n` 以外的全部 C0 控制字符，再去掉首尾空白。
///
/// 为什么留 `\n`：渲染管线的 breaks 插件拿它换行，评论里的分段是真实表达。
/// 为什么剥其余控制字符（`\r`、`\t`、退格、NUL…）：它们对读者没有意义，却能把一行
/// 撑得很长、或让后台列表的截断看起来莫名其妙；`\r` 尤其会在"存进去是 `\n`、
/// 显示出来多一个空格"这类问题上骗人（留言板那条 `talk_brief` 就为它专门拍过平）。
///
/// **不转义**：见文件头注「XSS 防线在渲染侧」。
fn clean_content(raw: &str) -> String {
    raw.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

// ── DTO ────────────────────────────────────────────────────────────────────

/// 公开读的一行（**扁平**：顶层与回复同形，由 `rootId` 区分，前端组树）。
///
/// 为什么回扁平数组而不是嵌套结构：讨论区只有一层嵌套，服务端组树的唯一好处是省掉
/// 前端几行 reduce，代价是每加一个字段都要改两处（顶层/回复）。扁平之后整个讨论区
/// 只要 **2 条查询**（顶层一次 + `root_id IN (…)` 一次），前端一次 `groupBy` 收尾。
#[derive(Serialize)]
pub struct CommentDto {
    pub id: i32,
    #[serde(rename = "noteId")]
    pub note_id: i32,
    pub content: String,
    /// 直接父评论 id；null = 顶层
    #[serde(rename = "parentId")]
    pub parent_id: Option<i32>,
    /// 顶层评论 id；**null = 本行就是顶层**（前端据此分组）
    #[serde(rename = "rootId")]
    pub root_id: Option<i32>,
    #[serde(rename = "replyToUid")]
    pub reply_to_uid: Option<i32>,
    /// 被回复者的**展示名**；null = 顶层，或对方账号已销（此时前端显示「已注销用户」）
    #[serde(rename = "replyToNickname")]
    pub reply_to_nickname: Option<String>,
    #[serde(rename = "userId")]
    pub user_id: i32,
    /// 作者的展示名（昵称优先、没设昵称退回账号，见 `profile::peer_map`）
    pub nickname: String,
    pub avatar: Option<String>,
    /// 角色（权限身份徽章用）。**从库里现读**，不是令牌快照
    pub role: String,
    /// 是否当前登录用户所发（删按钮的门控）。未登录恒 false
    pub mine: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// ── 公开读 ─────────────────────────────────────────────────────────────────

/// GET /api/public/notes/:id/comments —— 某篇文章的公开评论（顶层 + 全部回复）。
///
/// **未登录也能读**（文章详情页本身是公开的，讨论区跟着它）：此时 `mine` 恒 false。
/// 只回 `approved = 1` 且未软删的行——待审/未通过/已删除的评论在公开侧**不存在**，
/// 连"有一条被删了"都不透露。
pub async fn list_comments(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
) -> Json<ApiResponse<Vec<CommentDto>>> {
    let uid = super::talks::current_uid(&state.db, &headers).await;
    if !note_visible(&state.db, note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }
    // 先取顶层（新→旧：讨论区把最新的话题放最上面），再一次性取它们名下**全部**回复。
    let tops = note_comment::Entity::find()
        .filter(note_comment::Column::NoteId.eq(note_id))
        .filter(note_comment::Column::RootId.is_null())
        .filter(note_comment::Column::Approved.eq(1))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .order_by_desc(note_comment::Column::CreatedAt)
        .order_by_desc(note_comment::Column::Id) // 同秒多行排序确定
        .all(&state.db)
        .await;
    let tops = match tops {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] list_comments 顶层查询失败 note={note_id}: {e}");
            return Json(ApiResponse::error("读取失败，请稍后再试"));
        }
    };
    let top_ids: Vec<i32> = tops.iter().map(|c| c.id).collect();
    let replies = if top_ids.is_empty() {
        // 空表不发 `IN (NULL)` 白查询（同 list_board_admin）
        vec![]
    } else {
        note_comment::Entity::find()
            .filter(note_comment::Column::RootId.is_in(top_ids))
            .filter(note_comment::Column::Approved.eq(1))
            .filter(note_comment::Column::IsDeleted.eq(0))
            .order_by_asc(note_comment::Column::CreatedAt) // 回复按时间正序读下来才像对话
            .order_by_asc(note_comment::Column::Id)
            .all(&state.db)
            .await
            .unwrap_or_default()
    };
    // 顶层在前、回复随其后：前端只按 rootId 分组，不依赖这个顺序，
    // 但顺序稳定让无头断言与人工排查都能按"第 N 行"对账。
    let mut rows = tops;
    rows.extend(replies);
    // 展示名一次取全：作者与"被回复者"共用同一份 map（回复者可能不是本页任何一条的作者）
    let mut uids: Vec<i32> = rows.iter().map(|c| c.user_id).collect();
    uids.extend(rows.iter().filter_map(|c| c.reply_to_uid));
    uids.sort_unstable();
    uids.dedup();
    let peers = super::profile::peer_map(&state.db, &uids).await;
    let dtos: Vec<CommentDto> = rows
        .into_iter()
        .map(|c| to_dto(&c, uid, &peers))
        .collect();
    Json(ApiResponse::success(dtos))
}

/// 行 → DTO。`me` = 当前登录 uid（None = 未登录）。
fn to_dto(
    c: &note_comment::Model,
    me: Option<i32>,
    peers: &std::collections::HashMap<i32, super::profile::PeerInfo>,
) -> CommentDto {
    let (nickname, avatar, role) = match peers.get(&c.user_id) {
        Some(p) => (p.name.clone(), p.avatar.clone(), p.role.clone()),
        None => (format!("用户#{}", c.user_id), None, String::new()),
    };
    CommentDto {
        id: c.id,
        note_id: c.note_id,
        content: c.content.clone(),
        parent_id: c.parent_id,
        root_id: c.root_id,
        reply_to_uid: c.reply_to_uid,
        // 取不到人（账号已销）⇒ 回 None 让前端说「已注销用户」，
        // **不在这里编一个名字**（同 peer_map 的纪律）
        reply_to_nickname: c
            .reply_to_uid
            .and_then(|u| peers.get(&u).map(|p| p.name.clone())),
        user_id: c.user_id,
        nickname,
        avatar,
        role,
        mine: me == Some(c.user_id),
        created_at: c.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

// ── 公开写 ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateComment {
    pub content: String,
    /// **只收直接父评论 id**。`root_id` / `reply_to_uid` 由服务端从父行派生——
    /// 客户端无从伪造"我的回复挂在哪条顶层下"（见文件头注）。
    /// `default`：顶层评论不带这个字段。
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<i32>,
}

/// POST /api/public/notes/:id/comments —— 发一条评论/回复（强制登录）。
///
/// 返回新评论 id（前端据此定位到刚发的那条）。**待审时不返回"已发布"的意思**：
/// `approved` 由审核链路定，前端按接口返回的 id 去列表里找不到属正常现象
/// （待审的评论公开侧不存在），提示语由前端按 `approved` 决定——本接口只回 id。
pub async fn create_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
    Json(payload): Json<CreateComment>,
) -> Json<ApiResponse<i32>> {
    let Some(uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录后再评论"));
    };
    if !note_visible(&state.db, note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }
    let content = clean_content(&payload.content);
    if content.is_empty() {
        return Json(ApiResponse::error("评论不能为空"));
    }
    if content.chars().count() > MAX_COMMENT_CHARS {
        return Json(ApiResponse::error("评论过长（最多 300 字）"));
    }
    // 回复关系：**只信 parent_id**，三个列全部由父行派生。
    let (parent_id, root_id, reply_to_uid) = match payload.parent_id {
        None => (None, None, None),
        Some(pid) => {
            let parent = match note_comment::Entity::find_by_id(pid).one(&state.db).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("[comment] 查父评论失败 pid={pid}: {e}");
                    return Json(ApiResponse::error("评论失败，请稍后再试"));
                }
            };
            let Some(p) = parent else {
                return Json(ApiResponse::error("要回复的评论不存在"));
            };
            if p.note_id != note_id {
                return Json(ApiResponse::error("要回复的评论不属于这篇文章"));
            }
            // 不能回复一条**自己都看不见**的评论（待审 / 未通过 / 已删）：否则回复者
            // 会收到一个公开侧永远找不到落点的「回复成功」。
            if p.approved != 1 || p.is_deleted != 0 {
                return Json(ApiResponse::error("这条评论当前不可见，回复不了"));
            }
            (
                Some(p.id),
                // 顶层评论的 root_id 是 NULL ⇒ 回复顶层时，顶层自己就是 root
                Some(p.root_id.unwrap_or(p.id)),
                Some(p.user_id),
            )
        }
    };
    // 审核：与留言板**同一份裁决实现**，开关是评论自己那对键
    let (ai_key, manual_key) = super::web_info::COMMENT_REVIEW_KEYS;
    let (ai_on, manual_on) =
        super::web_info::review_switches_of(&state.db, ai_key, manual_key).await;
    let (approved, ai_result, ai_reason, reject_reason) =
        super::talks::decide_review("comment", uid, &content, ai_on, manual_on).await;
    let now = chrono::Local::now().naive_local();
    let row = note_comment::ActiveModel {
        note_id: Set(note_id),
        user_id: Set(uid),
        content: Set(content),
        root_id: Set(root_id),
        parent_id: Set(parent_id),
        reply_to_uid: Set(reply_to_uid),
        approved: Set(approved),
        ai_result: Set(ai_result),
        ai_reason: Set(ai_reason),
        reject_reason: Set(reject_reason),
        created_at: Set(now),
        updated_at: Set(now),
        // is_deleted 不进模型：交给库里的 DEFAULT 0（新行当然没删）
        ..Default::default()
    };
    match note_comment::Entity::insert(row).exec(&state.db).await {
        Ok(r) => Json(ApiResponse::success(r.last_insert_id as i32)),
        Err(e) => {
            tracing::error!("[comment] 落库失败 uid={uid} note={note_id}: {e}");
            Json(ApiResponse::error("评论失败，请稍后再试"))
        }
    }
}

/// DELETE /api/public/comments/:id —— 删自己的评论（**软删**）。
///
/// 只能删自己的（判据是库里的 `user_id`，不是请求里的任何东西）。顶层评论被软删后
/// 它名下的回复会一起从公开侧消失（组树时找不到顶层）——这是**想要**的行为：
/// 留着回复会变成一串没有上下文的孤儿。
pub async fn delete_my_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match note_comment::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] 查评论失败 id={id}: {e}");
            return Json(ApiResponse::error("删除失败，请稍后再试"));
        }
    };
    let Some(c) = row else {
        return Json(ApiResponse::error("评论不存在"));
    };
    if c.user_id != uid {
        // 别人的评论一律只说"不存在"，不确认它存在（防枚举别人删过什么）
        return Json(ApiResponse::error("评论不存在"));
    }
    let mut am: note_comment::ActiveModel = c.into();
    am.is_deleted = Set(1);
    am.updated_at = Set(chrono::Local::now().naive_local());
    match note_comment::Entity::update(am).exec(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
        Err(e) => {
            tracing::error!("[comment] 软删失败 id={id}: {e}");
            Json(ApiResponse::error("删除失败，请稍后再试"))
        }
    }
}

// ── 后台 ───────────────────────────────────────────────────────────────────

/// 后台列表的一行：评论本体 + 作者 + **挂在哪篇文章下**（管理员要能点回去看上下文）。
#[derive(Serialize)]
pub struct CommentAdminDto {
    pub id: i32,
    #[serde(rename = "noteId")]
    pub note_id: i32,
    /// 文章标题；查不到（文章已删）为空串，前端显示「（文章已删除）」
    #[serde(rename = "noteTitle")]
    pub note_title: String,
    pub content: String,
    #[serde(rename = "userId")]
    pub user_id: i32,
    pub username: String,
    pub nickname: String,
    /// 被回复者（「回复 @某人」那一行的 admin 侧镜像）；null = 顶层
    #[serde(rename = "replyToNickname")]
    pub reply_to_nickname: Option<String>,
    #[serde(rename = "createTime")]
    pub created_at: String,
    /// 0=待审 / 1=通过 / 2=未通过（与留言板同口径，后台两个现成组件可直接复用）
    pub approved: i8,
    /// AI 判定留痕：pass / flag / reject；null = 没走 AI
    pub ai_result: Option<String>,
    /// 驳回理由；null = 未驳回或没人写过理由（后台显示「未填写」）
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
    /// AI 审核说明：**与裁决无关**，pass/flag/reject 都可能有。管理员先看得到 AI 的
    /// 判断才写得出具体理由，所以后台带它、公开侧不带（内部注记不该发给全体访客）
    #[serde(rename = "aiReason")]
    pub ai_reason: Option<String>,
    pub is_deleted: i8,
}

/// GET /api/protect/comments —— 评论管理列表（全部状态，倒序）。
pub async fn list_comments_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<CommentAdminDto>>> {
    let Some(_uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let rows = match note_comment::Entity::find()
        .order_by_desc(note_comment::Column::CreatedAt)
        .order_by_desc(note_comment::Column::Id)
        .limit(ADMIN_PAGE_LIMIT)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] list_comments_admin 查询失败: {e}");
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    // 作者与"被回复者"共用一份（去重后 is_in，同 list_board_admin 的做法）
    let mut uids: Vec<i32> = rows.iter().map(|c| c.user_id).collect();
    uids.extend(rows.iter().filter_map(|c| c.reply_to_uid));
    uids.sort_unstable();
    uids.dedup();
    let peers = super::profile::peer_map(&state.db, &uids).await;
    // 文章标题：只取用到的两列（find() 是 SELECT *，会把正文一起捞出来）
    let mut note_ids: Vec<i32> = rows.iter().map(|c| c.note_id).collect();
    note_ids.sort_unstable();
    note_ids.dedup();
    let titles: std::collections::HashMap<i32, String> = if note_ids.is_empty() {
        std::collections::HashMap::new()
    } else {
        note::Entity::find()
            .select_only()
            .column(note::Column::Id)
            .column(note::Column::Title)
            .filter(note::Column::Id.is_in(note_ids))
            .into_tuple::<(i32, String)>()
            .all(&state.db)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect()
    };
    let dtos = rows
        .into_iter()
        .map(|c| {
            let (nickname, username) = match peers.get(&c.user_id) {
                Some(p) => (p.name.clone(), p.username.clone()),
                None => (format!("用户#{}", c.user_id), String::new()),
            };
            CommentAdminDto {
                id: c.id,
                note_id: c.note_id,
                note_title: titles.get(&c.note_id).cloned().unwrap_or_default(),
                content: c.content,
                user_id: c.user_id,
                // 后台要能按账号找到人（用户管理页是按账号列的），所以两个都给；
                // 公开侧只给 nickname（展示名），不发账号
                username,
                nickname,
                reply_to_nickname: c
                    .reply_to_uid
                    .and_then(|u| peers.get(&u).map(|p| p.name.clone())),
                created_at: c.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
                approved: c.approved,
                ai_result: c.ai_result,
                reject_reason: c.reject_reason,
                ai_reason: c.ai_reason,
                is_deleted: c.is_deleted,
            }
        })
        .collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct AuditCommentBody {
    /// 1=通过（放行展示）；0=驳回——写 `approved = 2`「未通过」，与待审(0) 区分
    /// （同留言板的 `AuditBody`：本人那一侧按 0 显示待审、2 显示未通过）
    approved: i8,
    /// 驳回理由，可空。**通过时请求里带什么都不生效**（改判即清空该列）。
    /// `serde(default)` 保证只发 approved 的调用方照常工作。
    #[serde(default)]
    reason: Option<String>,
}

/// PUT /api/protect/comments/:id/audit —— 评论人工复核。
///
/// 规则与 `talks::audit_board` **逐条对齐**（两条链路两个 handler、一套语义）：
///   · 裁决只写 `approved`，**不改写 `ai_result`**——AI 判定是历史留痕；
///   · 驳回理由走三级回落：**人工手填 > `reject_reason`（AI 判 reject 的说明）>
///     `ai_reason`（AI 存疑说明）**，三级都没有就保持 NULL，不往库里塞编好的话
///     （通知层的固定文案在通知那一层兜）；
///   · **改判回通过时清空 `reject_reason`**（不留"已通过却带驳回理由"的矛盾行），
///     `ai_reason` 不动（它是 AI 那一侧的留痕，不回溯）。
///
/// 通知（0→1 那条"你的评论已通过审核"）在**回复通知**那一笔里接上，与创建即通过
/// 那条路径共用同一个函数——两条路径各发一次会变成重复通知。
pub async fn audit_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<AuditCommentBody>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match note_comment::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] audit_comment 查询失败 id={id}: {e}");
            return Json(ApiResponse::error("操作失败，请稍后再试"));
        }
    };
    let Some(c) = row else {
        return Json(ApiResponse {
            code: 404,
            message: "Comment not found".to_string(),
            data: String::default(),
        });
    };
    let reject = payload.approved == 0;
    let saved_reason = c.reject_reason.clone();
    let saved_ai_reason = c.ai_reason.clone();
    let mut am: note_comment::ActiveModel = c.into();
    am.approved = Set(if reject { 2 } else { 1 });
    am.reject_reason = Set(if reject {
        payload
            .reason
            .as_deref()
            .and_then(super::talks::clip_reject_reason)
            .or(saved_reason)
            .or(saved_ai_reason)
    } else {
        None
    });
    am.updated_at = Set(chrono::Local::now().naive_local());
    match note_comment::Entity::update(am).exec(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Audited".to_string())),
        Err(e) => {
            tracing::error!("[comment] 人工复核落库失败 id={id}: {e}");
            Json(ApiResponse::error("操作失败，请稍后再试"))
        }
    }
}

/// DELETE /api/protect/comments/:id —— 后台删除（同样**软删**）。
///
/// 后台的删除与作者自删走同一个软删位：公开侧的行为必须一致（都是"连带回复一起消失"），
/// 否则同一个动作在两条路径下效果不同，排查时对不上账。
pub async fn delete_comment_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match note_comment::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] delete_comment_admin 查询失败 id={id}: {e}");
            return Json(ApiResponse::error("删除失败，请稍后再试"));
        }
    };
    let Some(c) = row else {
        return Json(ApiResponse::error("评论不存在"));
    };
    let mut am: note_comment::ActiveModel = c.into();
    am.is_deleted = Set(1);
    am.updated_at = Set(chrono::Local::now().naive_local());
    match note_comment::Entity::update(am).exec(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
        Err(e) => {
            tracing::error!("[comment] 后台软删失败 id={id}: {e}");
            Json(ApiResponse::error("删除失败，请稍后再试"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 正文归一：控制字符全剥、**`\n` 留着**、首尾空白去掉。
    ///
    /// `\n` 不能跟着一起剥：渲染管线的 breaks 插件拿它换行，分段是评论里的真实表达。
    /// `\r`/`\t`/NUL 则一律剥掉——它们对读者没有意义，却能让后台列表的截断看起来
    /// 莫名其妙（`\r\n` 不剥的话正文里会多出一个空格，留言板那条 `talk_brief`
    /// 就为它专门拍过平）。
    #[test]
    fn 正文归一_剥控制字符但留换行() {
        assert_eq!(clean_content("  你好  "), "你好");
        assert_eq!(clean_content("第一行\r\n第二行"), "第一行\n第二行");
        assert_eq!(clean_content("a\tb\u{0}c"), "abc");
        assert!(clean_content("上\n下").contains('\n'));
    }

    /// 纯空白 = 空：不能靠敲几个空格骗过「评论不能为空」。
    #[test]
    fn 纯空白不算内容() {
        assert!(clean_content("   \n\t  ").is_empty());
    }

    /// 上限按**字符**算不按字节：300 个汉字是 900 字节，按字节判会把中文评论的
    /// 上限压到 100 字（留言板那条 `clip_reject_reason` 的注释记过同一个坑）。
    #[test]
    fn 长度上限按字符算() {
        assert_eq!(clean_content(&"啊".repeat(MAX_COMMENT_CHARS)).chars().count(), MAX_COMMENT_CHARS);
        assert!("啊".repeat(MAX_COMMENT_CHARS + 1).chars().count() > MAX_COMMENT_CHARS);
    }
}
