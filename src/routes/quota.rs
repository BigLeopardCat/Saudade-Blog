//! 用户对话额度（20260929）——用户侧两条 + 后台三条。
//!
//! **为什么这个模块存在**：上限是多少、剩多少、怎么原子扣一轮，全部住在
//! `crate::quota`（那里的头注是本批的判据总纲）。本模块只做两件事——把事实读出来、
//! 把管理员那三个动作做下去——**不重复实现任何判据**（`is_unlimited` / `view` /
//! `try_consume` 一律调用 `crate::quota`）。五条路由挂在哪、为什么挂那儿见
//! `routes/mod.rs`：用户侧两条在 `public_routes`（handler 自身鉴权，与 profile 同族），
//! 管理员三条在 `protected_routes`（共用 `auth_guard`）。
//!
//! ── 三条承重纪律 ────────────────────────────────────────────────────────────
//!
//! ① **先原子认领，再产生副作用**（`review_quota_request`）：`UPDATE ... WHERE id=?
//!    AND status=0` 认领到了才清零、才发通知。认领不到 ⇒ `这条申请已经处理过了`
//!    且**零副作用**。这条是 `claim_confirm_token` 那条纪律的同族——没有它，管理员
//!    重复点通过就会清两次零、发两条通知（第二条是假的："额度已清零"在他已经聊了
//!    三十轮之后）。
//!
//! ② **驳回理由的"必填"留给调用方**：前端驳回弹窗必填、agent 工具必填，**后端不硬闸**
//!    ——与 `audit_board` 逐条同形。后端只做两件事：长度**拒绝而不是截断**（截断会让
//!    主人核对的是这一句、库里存的是另一句，同 `notice.rs` 头注）、空理由落 NULL
//!    并让通知层回落成"管理员没有填写理由"。**不往库里塞一句编好的话**。
//!
//! ③ **通知发失败不改变动作的结果**：清零已经落库（那是事实），通知只是告知通道。
//!    发失败只记 error 日志，接口照常回成功——反过来（因为通知发不出去就报失败）
//!    会让管理员重试，而重试撞上"这条申请已经处理过了"，症状变成"点了通过但他说
//!    处理过了、额度却是清的"。诚实的代价是本函数**不声称通知已送达**。
//!
//! ── C6：三句通知文案是跨语言契约 ───────────────────────────────────────────
//! agent 的额度技能要求模型**逐字转述**这里给的原话（见 `docs/security-boundary.md`
//! §7⑫ 与 `saudade-blog-agent/tools/base.py` 的额度节头注）。改措辞前先看 agent 侧
//! 是否引用了它，两侧同改。
//!
//! 三条 `link` **一律 None**：个人中心是弹窗、没有可跳的地址——**不许编一个跳过去
//! 404 的链接**（同 `send_user_notice` 的既有论证）。

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
use crate::utils::ApiResponse;

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
pub const STATUS_PENDING: i8 = 0;
pub const STATUS_APPROVED: i8 = 1;
pub const STATUS_REJECTED: i8 = 2;

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
    /// 申请人**当前**已用轮数（不是提交那一刻的快照——审核看的是"他现在还剩多少"）
    pub used: i32,
    /// 上限；`0` = 不限额（见 `limit_of`）。**两侧都不许把 500 写死**
    pub limit: i32,
    pub reason: Option<String>,
    /// `0` = 待处理 / `1` = 已批准 / `2` = 已驳回（三值，别当布尔用）
    pub status: i8,
    pub note: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "handledAt")]
    pub handled_at: Option<String>,
}

#[derive(Deserialize)]
pub struct ListQuotaQuery {
    /// `pending` = 只看待处理（agent 的 `_quota_pending_index` 用的就是这一档，
    /// 且它**假定**回来的每一行都是待处理）；其余任何值（含不传）= 全部。
    #[serde(default)]
    pub status: Option<String>,
}

/// GET /api/protected/quota/requests：申请队列（后台「额度管理」页签 + agent 的
/// `list_quota_requests` 工具共用同一个接口）。
///
/// 用户名走 `.select_only().into_tuple()`（照 `list_board_admin`）——`find()` 是
/// `SELECT *`，会把 `password` 哈希一起捞出来。
///
/// **不 JOIN**：两张表都很小、且 `user` 行可能已被删（迁移头注 ④ 无外键），
/// 一次 `is_in` 批量查 + 内存里配对，删号之后申请行照样列得出来（用户名回空串
/// 而不是整行消失——那正是"申请还在、人没了"这个事实该有的样子）。
pub async fn list_quota_requests(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ListQuotaQuery>,
) -> Json<ApiResponse<Vec<QuotaRequestDto>>> {
    let Some(_uid) = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok() else {
        return Json(ApiResponse::error("请先登录"));
    };
    let pending_only = params.status.as_deref().map(str::trim) == Some("pending");
    let mut q = quota_request::Entity::find();
    if pending_only {
        q = q.filter(quota_request::Column::Status.eq(STATUS_PENDING));
    }
    let rows = match q
        .order_by_desc(quota_request::Column::Id)
        .limit(200)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[额度] 申请列表查询失败: {e}");
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    // 去重后再 is_in（同 `list_board_admin`：同一用户多行时会生成 IN (1,1,1,…)）
    let mut ids: Vec<i32> = rows.iter().map(|r| r.user_id).collect();
    ids.sort_unstable();
    ids.dedup();
    // 四列：id / username / nickname / chat_quota_used / role。role 也要——上限那一栏
    // 要按"这个人限不限量"显示 0 或真实上限，判据不在这一层重写（见 `limit_of`）。
    let users: Vec<(i32, String, String, i32, String)> = if ids.is_empty() {
        vec![]
    } else {
        user::Entity::find()
            .select_only()
            .column(user::Column::Id)
            .column(user::Column::Username)
            .column(user::Column::Nickname)
            .column(user::Column::ChatQuotaUsed)
            .column(user::Column::Role)
            .filter(user::Column::Id.is_in(ids))
            .into_tuple::<(i32, String, String, i32, String)>()
            .all(&state.db)
            .await
            .unwrap_or_default()
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
    Json(ApiResponse::success(dtos))
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
