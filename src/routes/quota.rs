//! User quota reads, reset applications and administrator review actions.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::entity::{quota_request, user};
use crate::routes::AppState;
use crate::utils::{ApiResponse, ApiResponsePage};

// ── C6 通知文案（跨语言契约，见模块头注）─────────────────────────────────────

pub const NOTICE_APPROVED_TITLE: &str = "额度重置申请已通过";
pub const NOTICE_REJECTED_TITLE: &str = "额度重置申请未通过";
pub const NOTICE_RESET_TITLE: &str = "对话额度已重置";

/// 驳回时**没有理由**的回落句。这是系统写的字（写在这里一处），不是模型措辞——
/// 与 `notice::DEFAULT_TITLE` 同一形态。回落链只有两级（人工 > 无），比留言驳回
/// 那条三级链短一级：那里的第三级是 AI 说明，这里没有 AI 参与。
pub const NO_REASON_FALLBACK: &str = "管理员没有填写理由";

/// 申请理由的产品上限（字符）。`quota_request.reason` 是 text 列，500 是**产品上限
/// 而不是列宽**——超限**拒绝、不截断**（同头注 ②）。agent 侧 `_QUOTA_REASON_LIMIT`
/// 是同一个数（跨语言契约，改一侧要同步）。
pub const REASON_MAX: usize = 500;

/// 驳回理由的上限 = 迁移里 `quota_request.note` 的**列宽**（varchar(255)），
/// 且它会被原样拼进发给申请人的通知正文。**必须与列宽对齐**：写超了要么报错、
/// 要么截断，而截断意味着申请人收到的理由与主人核对的那一句不同。
/// agent 侧 `_QUOTA_NOTE_LIMIT` 是同一个数。
pub const NOTE_MAX: usize = 255;

/// 申请行状态（三值，见 `entity/quota_request.rs` 头注 ①）——**只有 `0 → 1` 清零**。
pub const STATUS_PENDING: i16 = 0;
pub const STATUS_APPROVED: i16 = 1;
pub const STATUS_REJECTED: i16 = 2;

/// 时间列的展示口径：+08:00 本地钟面、秒级（与后台其余列表一致，前端直接显示字符串）。
fn fmt_dt(t: &chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 某个账号这一轮的额度上限：**不限量的账号回 0**（0 在后端与前端都读作"不限额"，
/// 见 `temp_user::TempUserInfo` 与 agent 的 `quota_limit`）。判据只有
/// `crate::quota::is_unlimited` 一处——**账号名录那一列也走这里**（`temp_user.rs`），
/// 否则"这个人限不限量"就会有两份判断，而它们会各自演化。
pub(crate) fn limit_of(role: &str) -> i32 {
    if crate::quota::is_unlimited(Some(role)) {
        0
    } else {
        crate::quota::limit()
    }
}

// ── 用户侧两条 ──────────────────────────────────────────────────────────────

/// GET /api/protected/quota：我的额度现状（个人中心「对话额度」页签）。
///
/// 响应体的四个数与 `/chat` body 里的 `chat_quota` **同源同形**（都出自
/// `crate::quota::forward_json`，这里是唯一第二个消费者，用来给它补一个
/// `pendingRequest`）——这样前端不必为两个界面各写一份取数逻辑。
///
/// `pendingRequest` = 我最新一份**待处理**申请，`null` = 没有。
/// **读申请失败时整个接口报错**（而不是回 `null`）：半份答案会把"读不到"渲染成
/// "你没申请过"，而这两件事的下一步动作正好相反（一个去提交，一个去等）。
pub async fn get_my_quota(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<serde_json::Value>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let row = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(u)) => u,
        // token 有效但用户已删：如实说读不到，不假装是一个 0/500 的新账号
        Ok(None) => return Json(ApiResponse::error("账号读不出来，请重新登录")),
        Err(e) => {
            tracing::error!("[额度] 读账号失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("额度读取失败，请稍后再试"));
        }
    };
    let view = crate::quota::view(
        row.chat_quota_used,
        crate::quota::limit(),
        crate::quota::is_unlimited(Some(row.role.as_str())),
    );
    let mut obj = crate::quota::forward_json(&view);
    let pending = quota_request::Entity::find()
        .filter(quota_request::Column::UserId.eq(uid))
        .filter(quota_request::Column::Status.eq(STATUS_PENDING))
        .order_by_desc(quota_request::Column::Id)
        .one(&state.db)
        .await;
    let pending = match pending {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("[额度] 读待处理申请失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("额度读取失败，请稍后再试"));
        }
    };
    // 只回申请人自己需要知道的三个字段：行 id（前端提交后在本地标记，不给编号通道）、
    // 理由（他写过的原话）、提交时间。管理员侧的 note/handledAt 与他无关。
    obj["pendingRequest"] = match pending {
        Some(p) => serde_json::json!({
            "id": p.id,
            "reason": p.reason,
            "createdAt": fmt_dt(&p.created_at),
        }),
        None => serde_json::Value::Null,
    };
    Json(ApiResponse::success(obj))
}

#[derive(Deserialize)]
pub struct ApplyQuotaReq {
    /// 申请理由（可空）。`serde(default)` 让"字段压根没传"也被接住（老前端/脚本）；
    /// 空串与"没填"是同一件事（都落 NULL）。
    #[serde(default)]
    pub reason: Option<String>,
}

/// POST /api/protected/quota/apply：提交一份额度重置申请。
///
/// **"一人同时一份申请"在这里保证**（迁移头注 ③：MySQL 写不出部分唯一索引，
/// 而 `UNIQUE(user_id,status)` 是错的约束）。代价如实记：同一用户两个并发提交可能
/// 产生两行 pending——管理员驳回多余的那一条即可（`review` 按行认领、幂等）。
///
/// **不给任何人发通知**：用户刚做完这件事，他自己知道；管理员的"通知"就是后台日程
/// 面板那一行与红点（与待审评论同构，靠读队列而不是靠推送）。
pub async fn apply_quota_reset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ApplyQuotaReq>,
) -> Json<ApiResponse<String>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let reason = payload.reason.unwrap_or_default().trim().to_string();
    if reason.chars().count() > REASON_MAX {
        // 超限**拒绝**、不截断（模块头注 ②）
        return Json(ApiResponse::error(&format!("申请理由太长了（最多 {REASON_MAX} 字）")));
    }
    // 提交前的 pending 预检。它与插入之间有一个窗口，那是接受的代价（迁移头注 ③）；
    // 预检的价值是让绝大多数重复提交当场得到一句人话，而不是攒出一堆待审行。
    match quota_request::Entity::find()
        .filter(quota_request::Column::UserId.eq(uid))
        .filter(quota_request::Column::Status.eq(STATUS_PENDING))
        .one(&state.db)
        .await
    {
        Ok(Some(_)) => {
            return Json(ApiResponse::error("你已经有一份待处理的申请了"));
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!("[额度] 提交前预检查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("提交失败，请稍后再试"));
        }
    }
    let am = quota_request::ActiveModel {
        user_id: Set(uid),
        // 空理由落 NULL：`null` 与"写了空串"在后端是同一件事，归一成 NULL 之后
        // 读取端只有一个分支（同 `TalkDto.reject_reason` 的既有取舍）
        reason: Set(if reason.is_empty() { None } else { Some(reason) }),
        status: Set(STATUS_PENDING),
        ..Default::default()
    };
    match am.insert(&state.db).await {
        Ok(r) => {
            tracing::info!("[额度] 收到重置申请 uid={} request_id={}", uid, r.id);
            Json(ApiResponse::success(
                "已提交对话额度重置申请，管理员处理后会通过站内通知告诉你".to_string(),
            ))
        }
        Err(e) => {
            tracing::error!("[额度] 提交申请失败 uid={}: {}", uid, e);
            Json(ApiResponse::error("提交失败，请稍后再试"))
        }
    }
}

// ── 后台三条 ────────────────────────────────────────────────────────────────

/// 申请行的后台视图（跨语言契约：字段名与语义见 agent 的 `render_quota_requests`
/// 与 `quota_used/quota_limit`，改一侧要同步另一侧）。
#[derive(Serialize)]
pub struct QuotaRequestDto {
    pub id: i32,
    #[serde(rename = "userId")]
    pub user_id: i32,
    pub username: String,
    pub nickname: String,
    #[serde(rename = "accountExists")]
    pub account_exists: bool,
    /// 申请人**当前**已用轮数（不是提交那一刻的快照——审核看的是"他现在还剩多少"）
    pub used: i32,
    /// 上限；`0` = 不限额（见 `limit_of`）。**两侧都不许把 500 写死**
    pub limit: i32,
    pub reason: Option<String>,
    /// `0` = 待处理 / `1` = 已批准 / `2` = 已驳回（三值，别当布尔用）
    pub status: i16,
    pub note: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "handledAt")]
    pub handled_at: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestStatus {
    Pending,
    Approved,
    Rejected,
    All,
}

impl RequestStatus {
    fn value(self) -> Option<i16> {
        match self {
            Self::Pending => Some(STATUS_PENDING),
            Self::Approved => Some(STATUS_APPROVED),
            Self::Rejected => Some(STATUS_REJECTED),
            Self::All => None,
        }
    }
}

#[derive(Default, Deserialize)]
pub struct ListQuotaQuery {
    pub status: Option<RequestStatus>,
    pub id: Option<i32>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub(super) fn request_query(params: &ListQuotaQuery) -> sea_orm::Select<quota_request::Entity> {
    let mut query = quota_request::Entity::find();
    if let Some(status) = params.status.and_then(RequestStatus::value) {
        query = query.filter(quota_request::Column::Status.eq(status));
    }
    if let Some(id) = params.id {
        query = query.filter(quota_request::Column::Id.eq(id));
    }
    query.order_by_desc(quota_request::Column::Id)
}

/// GET quota/requests: optional pagination; unpaged clients retain the 200-row limit.
pub async fn list_quota_requests(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ListQuotaQuery>,
) -> Json<ApiResponsePage<Vec<QuotaRequestDto>>> {
    let Some(_uid) = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok() else {
        return Json(ApiResponsePage::error("请先登录"));
    };
    let window = match super::pagination::window(params.page, params.page_size) {
        Ok(window) => window,
        Err(msg) => return Json(ApiResponsePage::error(msg)),
    };
    if params.id.is_some_and(|id| id <= 0) {
        return Json(ApiResponsePage::error("申请编号必须大于0"));
    }
    let query = request_query(&params);
    let total = if window.is_some() {
        match query.clone().count(&state.db).await {
            Ok(total) => Some(total as i64),
            Err(e) => {
                tracing::error!("quota count failed: {e}");
                return Json(ApiResponsePage::error("查询失败，请稍后再试"));
            }
        }
    } else { None };
    let (limit, offset) = window.unwrap_or((200, 0));
    let rows = match query
        .limit(limit)
        .offset(offset)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[额度] 申请列表查询失败: {e}");
            return Json(ApiResponsePage::error("查询失败，请稍后再试"));
        }
    };
    // Fetch only the page's accounts and no password columns.
    let mut ids: Vec<i32> = rows.iter().map(|r| r.user_id).collect();
    ids.sort_unstable();
    ids.dedup();
    let users: Vec<(i32, String, String, i32, String)> = if ids.is_empty() {
        vec![]
    } else {
        match user::Entity::find()
            .select_only()
            .column(user::Column::Id)
            .column(user::Column::Username)
            .column(user::Column::Nickname)
            .column(user::Column::ChatQuotaUsed)
            .column(user::Column::Role)
            .filter(user::Column::Id.is_in(ids))
            .into_tuple::<(i32, String, String, i32, String)>()
            .all(&state.db)
            .await {
                Ok(users) => users,
                Err(e) => {
                    tracing::error!("quota account lookup failed: {e}");
                    return Json(ApiResponsePage::error("账号信息读取失败，请稍后再试"));
                }
            }
    };
    let umap: std::collections::HashMap<i32, (String, String, i32, String)> = users
        .into_iter()
        .map(|(id, username, nickname, used, role)| (id, (username, nickname, used, role)))
        .collect();
    let dtos = rows
        .into_iter()
        .map(|r| {
            let u = umap.get(&r.user_id);
            QuotaRequestDto {
                id: r.id,
                user_id: r.user_id,
                account_exists: u.is_some(),
                username: u.map(|x| x.0.clone()).unwrap_or_default(),
                nickname: u.map(|x| x.1.clone()).unwrap_or_default(),
                used: u.map(|x| x.2).unwrap_or(0),
                limit: u.map(|x| limit_of(&x.3)).unwrap_or(0),
                reason: r.reason,
                status: r.status,
                note: r.note,
                created_at: fmt_dt(&r.created_at),
                handled_at: r.handled_at.as_ref().map(fmt_dt),
            }
        })
        .collect();
    Json(ApiResponsePage::success(dtos, total))
}

#[derive(Deserialize)]
pub struct ReviewQuotaReq {
    /// `true` = 批准（**把他的额度恢复到上限**）/ `false` = 驳回（额度一个字节都不动）
    pub approved: bool,
    /// 驳回理由（可空）。批准时请求里带什么都不生效（那一列恒为 NULL）。
    #[serde(default)]
    pub reason: Option<String>,
}

/// POST /api/protected/quota/requests/:id/review：批准 / 驳回一份申请。
///
/// 读校验、条件认领与额度清零在同一事务中；失败回滚后可以重试。
/// `WHERE id=? AND status=0` 保证并发审批仅一次生效；通知只在提交成功后发送。
pub async fn review_quota_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<ReviewQuotaReq>,
) -> Json<ApiResponse<String>> {
    let Some(operator) = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok() else {
        return Json(ApiResponse::error("请先登录"));
    };
    match super::quota_actions::service::review(&state.db, operator, id, payload, None).await {
        Ok(out) => {
            let approved = out.state.request.as_ref().is_some_and(|row| row.status == STATUS_APPROVED);
            Json(ApiResponse::success(format!("已{}账号「{}」的额度重置申请",
                if approved { "批准" } else { "驳回" }, out.state.name)))
        }
        Err(message) => Json(ApiResponse::error(&message)),
    }
}

/// 发一条额度相关通知（best-effort，见模块头注 ③）。
///
/// 用 `push_notice_checked` 而不是 `push_notice`：后者对 title 按字符截 128——
/// 我们的三句标题是常量、远短于列宽，**截断永远不会发生**，但用不截断的那个版本
/// 才不会在某天有人把标题写长之后，出现"主人核对的是这一句、库里存的是另一句"。
/// 失败只记日志、**绝不冒泡给调用方**：清零已经落库（那是事实），通知只是告知通道。
///
/// 三句文案的 `link` 一律 None——个人中心是弹窗，**不编一个跳过去 404 的地址**。
pub(super) async fn notify(db: &sea_orm::DatabaseConnection, uid: i32, title: &str, content: String) {
    if let Err(e) =
        crate::routes::notice::push_notice_checked(db, uid, title, Some(content), None).await
    {
        tracing::error!("[额度] 通知写入失败 uid={uid} title={title}: {e}");
    }
}

/// 管理员**主动**重置某个账号的额度（`POST /api/temp-users/:id/quota-reset`）。
///
/// 挂在账号族下（与 `/status`、`/role`、`/notice` 同族）而不是新开一条
/// `/api/protected/quota/reset`：它复用 `authz::is_listable_role`
/// （**超管结构上够不着**，与 `send_user_notice` 同一条论证——超管的额度本来就是
/// 不限的，对它的"重置"没有任何含义），且账号管理页那一行本来就住在这个族里。
///
/// 与 `review_quota_request` 的差别**只有一处**：这里**不需要对方申请过**
/// （所以不产生 `quota_request` 行，也就没有认领那一步）。
pub async fn reset_user_quota(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i32>,
) -> Json<ApiResponse<String>> {
    match super::quota_actions::service::reset(&state.db, user_id, None).await {
        Ok(out) => Json(ApiResponse::success(format!("已把账号「{}」的对话额度恢复到 {} 轮",
            out.state.name, out.state.limit))),
        Err(message) => Json(ApiResponse::error(&message)),
    }
}

/// 待处理的额度申请条数（后台首页/红点用，见 `profile::UnreadDto.pendingQuota`）。
/// 与 `board_pending_count` 同族：只要一个数，**不为一行提示把整张表拉进内存**。
pub async fn quota_pending_count(db: &sea_orm::DatabaseConnection) -> i64 {
    quota_request::Entity::find()
        .filter(quota_request::Column::Status.eq(STATUS_PENDING))
        .count(db)
        .await
        .unwrap_or(0) as i64
}
