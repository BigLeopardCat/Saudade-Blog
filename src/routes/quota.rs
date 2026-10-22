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
use sea_orm::sea_query::Expr;
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
/// 顺序是**读校验 → 原子认领 → 副作用 → 通知**（模块头注 ①）：
///   · 读校验（无副作用）只为把话说准——"没有找到这条申请" / "用户不存在" 与
///     "这条申请已经处理过了"是三件不同的事，合成一句会让管理员按错误的方向去查；
///   · **真正的并发守卫是认领那一条 `WHERE id=? AND status=0`**，不是读校验；
///   · 认领后清零失败（DB 抖动）是唯一会留下"已通过但没清零"的分支：**如实报错**
///     并记 error，恢复路径是账号管理页那枚「重置额度」按钮（重试这个接口会撞上
///     "已经处理过了"）。绝不回一句"已通过"了事——那会让额度没清零而主人以为清了。
///
/// 驳回理由为空的处置见模块头注 ②（落 NULL + 通知层回落，不塞编好的话）。
pub async fn review_quota_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<ReviewQuotaReq>,
) -> Json<ApiResponse<String>> {
    let Some(operator) = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok() else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match quota_request::Entity::find_by_id(id).one(&state.db).await {
        Ok(Some(r)) => r,
        Ok(None) => return Json(ApiResponse::error("没有找到这条额度申请")),
        Err(e) => {
            tracing::error!("[额度] 读申请失败 id={}: {}", id, e);
            return Json(ApiResponse::error("操作失败，请稍后再试"));
        }
    };
    if row.status != STATUS_PENDING {
        // 三值状态在这里第一次派上用场：已批准 / 已驳回都不能再处理（**不是**错误，
        // 是并发或重复点击下的正常结局），措辞是跨语言契约，agent 逐字转述
        return Json(ApiResponse::error("这条申请已经处理过了"));
    }
    let target = match user::Entity::find_by_id(row.user_id).one(&state.db).await {
        Ok(Some(u)) => u,
        Ok(None) => return Json(ApiResponse::error("用户不存在")),
        Err(e) => {
            tracing::error!("[额度] 读申请人失败 uid={}: {}", row.user_id, e);
            return Json(ApiResponse::error("操作失败，请稍后再试"));
        }
    };
    let note: Option<String> = if payload.approved {
        // 批准时那一列恒为 NULL——不留"已通过却带驳回理由"的矛盾行
        // （同 `audit_board` 通过时清空 reject_reason）
        None
    } else {
        let raw = payload.reason.unwrap_or_default().trim().to_string();
        if raw.chars().count() > NOTE_MAX {
            return Json(ApiResponse::error(&format!("驳回理由太长了（最多 {NOTE_MAX} 字）")));
        }
        if raw.is_empty() { None } else { Some(raw) }
    };
    let new_status = if payload.approved { STATUS_APPROVED } else { STATUS_REJECTED };
    let claimed = quota_request::Entity::update_many()
        .col_expr(quota_request::Column::Status, Expr::value(new_status).into())
        .col_expr(quota_request::Column::Note, Expr::value(note.clone()).into())
        .col_expr(
            quota_request::Column::HandledAt,
            Expr::value(chrono::Local::now().naive_local()).into(),
        )
        .col_expr(quota_request::Column::HandledBy, Expr::value(Some(operator)).into())
        .filter(quota_request::Column::Id.eq(id))
        // **这一行就是并发守卫**：两个人同时点通过，只有一个的 UPDATE 会匹配到行
        .filter(quota_request::Column::Status.eq(STATUS_PENDING))
        .exec(&state.db)
        .await;
    match claimed {
        Ok(r) if r.rows_affected == 0 => {
            // 读校验之后、认领之前被别人抢先处理了。零副作用。
            return Json(ApiResponse::error("这条申请已经处理过了"));
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!("[额度] 认领申请失败 id={}: {}", id, e);
            return Json(ApiResponse::error("操作失败，请稍后再试"));
        }
    }

    let limit = limit_of(&target.role);
    if payload.approved {
        // 清零：唯一把「请求」与「事实」连起来的动作（entity 头注）
        match user::Entity::update_many()
            .col_expr(user::Column::ChatQuotaUsed, Expr::value(0).into())
            .filter(user::Column::Id.eq(target.id))
            .exec(&state.db)
            .await
        {
            Ok(_) => {}
            Err(e) => {
                tracing::error!(
                    "[额度] 申请已通过但清零失败 request_id={} uid={}: {} —— 恢复路径：账号管理页重置额度",
                    id,
                    target.id,
                    e
                );
                return Json(ApiResponse::error(
                    "申请已标记为通过，但额度清零失败，请到账号管理页用「重置额度」再试一次",
                ));
            }
        }
        let content = format!("管理员已批准你的对话额度重置申请，额度已恢复到 {} 轮。", limit);
        notify(&state.db, target.id, NOTICE_APPROVED_TITLE, content).await;
        tracing::info!("[额度] 批准申请 id={} uid={}（发起人 uid={}）", id, target.id, operator);
        Json(ApiResponse::success(format!("已批准账号「{}」的额度重置申请", target.username)))
    } else {
        let content = format!(
            "管理员驳回了你的对话额度重置申请。理由：{}",
            note.as_deref().unwrap_or(NO_REASON_FALLBACK)
        );
        notify(&state.db, target.id, NOTICE_REJECTED_TITLE, content).await;
        tracing::info!("[额度] 驳回申请 id={} uid={}（发起人 uid={}）", id, target.id, operator);
        Json(ApiResponse::success(format!("已驳回账号「{}」的额度重置申请", target.username)))
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
async fn notify(db: &sea_orm::DatabaseConnection, uid: i32, title: &str, content: String) {
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
    let Some(target) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None)
    else {
        return Json(ApiResponse::error("用户不存在"));
    };
    if !crate::authz::is_listable_role(&target.role) {
        return Json(ApiResponse::error("该账号不能重置额度"));
    }
    if crate::quota::is_unlimited(Some(target.role.as_str())) {
        // 管理员档（`can_access_console`）的额度**从来就不增长**，所以"清零"既无事
        // 可做、也说不通——「已把你的额度清零（0 轮）」是一句废话，而发一条站内通知
        // 告诉他这件事更是噪声。如实拒：不是权限问题，是这件事对他来说不存在。
        // （agent 侧走不到这里：它的"已达成"判据是 `used == 0`，而管理员的计数器
        // 恒为 0 ⇒ 它压根不会发这一下，只会回一句"本来就没有额度需要重置"。）
        return Json(ApiResponse::error("该账号不限额，无需重置额度"));
    }
    let limit = limit_of(&target.role);
    match user::Entity::update_many()
        .col_expr(user::Column::ChatQuotaUsed, Expr::value(0).into())
        .filter(user::Column::Id.eq(target.id))
        .exec(&state.db)
        .await
    {
        Ok(_) => {
            tracing::info!("[额度] 主动重置 uid={}", target.id);
            let content = format!("管理员已把你的对话额度恢复到 {} 轮。", limit);
            notify(&state.db, target.id, NOTICE_RESET_TITLE, content).await;
            // 文案与账号族其余动作同形（「已把账号「X」的…」）。**不是**给 agent 读的
            // 那一句——agent 侧自己读回复核（`_quota_readback`），比转述这里可靠。
            // 措辞是「恢复到 N 轮」而**不是**「清零」：主人看到的是递减的余额，
            // 他的心智模型是"额度用光了"，"计数器清零"描述的是库里的实现（`used = 0`），
            // 不是他看到的那个东西（20260929 主人指出）。
            Json(ApiResponse::success(format!(
                "已把账号「{}」的对话额度恢复到 {} 轮",
                target.username, limit
            )))
        }
        Err(e) => {
            tracing::error!("[额度] 主动重置失败 uid={}: {}", target.id, e);
            Json(ApiResponse::error("操作失败，请稍后再试"))
        }
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
