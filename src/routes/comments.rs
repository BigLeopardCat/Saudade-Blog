use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, QueryTrait, Select, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};

use super::moderation::{page_window, ReviewStatus};
use crate::entity::{note, note_comment, user};
use crate::utils::{ApiResponse, ApiResponsePage};

use super::AppState;

/// 评论正文上限（**字符数**不是字节数）。与留言板的 500 分开定：讨论区是短回复，
/// 300 字足够表达一个观点，也让两层的排版不会一条占满整屏。
const MAX_COMMENT_CHARS: usize = 300;

/// 后台列表一次最多回多少条（与其它后台列表同量级；讨论区量与留言板同级，不分页）。
const ADMIN_PAGE_LIMIT: u64 = 500;

/// 公开可见性与文章列表保持一致。
pub(super) async fn note_visible(db: &sea_orm::DatabaseConnection, note_id: i32) -> bool {
    note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .filter(note::Column::Id.eq(note_id))
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.is_in(super::notes::public_status_words()))
        .into_tuple::<i32>()
        .one(db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// 删除控制字符但保留换行，并去除首尾空白；HTML 安全由渲染层处理。
fn clean_content(raw: &str) -> String {
    raw.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

// DTO

/// 顶层与回复使用扁平 DTO，由 rootId 分组；列表批量查询，避免逐行读取。
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
    pub up: i64,
    pub down: i64,
    #[serde(rename = "myVote")]
    pub my_vote: i16,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// 未知 sort 值回落 hot，保留可解析的列表响应。
#[derive(Deserialize)]
pub struct CommentListQuery {
    /// `hot`（缺省）/ `new`。**只有 `new` 会改变行为**，其余一律当 `hot`。
    pub sort: Option<String>,
}

/// 为热度计算提供一赞一踩的先验，避免零票评论固定为零分。
const HOT_PRIOR_VOTES: f64 = 1.0;

/// 95% Wilson 置信下界的 z 值。
const HOT_Z: f64 = 1.96;

/// 回复热度的对数权重；不设硬上限。
const HOT_REPLY_WEIGHT: f64 = 0.1;

/// 含先验票的 Wilson 下界加 HOT_REPLY_WEIGHT * log2(1 + replies)。
fn hot_score(up: i64, down: i64, replies: i64) -> f64 {
    let (up_f, down_f) = (up as f64 + HOT_PRIOR_VOTES, down as f64 + HOT_PRIOR_VOTES);
    let n = up_f + down_f;
    let p = up_f / n;
    let z2 = HOT_Z * HOT_Z;
    let lower = (p + z2 / (2.0 * n) - HOT_Z * (p * (1.0 - p) / n + z2 / (4.0 * n * n)).sqrt())
        / (1.0 + z2 / n);
    lower + HOT_REPLY_WEIGHT * (replies as f64 + 1.0).log2()
}

/// 热度量化为微单位整数，以评论 id 决定同分顺序。
fn hot_key(score: f64, id: i32) -> (i64, i32) {
    ((score * 1_000_000.0).round() as i64, id)
}

// 公开读

pub async fn list_comments(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
    Query(q): Query<CommentListQuery>,
) -> Json<ApiResponse<Vec<CommentDto>>> {
    // 过期身份按匿名读取；登录身份决定 mine，匿名投票身份仍可决定 myVote。
    let who = super::note_stats::optional_who(&state.db, &headers).await;
    let uid = who.as_ref().and_then(|w| w.uid());
    if !note_visible(&state.db, note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }
    // 排序口径：缺省与**未知值**都当 `hot`（未知值绝不能 reject，见 `CommentListQuery`）。
    let sort_hot = !matches!(q.sort.as_deref(), Some("new"));
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
    // 回复计数包含公开且未删除的整棵回复子树。
    let mut reply_counts: std::collections::HashMap<i32, i64> = std::collections::HashMap::new();
    for r in &replies {
        if let Some(root) = r.root_id {
            *reply_counts.entry(root).or_insert(0) += 1;
        }
    }
    // 展示名一次取全：作者与"被回复者"共用同一份 map（回复者可能不是本页任何一条的作者）
    let mut uids: Vec<i32> = tops.iter().map(|c| c.user_id).collect();
    uids.extend(tops.iter().filter_map(|c| c.reply_to_uid));
    uids.extend(replies.iter().map(|c| c.user_id));
    uids.extend(replies.iter().filter_map(|c| c.reply_to_uid));
    uids.sort_unstable();
    uids.dedup();
    let peers = super::profile::peer_map(&state.db, &uids).await;
    // 批量读取票数；票数不可用时仍展示评论正文。
    let ids: Vec<i32> = tops.iter().chain(replies.iter()).map(|c| c.id).collect();
    let counts = super::comment_votes::vote_counts_for(&state.db, &ids)
        .await
        .unwrap_or_default();
    let mine = super::comment_votes::my_votes(&state.db, &ids, who.as_ref()).await;
    // 只对顶层按热度排序；回复保留时间顺序。
    let mut tops = tops;
    if sort_hot {
        let mut scored: Vec<((i64, i32), note_comment::Model)> = tops
            .into_iter()
            .map(|c| {
                let (up, down) = counts.get(&c.id).copied().unwrap_or((0, 0));
                let replies = reply_counts.get(&c.id).copied().unwrap_or(0);
                (hot_key(hot_score(up, down, replies), c.id), c)
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0)); // 降序：热度高的在前；同分则 id 大的在前
        tops = scored.into_iter().map(|(_, c)| c).collect();
    }
    // 顶层在前、回复在后，保持输出顺序稳定。
    let mut rows = tops;
    rows.extend(replies);
    let dtos: Vec<CommentDto> = rows
        .into_iter()
        .map(|c| {
            let (up, down) = counts.get(&c.id).copied().unwrap_or((0, 0));
            to_dto(
                &c,
                uid,
                &peers,
                super::comment_votes::CommentVoteDto {
                    up,
                    down,
                    my_vote: mine.get(&c.id).copied().unwrap_or(0),
                },
            )
        })
        .collect();
    Json(ApiResponse::success(dtos))
}

/// DTO 所需作者与票数由调用方批量读取。
fn to_dto(
    c: &note_comment::Model,
    me: Option<i32>,
    peers: &std::collections::HashMap<i32, super::profile::PeerInfo>,
    vote: super::comment_votes::CommentVoteDto,
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
        // 账号不可用时返回 None，由前端显示已注销状态。
        reply_to_nickname: c
            .reply_to_uid
            .and_then(|u| peers.get(&u).map(|p| p.name.clone())),
        user_id: c.user_id,
        nickname,
        avatar,
        role,
        mine: me == Some(c.user_id),
        up: vote.up,
        down: vote.down,
        my_vote: vote.my_vote,
        created_at: c.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

/// Persist a reply notice; errors propagate to the caller's transaction.
pub(crate) async fn notify_comment_reply_checked<C: sea_orm::ConnectionTrait>(
    db: &C,
    target_uid: i32,
    note_id: i32,
    comment_id: i32,
    replier_uid: i32,
    content: &str,
) -> Result<i32, String> {
    let account = user::Entity::find_by_id(replier_uid)
        .select_only()
        .column(user::Column::Username)
        .column(user::Column::Nickname)
        .into_tuple::<(String, String)>()
        .one(db)
        .await
        .map_err(|error| error.to_string())?;
    let who = account
        .map(|(username, nickname)| {
            if nickname.trim().is_empty() {
                username
            } else {
                nickname
            }
        })
        .unwrap_or_else(|| "有人".to_string());
    let brief = super::talks::talk_brief(content);
    super::notice::push_notice_checked(
        db,
        target_uid,
        "有人回复了你的评论",
        Some(format!("{who} 回复了你：{brief}")),
        Some(format!("/article/{note_id}?cid={comment_id}")),
    )
    .await
}

/// 通知失败不回滚已经保存的评论。
async fn notify_comment_reply(
    db: &sea_orm::DatabaseConnection,
    target_uid: i32,
    note_id: i32,
    comment_id: i32,
    replier_uid: i32,
    content: &str,
) {
    if let Err(error) =
        notify_comment_reply_checked(db, target_uid, note_id, comment_id, replier_uid, content)
            .await
    {
        tracing::error!("comment reply notification failed target={target_uid}: {error}");
    }
}

// 公开写

#[derive(Deserialize)]
pub struct CreateComment {
    pub content: String,
    /// 只接收直接父评论 id；root_id 与 reply_to_uid 从父行派生。
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<i32>,
}

/// 返回评论 id 和实际审核状态，供前端区分公开与待审。
#[derive(Serialize, Default)]
pub struct CreateCommentResult {
    pub id: i32,
    /// 0=待人工复核（公开侧看不到）/ 1=已公开 / 2=未通过
    pub approved: i16,
}

/// 登录后创建评论；审核在事务外完成，保存与图库引用校验在同一短事务。
pub async fn create_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
    Json(payload): Json<CreateComment>,
) -> Json<ApiResponse<CreateCommentResult>> {
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
    let cfg = crate::risk::load_config(&state.db).await;
    let forced = match crate::risk::screen(&state, uid, &cfg).await {
        // 风控拒绝独立于内容审核裁决。
        Ok(risk_verdict) => crate::risk::apply_verdict(&state, uid, &cfg, risk_verdict).await,
        Err(reject) => return Json(ApiResponse::error(&reject.message())),
    };
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
            // 拒绝回复待审、未通过或已删除的评论。
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
        match super::web_info::review_switches_of(&state.db, ai_key, manual_key).await {
            Ok(switches) => switches,
            Err(e) => return super::db_error("读取评论审核设置", &e),
        };
    let (approved, ai_result, ai_reason, reject_reason) =
        super::talks::decide_review("comment", uid, &content, ai_on, manual_on).await;
    // 风控只将原本通过的评论改为待审，不撤销已作出的拒绝。
    let approved = if forced && approved == 1 { 0 } else { approved };
    // 仅公开且不是回复自己的评论需要通知正文。
    let reply_target = match (approved, reply_to_uid) {
        (1, Some(t)) if t != uid => Some(t),
        _ => None,
    };
    let notice_src = reply_target.map(|_| content.clone());
    // External moderation is complete before taking the gallery reference fence.
    let transaction = match state.db.begin().await {
        Ok(transaction) => transaction,
        Err(error) => {
            tracing::error!("comment transaction failed uid={uid} note={note_id}: {error}");
            return Json(ApiResponse::error("评论失败，请稍后再试"));
        }
    };
    // Match article writers' note -> reference fence -> image lock order.
    let visible = note::Entity::find_by_id(note_id)
        .select_only()
        .column(note::Column::Id)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.is_in(super::notes::public_status_words()))
        .lock(sea_orm::sea_query::LockType::KeyShare)
        .into_tuple::<i32>()
        .one(&transaction)
        .await;
    match visible {
        Ok(Some(_)) => {}
        Ok(None) => return Json(ApiResponse::error("文章不存在或不可见")),
        Err(error) => {
            tracing::error!("comment article lock failed uid={uid} note={note_id}: {error}");
            return Json(ApiResponse::error("评论失败，请稍后再试"));
        }
    }
    if let Err(error) = super::gallery::references::guard_texts(&transaction, &[&content]).await {
        return match error {
            DbErr::Custom(_) => Json(ApiResponse::error(
                "评论使用了已删除的图片，请移除相关链接后重试",
            )),
            error => {
                tracing::error!(
                    "comment image reference check failed uid={uid} note={note_id}: {error}"
                );
                Json(ApiResponse::error("评论失败，请稍后再试"))
            }
        };
    }
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
    match note_comment::Entity::insert(row).exec(&transaction).await {
        Ok(r) => {
            if let Err(error) = transaction.commit().await {
                tracing::error!("comment commit failed uid={uid} note={note_id}: {error}");
                return Json(ApiResponse::error("评论失败，请稍后再试"));
            }
            let id = r.last_insert_id as i32;
            if let (Some(target), Some(src)) = (reply_target, notice_src.as_deref()) {
                notify_comment_reply(&state.db, target, note_id, id, uid, src).await;
            }
            Json(ApiResponse::success(CreateCommentResult { id, approved }))
        }
        Err(e) => {
            tracing::error!("[comment] 落库失败 uid={uid} note={note_id}: {e}");
            Json(ApiResponse::error("评论失败，请稍后再试"))
        }
    }
}

/// 按作者身份软删除评论；公开列表同时隐藏其回复。
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

// 后台

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
    pub approved: i16,
    #[serde(rename = "aiResult")]
    pub ai_result: Option<String>,
    /// 驳回理由；null = 未驳回或没人写过理由（后台显示「未填写」）
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
    /// AI 审核说明仅供后台展示，与最终审核状态独立。
    #[serde(rename = "aiReason")]
    pub ai_reason: Option<String>,
    /// 软删除状态仅供后台展示；已删除评论不可再次审核。
    #[serde(rename = "isDeleted")]
    pub is_deleted: i16,
}

/// 后台分页为显式选项，未分页读取保留上限。
#[derive(Deserialize)]
pub struct CommentAdminQuery {
    pub id: Option<i32>,
    pub status: Option<ReviewStatus>,
    pub q: Option<String>,
    pub note_id: Option<i32>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub(super) fn comment_admin_filter(q: &CommentAdminQuery) -> Select<note_comment::Entity> {
    let mut finder = note_comment::Entity::find();
    if let Some(id) = q.id {
        finder = finder.filter(note_comment::Column::Id.eq(id));
    }
    if let Some(status) = q.status {
        finder = finder.filter(note_comment::Column::Approved.eq(status.approved()));
    }
    if let Some(id) = q.note_id {
        finder = finder.filter(note_comment::Column::NoteId.eq(id));
    }
    if let Some(kw) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let pat = format!("%{}%", crate::search_core::like_escape(kw));
        let authors = user::Entity::find()
            .select_only()
            .column(user::Column::Id)
            .filter(
                Condition::any()
                    .add(user::Column::Username.into_expr().ilike(&pat))
                    .add(user::Column::Nickname.into_expr().ilike(&pat)),
            )
            .into_query();
        finder = finder.filter(
            Condition::any()
                .add(note_comment::Column::Content.into_expr().ilike(&pat))
                .add(note_comment::Column::UserId.in_subquery(authors)),
        );
    }
    finder
        .order_by_desc(note_comment::Column::CreatedAt)
        .order_by_desc(note_comment::Column::Id)
}

/// 后台评论列表；筛选影响视图，不改变审核权限。
pub async fn list_comments_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<CommentAdminQuery>,
) -> Json<ApiResponsePage<Vec<CommentAdminDto>>> {
    let Some(_uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponsePage::error("请先登录"));
    };
    let window = match page_window(q.page, q.page_size) {
        Ok(value) => value,
        Err(message) => return Json(ApiResponsePage::error(message)),
    };
    let total = if window.is_some() {
        match comment_admin_filter(&q).count(&state.db).await {
            Ok(n) => Some(n as i64),
            Err(error) => {
                tracing::error!("[comment] count failed: {error}");
                return Json(ApiResponsePage::error("查询失败，请稍后再试"));
            }
        }
    } else {
        None
    };
    let mut finder = comment_admin_filter(&q);
    if let Some((size, offset)) = window {
        finder = finder.limit(size).offset(offset);
    } else {
        finder = finder.limit(ADMIN_PAGE_LIMIT);
    }
    let rows = match finder.all(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] list_comments_admin 查询失败: {e}");
            return Json(ApiResponsePage::error("查询失败，请稍后再试"));
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
                // 后台同时返回账号与展示名，公开侧仅返回展示名。
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
    Json(ApiResponsePage::success(dtos, total))
}

#[derive(Deserialize)]
pub struct AuditCommentBody {
    /// 请求 1=通过、0=驳回；驳回写入 approved=2，与待审区分。
    approved: i16,
    /// 驳回理由可空；通过时清空理由。
    #[serde(default)]
    reason: Option<String>,
}

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
    if c.is_deleted != 0 {
        return Json(ApiResponse::error("这条评论已删除，无法审核"));
    }
    let reject = payload.approved == 0;
    let saved_reason = c.reject_reason.clone();
    let saved_ai_reason = c.ai_reason.clone();
    // 转换 ActiveModel 前保留通知所需字段。
    let owner = c.user_id;
    let was_approved = c.approved;
    let note_id = c.note_id;
    let reply_target = c.reply_to_uid;
    let brief_src = c.content.clone();
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
        Ok(_) => {
            // 仅从未公开变为公开时通知，避免重复审核再次通知。
            let new_approved = if reject { 2 } else { 1 };
            if was_approved != 1 && new_approved == 1 {
                if let Some(t) = reply_target {
                    if t != owner {
                        notify_comment_reply(&state.db, t, note_id, id, owner, &brief_src).await;
                    }
                }
            }
            Json(ApiResponse::success("Audited".to_string()))
        }
        Err(e) => {
            tracing::error!("[comment] 人工复核落库失败 id={id}: {e}");
            Json(ApiResponse::error("操作失败，请稍后再试"))
        }
    }
}

/// 后台软删除与作者删除使用同一可见性规则。
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

    /// 正文清理保留换行并移除其余控制字符。
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

    /// 长度上限按字符计算，避免压缩中文可用长度。
    #[test]
    fn 长度上限按字符算() {
        assert_eq!(
            clean_content(&"啊".repeat(MAX_COMMENT_CHARS))
                .chars()
                .count(),
            MAX_COMMENT_CHARS
        );
        assert!("啊".repeat(MAX_COMMENT_CHARS + 1).chars().count() > MAX_COMMENT_CHARS);
    }

    /// 验证赞、踩和回复对热度的单调性。
    #[test]
    fn 热度分对三个信号都单调() {
        assert!(hot_score(3, 0, 0) > hot_score(2, 0, 0), "赞多 ⇒ 分高");
        assert!(hot_score(0, 3, 0) < hot_score(0, 2, 0), "踩多 ⇒ 分低");
        assert!(hot_score(1, 0, 5) > hot_score(1, 0, 4), "回复多 ⇒ 分高");
    }

    /// 先验使零票新评论的得分高于净负票评论。
    #[test]
    fn 零票评论高于净负票评论_低于有一条赞的() {
        assert!(
            hot_score(0, 0, 0) > hot_score(0, 1, 0),
            "0 票要高于净负票（先验的作用）"
        );
        assert!(
            hot_score(0, 0, 0) < hot_score(1, 0, 0),
            "但压不过真有一条赞的"
        );
    }

    #[test]
    fn 回复项是对数增长_没有上界() {
        let d = |n: i64| hot_score(0, 0, n);
        for n in [0_i64, 1, 3, 7, 15, 31] {
            let step = d(2 * n + 1) - d(n);
            assert!(
                (step - HOT_REPLY_WEIGHT).abs() < 1e-12,
                "回复数从 {n} 翻到 {} 该恰好加一个 α（{HOT_REPLY_WEIGHT}），实际 {step}",
                2 * n + 1
            );
        }
        assert!(d(100) < hot_score(30, 0, 0), "一百条回复还压不过 30 个赞");
        assert!(
            d(300) > hot_score(30, 0, 0),
            "但三百条就压过了 —— 回复项**没有上界**"
        );
    }

    /// 热度量化为微单位整数，以评论 id 决定同分顺序。
    #[test]
    fn 排序键是全序_同分按id降序() {
        let a = hot_key(hot_score(2, 0, 0), 7);
        let b = hot_key(hot_score(2, 0, 0), 9);
        assert_ne!(a, b, "同分必须靠 id 分出先后");
        assert!(b > a, "id 大的排前面（降序）");
        assert_eq!(a, hot_key(hot_score(2, 0, 0), 7), "同一份输入 ⇒ 同一个键");
    }

    /// 固定回复权重与赞踩分数的产品取舍。
    #[test]
    fn 交叉点_回复数与赞数的兑换率() {
        // 15 条回复（+0.40）能越过 5 赞 1 踩（0.409）——讨论量是强信号。
        assert!(hot_score(0, 0, 15) > hot_score(5, 1, 0));
        // 但 3 条回复（+0.20）越不过 5 赞 1 踩——随手聊两句不算热度。
        assert!(hot_score(0, 0, 3) < hot_score(5, 1, 0));
    }

    /// 验证热度公式的代表性数值。
    #[test]
    fn 读数对照表() {
        let round = |v: f64| (v * 1000.0).round() / 1000.0;
        assert_eq!(round(hot_score(0, 0, 0)), 0.095);
        assert_eq!(round(hot_score(1, 0, 0)), 0.208);
        assert_eq!(round(hot_score(5, 1, 0)), 0.409);
        assert_eq!(round(hot_score(0, 0, 15)), 0.495);
        assert_eq!(round(hot_score(0, 5, 0)), 0.026);
    }
}
