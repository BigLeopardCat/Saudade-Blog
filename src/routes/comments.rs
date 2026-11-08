use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};

use crate::entity::{note, note_comment, user};
use crate::utils::ApiResponse;

use super::AppState;

/// 评论正文上限，按 Unicode 字符数计算。
const MAX_COMMENT_CHARS: usize = 300;

mod admin;
#[cfg(test)]
pub(super) use admin::comment_admin_filter;
pub use admin::list_comments_admin;

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
    /// 顶层评论 id；null 表示本行是顶层。
    #[serde(rename = "rootId")]
    pub root_id: Option<i32>,
    #[serde(rename = "replyToUid")]
    pub reply_to_uid: Option<i32>,
    /// 被回复者的展示名；null 表示顶层评论或账号已注销。
    #[serde(rename = "replyToNickname")]
    pub reply_to_nickname: Option<String>,
    #[serde(rename = "userId")]
    pub user_id: i32,
    /// 作者的展示名（昵称优先、没设昵称退回账号，见 `profile::peer_map`）
    pub nickname: String,
    pub avatar: Option<String>,
    /// 当前数据库角色，用于身份徽章。
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
    /// hot 为默认排序；只有 new 切换到时间排序。
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

pub async fn list_comments(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
    Query(q): Query<CommentListQuery>,
) -> Json<ApiResponse<Vec<CommentDto>>> {
    // 过期身份按匿名读取；投票身份与作者身份分别计算。
    let who = super::note_stats::optional_who(&state.db, &headers).await;
    let uid = who.as_ref().and_then(|w| w.uid());
    if !note_visible(&state.db, note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }
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
    let mut uids: Vec<i32> = tops.iter().map(|c| c.user_id).collect();
    uids.extend(tops.iter().filter_map(|c| c.reply_to_uid));
    uids.extend(replies.iter().map(|c| c.user_id));
    uids.extend(replies.iter().filter_map(|c| c.reply_to_uid));
    uids.sort_unstable();
    uids.dedup();
    let peers = super::profile::peer_map(&state.db, &uids).await;
    let ids: Vec<i32> = tops.iter().chain(replies.iter()).map(|c| c.id).collect();
    // 票数读取失败不阻断评论正文展示。
    let counts = super::comment_votes::vote_counts_for(&state.db, &ids)
        .await
        .unwrap_or_default();
    let mine = super::comment_votes::my_votes(&state.db, &ids, who.as_ref()).await;
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
        Ok(risk_verdict) => crate::risk::apply_verdict(&state, uid, &cfg, risk_verdict).await,
        Err(reject) => return Json(ApiResponse::error(&reject.message())),
    };
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
            if p.approved != 1 || p.is_deleted != 0 {
                return Json(ApiResponse::error("这条评论当前不可见，回复不了"));
            }
            (Some(p.id), Some(p.root_id.unwrap_or(p.id)), Some(p.user_id))
        }
    };
    let (ai_key, manual_key) = super::web_info::COMMENT_REVIEW_KEYS;
    let (ai_on, manual_on) =
        match super::web_info::review_switches_of(&state.db, ai_key, manual_key).await {
            Ok(switches) => switches,
            Err(e) => return super::db_error("读取评论审核设置", &e),
        };
    let (approved, ai_result, ai_reason, reject_reason) =
        super::talks::decide_review("comment", uid, &content, ai_on, manual_on).await;
    // 风控只将通过改为待审，不撤销已作出的拒绝。
    let approved = if forced && approved == 1 { 0 } else { approved };
    let reply_target = match (approved, reply_to_uid) {
        (1, Some(t)) if t != uid => Some(t),
        _ => None,
    };
    let notice_src = reply_target.map(|_| content.clone());
    // 外部审核已完成；写入按 article -> reference fence -> image 的顺序加锁。
    let transaction = match state
        .db
        .begin_with_config(Some(sea_orm::IsolationLevel::ReadCommitted), None)
        .await
    {
        Ok(transaction) => transaction,
        Err(error) => {
            tracing::error!("comment transaction failed uid={uid} note={note_id}: {error}");
            return Json(ApiResponse::error("评论失败，请稍后再试"));
        }
    };
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
    // 不向非作者确认其他人的评论存在。
    if c.user_id != uid {
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
            let new_approved = if reject { 2 } else { 1 };
            // 仅首次公开时发通知，重复审核不重复通知。
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

    /// 纯空白正文无效。
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
        assert!(hot_score(0, 0, 15) > hot_score(5, 1, 0));
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
