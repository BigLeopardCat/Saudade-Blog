use axum::{Json, extract::{State, Path}};
use sea_orm::{EntityTrait, Set, QueryFilter, ColumnTrait, ActiveModelTrait};
use chrono::{Duration, Utc};
use uuid::Uuid;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::entity::{password_reset_token, user};
use crate::utils::hash_password;
use crate::utils::encrypt_password;

#[derive(Deserialize)]
pub struct CreateTempUser {
    pub username: String,
    pub password: String,
}

// ── 账号变更通知（20261001，用户要求「账号权限身份变更系统也发通知」）────────────
//
// 冻结 / 解冻 / 变更身份三件事**都会让当事人手里的登录状态当场失效**（代次 +1），
// 而此前它们只写 `tracing` 日志——服务端有记录，当事人那边一片安静。人忽然被踢下线
// 却不知道为什么，只能来问博主；通知就是给当事人的那句解释。
//
// 三条纪律与留言审核通知同源（见 `notice.rs` 头注）：
//   · **best-effort**：走 `push_notice`，它永不放回错误。账号已经冻结了，这时候为了
//     "通知没发出去"回一句"操作失败"是假话（库里明明已经改完了）。
//   · **正文由系统写死模板**，不采集任何用户输入，因此不受注入影响。
//   · **时间戳同库钟面**（`chrono::Local`，+08:00，见 CLAUDE.md §时区约定），
//     与后台列表、执行台账对得上，不做二次偏移。
//
// 注意冻结方向的通知**当事人当时看不到**：`authz::is_frozen` 会挡住他登录，
// 这条要等他被解冻后才读得到。它仍要发——那正是"回来之后知道发生过什么"的唯一来源。

/// 发起人在通知正文里的称呼：`{身份中文}「{昵称}」（uid=N）`。20261002 主人点名改的。
///
/// **为什么从写死的「博主」改成落名**：原来三条通知一律写"博主把…"，是"后台只有
/// 博主一个人会操作"那个年代的写法（`20260926` 起管理员与超管都能冻账号，
/// `20261002` 起管理员还能改身份）。当事人被踢下线时读到一句"博主冻结了你的账号"，
/// 而真正动手的是另一个管理员——他拿着这句话去问博主，博主一头雾水。落名之后
/// 这句话本身就能对得上人。
///
/// 三样都要写：**身份**（他为什么有权做这件事）、**昵称**（人认得的是这个）、
/// **uid**（昵称可改、可重名，uid 才是唯一标识）。昵称为空回退账号名
/// （与 `delete_temp_user` 里那句 `who`、`profile.rs` 的展示口径同源：
/// 库里的 `nickname` 允许是空串，不能因此拼出一个空引号）。
fn actor_label(row: &user::Model) -> String {
    let name = if row.nickname.trim().is_empty() {
        row.username.clone()
    } else {
        row.nickname.trim().to_string()
    };
    format!("{}「{}」（uid={}）", crate::authz::role_label(&row.role), name, row.id)
}

/// 账号变更通知的正文模板。**写在这里一处**，三个调用点各自只给"变了什么"
/// （"谁干的"由 `actor_label` 拼好，是 `action` 的开头一段）。
fn account_change_body(action: &str, when: &str) -> String {
    format!(
        "{when}，{action}。你此前登录的全部设备已失效，需要重新登录才能继续访问。\
如有疑问请联系博主。",
    )
}

#[derive(Deserialize)]
pub struct ChangePasswordReq {
    pub password: String,
}

#[derive(Serialize)]
pub struct TempUserInfo {
    pub id: i32,
    pub username: String,
    /// 角色（20260926）：后台账号列表要能按「管理员账号 / 普通用户账号」分流，
    /// 前端拿不到 role 就只能靠猜。取值域见 `crate::authz`。
    pub role: String,
    /// 账号状态（20260926 冻结账号）：原样回传 `user.status` 的数值，
    /// **不在后端翻译成字符串**——前端按 `crate::authz` 的同一套取值域自己判
    /// （冻结账号筛选项就是 `status !== 0`）。两边都对同一个数字做判断，
    /// 而不是一边翻译、另一边再反解。
    pub status: i8,
    /// 终身对话额度已用轮数（20260929）。**这是跨语言契约**：agent 的额度工具
    /// （`tools/base.py` 的额度节）靠这个字段做写前预检与写后复核，
    /// 字段名与语义改一处要同步另一侧（见该文件头注与 `docs/security-boundary.md`）。
    #[serde(rename = "chatQuotaUsed")]
    pub chat_quota_used: i32,
    /// 额度上限（20260929）；**`0` = 不限额**（管理员档，判据在 `crate::quota`）。
    /// 两侧都不许把 500 写死——它是 `CHAT_QUOTA_LIMIT`，改上限不该需要一次迁移。
    #[serde(rename = "chatQuotaLimit")]
    pub chat_quota_limit: i32,
}

/// 账号列表（20260926）：原来只回 `role="user"` 的临时账号，博主因此**在后台
/// 看不见管理员账号**，也就无从按角色筛。现在回全部**已知角色**的账号。
///
/// 列表判据是 `authz::is_listable_role`：**已知角色 且 不是超管**。两半各有理由：
/// 历史脏值或将来新增但未登记的角色，前端判不出该归到哪一类筛选项下——宁可不显示，
/// 也不给一行"哪一类都不是"的账号；超管见下。
///
/// **超级管理员不出现**（20260926，需求原文"超级管理员账号密码不显示在后台"）：
/// 超管是博主自己的账号，它既不需要在"后台有谁"里被点名，也不是这个页面的操作对象
/// （谁都不能冻它/改它的身份）。⚠️ 这条过滤**不只是界面上的隐藏**，它是三道防线里
/// 的第一道，改它之前先读完这三条：
///   · 界面：超管行不进列表 ⇒ 前端不渲染它 ⇒ 也不会有那一行的按钮；
///   · 路由：`check_freeze` / `check_role_change` 里 "目标是超管 ⇒ 拒"；
///   · **agent**：账号名录走的就是这个接口（`tools/base.py::_user_directory`）⇒
///     名录里根本没有超管 ⇒ 按名字解析必然零写——超管在结构上就冻不了，不是靠判据拦。
pub async fn list_temp_users(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<TempUserInfo>> {
    let users = user::Entity::find()
        .all(&state.db)
        .await
        .unwrap_or_default();
    Json(users.into_iter()
        // 判据在 `authz::is_listable_role`（= 已知角色 且 不是超管），抽出去是为了
        // 让"超管不露脸"这条需求可测：两个条件写在两行里时，删掉任何一行都不报错
        .filter(|u| crate::authz::is_listable_role(&u.role))
        .map(|u| TempUserInfo {
            id: u.id,
            username: u.username,
            role: u.role.clone(),
            status: u.status,
            // 额度两列（20260929）：已用照抄库里那个数；上限**不查库**（走
            // `crate::quota::limit()`），不限量的角色回 0（见 `routes::quota::limit_of`）。
            // **信封一个字节不动**：这是裸数组而不是 `ApiResponse`，三个消费方
            // （前端账号页、`scripts/probe_token_revoke.py`、agent 的 `_user_directory`）
            // 都认这个形状——agent 那边甚至写明了"不要包信封"。**只加字段。**
            chat_quota_used: u.chat_quota_used,
            chat_quota_limit: crate::routes::quota::limit_of(&u.role),
        })
        .collect())
}

#[derive(Deserialize)]
pub struct SetStatusReq {
    /// true = 冻结，false = 解冻。**不做"切换"语义**（没有默认值、没有取反）：
    /// 前端把按钮的当前含义直接写进来，服务端不猜对方想干什么——
    /// 一个"点一下就切换"的接口在重试、双击、并发标签页下会自己跟自己打架。
    pub frozen: bool,
}

/// POST /api/temp-users/:id/status：冻结 / 解冻一个账号（20260926）。
///
/// 冻结的效果（判据都在 `crate::authz::check_token`，这里只是改那个数字）：
///   · 立刻拒登录（`auth.rs::login`）、拒改密码与恢复码（`profile` / `auth`）；
///   · **已经登录的设备当场全部下线**——`auth_jwt::auth_uid` 每个请求查一次库，
///     这就是无状态 JWT 补上"紧急收回"的那半；
///   · 顺带 `token_version + 1` ⇒ **解冻不会把冻结前的登录态还回来**。
///     冻结是"踢下线"，不是"暂停一下"；这条要是不做，解冻就等于把被收回的
///     令牌原样复活——而冻结的常见动机恰恰是"这台设备/这个人不能再进来了"。
///
/// 拒绝的话术（20260926 起由 `crate::authz::check_freeze` 给原因，这里只翻译）：
///   ① **不许冻结自己**：冻了自己就再也解不开了（冻结账号正是改不动自己状态的那种
///      账号），唯一的管理员这么做等于把后台锁死，只能进库手改。
///   ② **不许冻结超级管理员**：谁都不行，含另一个超管。
///   ③ **管理员之间不可互相冻结**（解冻同理）：两个同级的人互相封，最后只能靠超管
///      或进库解，而"谁先动手谁赢"不该是后台的规则。
///   ④ 目标账号必须存在。
///   ⑤ 目标角色必须是已知角色：与 `list_temp_users` 同一个取值域判据，
///      不让一个"列表里根本看不见"的账号从这里被改状态。
///
/// **冻结方向恒 `token_version + 1`**（20260926 收口）：连"已经是冻结状态"时也 +1。
/// 原来的幂等分支在这里返回、不动代次，留下一个静默的鉴权洞——若 `status` 是被
/// 迁移/手工改成 1 的（没有走过这个接口），那个账号手里已经签发的令牌**还活着**，
/// 而"再点一下冻结"本该是最自然的补救动作。对被冻账号也没有额外代价：它本来就
/// 登不进来，+1 只是让旧令牌彻底作废。解冻方向照旧只在真变化时动（解冻是放宽，
/// 没有对应的洞，无谓地 +1 会让"这一下做了什么"变得不可解释）。
pub async fn set_user_status(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<SetStatusReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    // 谁在操作 + 他是什么角色。**角色从库里现查**（不信任何令牌里的快照）：
    // 冻结判据要用到"我是不是管理员/超管"，而 `auth_uid` 只给 uid。
    let Some(operator) = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok() else {
        return Json(crate::utils::ApiResponse::error("未登录"));
    };
    let Some(operator_row) = user::Entity::find_by_id(operator).one(&state.db).await.unwrap_or(None)
    else {
        return Json(crate::utils::ApiResponse::error("未登录"));
    };
    let Some(target) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None) else {
        return Json(crate::utils::ApiResponse::error("用户不存在"));
    };
    if !crate::authz::is_known_role(&target.role) {
        return Json(crate::utils::ApiResponse::error("该账号角色未登记，不能改状态"));
    }
    let frozen = payload.frozen;
    if let Err(denial) = crate::authz::check_freeze(
        operator,
        &operator_row.role,
        user_id,
        &target.role,
    ) {
        return Json(crate::utils::ApiResponse::error(&freeze_denial_message(
            denial, frozen,
        )));
    }
    let new_status = if frozen { crate::authz::STATUS_FROZEN } else { crate::authz::STATUS_ACTIVE };
    // 解冻方向的真 no-op（状态已经是正常）：不写库、不动代次
    if !frozen && target.status == new_status {
        return Json(crate::utils::ApiResponse::success(
            "该账号已经是正常状态".to_string(),
        ));
    }
    let new_ver = if frozen { target.token_version + 1 } else { target.token_version };
    let mut am: user::ActiveModel = target.into();
    am.status = Set(new_status);
    am.token_version = Set(new_ver);
    match am.update(&state.db).await {
        Ok(_) => {
            tracing::info!(
                "[账号管理] {} 账号 uid={}（发起人 uid={} role={}）",
                if frozen { "冻结" } else { "解冻" },
                user_id,
                operator,
                operator_row.role
            );
            // 通知当事人（20261001）：必须**在 update 成功之后**发——先发后写会让
            // 写失败时留下一条"你已被冻结"的假通知。best-effort，失败只记一行日志。
            let when = chrono::Local::now().format("%Y年%m月%d日 %H:%M").to_string();
            crate::routes::notice::push_notice(
                &state.db,
                user_id,
                if frozen { "账号已被冻结" } else { "账号已解冻" },
                Some(account_change_body(
                    // 落名（20261002）：`operator_row` 就是发起人那一行，身份/昵称/uid 都从它来
                    &format!(
                        "{}{}",
                        actor_label(&operator_row),
                        if frozen { "冻结了你的账号" } else { "解冻了你的账号" },
                    ),
                    &when,
                )),
                None,
            )
            .await;
            Json(crate::utils::ApiResponse::success(
                if frozen { "账号已冻结，其登录状态已全部失效" } else { "账号已解冻，请让对方重新登录" }
                    .to_string(),
            ))
        }
        Err(e) => {
            tracing::error!("[账号管理] 改状态失败 uid={}: {}", user_id, e);
            Json(crate::utils::ApiResponse::error("操作失败，请稍后再试"))
        }
    }
}

/// 冻结/解冻被拒的中文话术。**按方向分叉**（"不能解冻自己的账号"与"不能冻结自己
/// 的账号"是两句不同的事），四个变体各一句、不共用兜底句。
///
/// ⚠️ 这四句是**跨语言契约**：agent 的冻结/解冻技能要求模型**逐字转述**这里给的原话
/// （见 `docs/security-boundary.md` §7⑫），所以措辞不是随手可改的文案。
fn freeze_denial_message(denial: crate::authz::FreezeDenial, frozen: bool) -> String {
    use crate::authz::FreezeDenial as D;
    let verb = if frozen { "冻结" } else { "解冻" };
    match denial {
        D::NotPermitted => "只有管理员可以冻结或解冻账号".to_string(),
        D::SelfTarget => format!("不能{verb}自己的账号"),
        D::TargetSuperadmin => format!("不能{verb}超级管理员账号"),
        D::PeerAdmin => format!("管理员之间不可互相{verb}"),
    }
}

#[derive(Deserialize)]
pub struct SendNoticeReq {
    /// 标题可省略（省略或空 ⇒ `notice::DEFAULT_TITLE`）。
    /// `Option` 而不是 `String` + 空串语义：**没填**与"填了一个空串"在界面上是同一件事，
    /// 但只有 `Option` 能让"字段压根没传"也被接住（老调用方/脚本）。
    #[serde(default)]
    pub title: Option<String>,
    /// 正文。**必填**：一条没有内容的通知发出去只是给对方添一个红点。
    pub content: String,
}

/// POST /api/temp-users/:id/notice：给**单个**账号发一条站内通知（20260926）。
///
/// 这是后台账号管理页「发通知」按钮与 agent 侧 `send_user_notice` 工具共用的唯一入口。
/// 三条边界（都写在这里，调用方不重复实现一遍）：
///   · **不给超管发**：目标判据与 `list_temp_users` 逐字同一条（`authz::is_listable_role`
///     = 已知角色 且 不是超管）。与冻结族同源的理由——列表是唯一入口，agent 的账号名录
///     走的就是这个接口，判据统一比多开一扇门好；超管不在列表里，也就不该从这里收到东西。
///   · **不群发**：全站可见是公告（announcements.rs 的 fan_out），这里是"发给某一个人"。
///   · **`link` 恒 NULL**：这条通道今天没有对应的详情页，不编一个跳过去会 404 的地址。
///
/// **成功/失败都要有话说**（agent 工具会逐字转述）：成功回「已把通知发给「{name}」」，
/// 写库失败回「通知发送失败，请稍后再试」。⚠️ 这几句是**跨语言契约**（同冻结族，
/// 见 `docs/security-boundary.md` §7⑫），改措辞前先看 agent 侧是否有引用。
///
/// **长度在这里挡，不截断**：`notice::push_notice_checked` 不截 title，超长必须在
/// 校验层就拒——静默截断会让主人在确认卡上核对的句子与库里存的不是同一句。
pub async fn send_user_notice(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i32>,
    Json(payload): Json<SendNoticeReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    let Some(target) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None) else {
        return Json(crate::utils::ApiResponse::error("用户不存在"));
    };
    if !crate::authz::is_listable_role(&target.role) {
        return Json(crate::utils::ApiResponse::error("该账号不能接收通知"));
    }
    let content = payload.content.trim().to_string();
    if content.is_empty() {
        return Json(crate::utils::ApiResponse::error("通知内容不能为空"));
    }
    if content.chars().count() > crate::routes::notice::CONTENT_MAX {
        return Json(crate::utils::ApiResponse::error(&format!(
            "通知内容太长了（最多 {} 字）",
            crate::routes::notice::CONTENT_MAX
        )));
    }
    let title = payload.title.unwrap_or_default().trim().to_string();
    let title = if title.is_empty() { crate::routes::notice::DEFAULT_TITLE.to_string() } else { title };
    if title.chars().count() > crate::routes::notice::TITLE_MAX {
        return Json(crate::utils::ApiResponse::error(&format!(
            "通知标题太长了（最多 {} 字）",
            crate::routes::notice::TITLE_MAX
        )));
    }
    match crate::routes::notice::push_notice_checked(
        &state.db,
        user_id,
        &title,
        Some(content),
        None,
    )
    .await
    {
        Ok(id) => {
            tracing::info!("[账号管理] 发通知 uid={} notice_id={} title={}", user_id, id, title);
            Json(crate::utils::ApiResponse::success(format!(
                "已把通知发给「{}」",
                target.username
            )))
        }
        Err(e) => {
            tracing::error!("[账号管理] 发通知失败 uid={}: {}", user_id, e);
            Json(crate::utils::ApiResponse::error("通知发送失败，请稍后再试"))
        }
    }
}

#[derive(Deserialize)]
pub struct SetRoleReq {
    /// 目标身份。**取值域分两档**（`authz::check_role_change` 才是判据，这里只是
    /// 说明它长什么样）：超管发起时 = `KNOWN_ROLES` 里除 superadmin 外的四个
    /// （`authz::is_assignable_role`——界面上加不出第二个超管）；管理员发起时再收窄到
    /// `authz::is_admin_tier` 那两档（普通用户 / 杂鱼）。**这里不重复判**：
    /// 多一份判据就会在"改政策"那天与 `authz.rs` 漂移。
    pub role: String,
}

/// POST /api/temp-users/:id/role：变更一个账号的权限身份（20260926）。
///
/// **谁能发起**（20261002 下放）：`authz::check_role_change` 的第一条判据是
/// `can_access_console`（管理员或超管），再按发起人分档——超管除超管外四档随便搬；
/// 管理员**只能在普通用户与杂鱼之间搬**（不动更高的账号，也不往更高档指派）。
/// 下放的理由：把一个人设成杂鱼 / 解除杂鱼是日常运营动作，不该每次都去叫超管；
/// 而"谁能当管理员"这类事仍然只有超管说了算（提权路径没有跟着下放）。
///
/// 成功时 `token_version + 1`：令牌里带 `role` 快照（`auth_jwt::Claims.role`，前端
/// `AuthRouter` 就认它），不 +1 的话被降级的人手里的旧令牌还能进后台直到过期——
/// "降级"这个动作必须当场生效，否则它只是给人看的一行字。
pub async fn set_user_role(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<SetRoleReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    let Some(operator) = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok() else {
        return Json(crate::utils::ApiResponse::error("未登录"));
    };
    let Some(operator_row) = user::Entity::find_by_id(operator).one(&state.db).await.unwrap_or(None)
    else {
        return Json(crate::utils::ApiResponse::error("未登录"));
    };
    let Some(target) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None) else {
        return Json(crate::utils::ApiResponse::error("用户不存在"));
    };
    let new_role = payload.role.trim().to_string();
    if let Err(denial) = crate::authz::check_role_change(
        operator,
        &operator_row.role,
        user_id,
        &target.role,
        &new_role,
    ) {
        return Json(crate::utils::ApiResponse::error(&role_change_denial_message(
            denial,
        )));
    }
    // 已经是这个身份 ⇒ 幂等成功，且**不动代次**（同 `/status` 的解冻那一支：
    // 没有真变化就没有理由把人踢下线）
    if target.role == new_role {
        return Json(crate::utils::ApiResponse::success(format!(
            "该账号的身份已经是{}，无需变更",
            crate::authz::role_label(&new_role)
        )));
    }
    let new_ver = target.token_version + 1;
    // 旧身份要先取出来：`target` 下面立刻被 `into()` move 走，而通知正文里
    // "从什么变成什么"两个都得有（只说结果的通知读起来像是本来就该如此）。
    let old_role = target.role.clone();
    let mut am: user::ActiveModel = target.into();
    am.role = Set(new_role.clone());
    am.token_version = Set(new_ver);
    match am.update(&state.db).await {
        Ok(_) => {
            tracing::info!(
                "[账号管理] 变更身份 uid={} → {}（发起人 uid={} role={}）",
                user_id,
                new_role,
                operator,
                operator_row.role
            );
            let when = chrono::Local::now().format("%Y年%m月%d日 %H:%M").to_string();
            crate::routes::notice::push_notice(
                &state.db,
                user_id,
                "账号身份已变更",
                Some(account_change_body(
                    &format!(
                        "{}把你的身份从「{}」改为「{}」",
                        actor_label(&operator_row),
                        crate::authz::role_label(&old_role),
                        crate::authz::role_label(&new_role),
                    ),
                    &when,
                )),
                None,
            )
            .await;
            Json(crate::utils::ApiResponse::success(format!(
                "身份已改为{}，该账号的登录状态已失效，请让对方重新登录",
                crate::authz::role_label(&new_role)
            )))
        }
        Err(e) => {
            tracing::error!("[账号管理] 变更身份失败 uid={}: {}", user_id, e);
            Json(crate::utils::ApiResponse::error("操作失败，请稍后再试"))
        }
    }
}

/// 变更身份被拒的中文话术。同样是**跨语言契约**（agent 的 `account_set_role` 技能
/// 要求模型逐字转述这里的原话，见 `docs/security-boundary.md` §7），
/// 所以七句分开写、不共用兜底。
///
/// 20261002 下放时的三处措辞改动：
///   · `NotPermitted` 的口径从"只有超管"改成"**只有管理员**"——它现在的触发条件
///     是发起人连后台都进不去（秘书/普通用户/杂鱼），而管理员已经能改了，
///     照旧印"只有超级管理员可以变更"就是一句**过期的政策**（当事人会拿这句话
///     去问超管，而超管会告诉他管理员本来就能改）。
///   · 新增两句讲清管理员的**边界**：先讲目标（"这个账号不归你管"），
///     再讲新身份（"你不能把人提到那个档"）。两句分开而不是共用一句：
///     当事人下一步该做的事不同（换账号 vs 换目标身份）。
fn role_change_denial_message(denial: crate::authz::RoleChangeDenial) -> String {
    use crate::authz::RoleChangeDenial as D;
    match denial {
        D::NotPermitted => "只有管理员可以变更账号身份".to_string(),
        D::SelfTarget => "不能变更自己的身份".to_string(),
        D::TargetSuperadmin => "不能变更超级管理员的身份".to_string(),
        D::UnknownRole => "站内没有这个身份".to_string(),
        D::NotAssignable => "超级管理员身份不能在这里指派，要增加请走数据库迁移".to_string(),
        D::AdminTargetTier => "管理员只能变更普通用户或杂鱼的身份".to_string(),
        D::AdminAssignTier => "管理员只能把账号改成普通用户或杂鱼".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use crate::authz::{FreezeDenial, RoleChangeDenial};

    /// 拒绝话术是**跨语言契约**（agent 的冻结/解冻技能要求模型逐字转述后端原话，
    /// 见 `docs/security-boundary.md` §7⑫）：所以这里逐句锁死字面量。
    /// 改这些句子之前先读那段文档——它在 agent 侧还有一份引用。
    /// 这里锁的是**话术**；"什么情况该拒"由 `authz.rs` 的策略表锁着，两件事分开测。
    #[test]
    fn 冻结话术按方向分叉且逐句锁死() {
        use FreezeDenial as D;
        assert_eq!(
            super::freeze_denial_message(D::NotPermitted, true),
            "只有管理员可以冻结或解冻账号"
        );
        assert_eq!(
            super::freeze_denial_message(D::SelfTarget, true),
            "不能冻结自己的账号"
        );
        assert_eq!(
            super::freeze_denial_message(D::TargetSuperadmin, true),
            "不能冻结超级管理员账号"
        );
        assert_eq!(
            super::freeze_denial_message(D::PeerAdmin, true),
            "管理员之间不可互相冻结"
        );
        // 解冻方向：同一族、介词换动词，**不是**共用兜底句
        assert_eq!(
            super::freeze_denial_message(D::SelfTarget, false),
            "不能解冻自己的账号"
        );
        assert_eq!(
            super::freeze_denial_message(D::TargetSuperadmin, false),
            "不能解冻超级管理员账号"
        );
        assert_eq!(
            super::freeze_denial_message(D::PeerAdmin, false),
            "管理员之间不可互相解冻"
        );
        // 越权那句与方向无关（说"只有管理员可以冻结或解冻"，两个方向同一句）
        assert_eq!(
            super::freeze_denial_message(D::NotPermitted, false),
            "只有管理员可以冻结或解冻账号"
        );
    }

    /// 变更身份的七句：六句拒绝 + 一句"超管只能走迁移"。
    /// `NotAssignable` 的措辞必须点出**替代路径**（数据库迁移），否则主人被拒之后
    /// 不知道该去哪儿加第二个超管。
    ///
    /// `NotPermitted` 那句 20261002 改了口径（超管 → 管理员）：**它必须与
    /// `authz::check_role_change` 的第一关同一天改**——发起人判据下放了而话术还写着
    /// "只有超级管理员"，就是在把一句过期的政策逐字转述给当事人（agent 侧那份
    /// 转述是逐字的）。
    #[test]
    fn 变更身份话术逐句锁死() {
        use RoleChangeDenial as D;
        assert_eq!(
            super::role_change_denial_message(D::NotPermitted),
            "只有管理员可以变更账号身份"
        );
        assert_eq!(
            super::role_change_denial_message(D::SelfTarget),
            "不能变更自己的身份"
        );
        assert_eq!(
            super::role_change_denial_message(D::TargetSuperadmin),
            "不能变更超级管理员的身份"
        );
        assert_eq!(
            super::role_change_denial_message(D::UnknownRole),
            "站内没有这个身份"
        );
        assert_eq!(
            super::role_change_denial_message(D::NotAssignable),
            "超级管理员身份不能在这里指派，要增加请走数据库迁移"
        );
        // 20261002 管理员边界那两句：一句讲目标、一句讲新身份，**不共用**——
        // 当事人下一步该做的事不同（换个账号 vs 换个目标身份）
        assert_eq!(
            super::role_change_denial_message(D::AdminTargetTier),
            "管理员只能变更普通用户或杂鱼的身份"
        );
        assert_eq!(
            super::role_change_denial_message(D::AdminAssignTier),
            "管理员只能把账号改成普通用户或杂鱼"
        );
    }

    /// 发起人的称呼（20261002 主人点名：三条账号变更通知都要写明是谁干的）。
    /// 三个面各锁一条：身份用中文、昵称带引号、uid 在场（昵称可改可重名，uid 才是标识）。
    fn row(id: i32, username: &str, nickname: &str, role: &str) -> crate::entity::user::Model {
        crate::entity::user::Model {
            id,
            username: username.to_string(),
            nickname: nickname.to_string(),
            avatar: None,
            password: String::new(),
            role: role.to_string(),
            status: 0,
            token_version: 0,
            chat_quota_used: 0,
        }
    }

    #[test]
    fn 发起人称谓带身份昵称与uid() {
        assert_eq!(
            super::actor_label(&row(1, "sora", "Sora Saudade", "superadmin")),
            "超级管理员「Sora Saudade」（uid=1）"
        );
        assert_eq!(
            super::actor_label(&row(7, "xinguan", "心关", "admin")),
            "管理员「心关」（uid=7）"
        );
        // 身份**取自那一行的 role**（库里现查的那份），不是任何令牌快照
        assert_eq!(
            super::actor_label(&row(9, "niuniu", "牛牛", "secretary")),
            "秘书「牛牛」（uid=9）"
        );
    }

    /// 昵称为空回退账号名——**不许拼出「管理员「」（uid=7）」这种空引号**。
    /// `nickname` 列允许是空串（新账号默认取账号名，但改过昵称又清空的会留空），
    /// 这条分支与 `delete_temp_user` 的 `who`、`profile.rs` 的展示口径同源。
    #[test]
    fn 昵称为空时回退账号名() {
        assert_eq!(
            super::actor_label(&row(7, "xinguan", "", "admin")),
            "管理员「xinguan」（uid=7）"
        );
        // 只有空白也算空（trim 后判）——否则会拼出「管理员「  」（uid=7）」
        assert_eq!(
            super::actor_label(&row(7, "xinguan", "   ", "admin")),
            "管理员「xinguan」（uid=7）"
        );
        // 昵称两端的空白不留进引号里
        assert_eq!(
            super::actor_label(&row(7, "xinguan", " 心关 ", "admin")),
            "管理员「心关」（uid=7）"
        );
    }
}

pub async fn create_temp_user(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTempUser>,
) -> Json<crate::utils::ApiResponse<String>> {
    let encrypted_password = hash_password(&payload.password);   // 20260917：Argon2id

    let existing = user::Entity::find()
        .filter(user::Column::Username.eq(&payload.username))
        .one(&state.db)
        .await
        .unwrap_or(None);

    if existing.is_some() {
        return Json(crate::utils::ApiResponse::error("用户名已存在"));
    }

    let _ = user::ActiveModel {
        username: Set(payload.username.clone()),
        password: Set(encrypted_password),
        role: Set("user".into()),
        ..Default::default()
    }.save(&state.db).await;

    Json(crate::utils::ApiResponse::success("临时用户创建成功".to_string()))
}

pub async fn delete_temp_user(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
) -> Json<crate::utils::ApiResponse<String>> {
    // 谁在操作（20261001）：这一支此前是**全页唯一的黑箱**——没有 tracing、没有通知，
    // 删完只剩一行不含操作人与账号名的 access log。误删之后查不出是谁、什么时候删的。
    // 取不到发起人只是少一行日志，**不阻断删除**（与 `let _ =` 的辅助事实同口径）。
    let operator = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok();
    // 只允许删普通账号（20260926）：列表现在把管理员也列出来了，那是为了让博主
    // 看得见"后台有谁"，**不是**给这个入口一条删管理员的通道——删号会连带清空
    // 那个人的全部会话数据（见下面三行级联），误点一次不可逆。管理员账号要在
    // 别处处理就另开一条明确命名的通道，而不是让它从这个入口漏过去。
    let Some(target) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None) else {
        return Json(crate::utils::ApiResponse::error("用户不存在"));
    };
    if target.role != crate::authz::ROLE_USER {
        return Json(crate::utils::ApiResponse::error("该账号不是普通用户，不能在这里删除"));
    }
    // 被删账号的称呼先拼好：`user` 行删掉之后 `target` 还在作用域里，但"删之前
    // 先把它叫什么记下来"是这类审计行的常规写法，不依赖 move 时机。
    let who = if target.nickname.trim().is_empty() {
        target.username.clone()
    } else {
        format!("{}（{}）", target.nickname.trim(), target.username)
    };
    // 删除临时用户时级联清理其全部会话数据（20260903 会话化补全：原实现漏删
    // chat_summary，属存量 bug；conversation 随会话化新增）
    let _ = crate::entity::chat_history::Entity::delete_many()
        .filter(crate::entity::chat_history::Column::UserId.eq(user_id))
        .exec(&state.db).await;
    let _ = crate::entity::chat_summary::Entity::delete_many()
        .filter(crate::entity::chat_summary::Column::UserId.eq(user_id))
        .exec(&state.db).await;
    let _ = crate::entity::conversation::Entity::delete_many()
        .filter(crate::entity::conversation::Column::UserId.eq(user_id))
        .exec(&state.db).await;
    // 删主行**这一次不再吞错**（20261001）：这三个 `let _ =` 的级联删是辅助清理，
    // 吞掉无所谓；但 `user` 行本身删失败时必须如实报——否则下面那条"账号已删除"
    // 的审计通知就是假的，而误删恰恰是这次要防的事。
    if let Err(e) = user::Entity::delete_by_id(user_id).exec(&state.db).await {
        tracing::error!("[账号管理] 删除账号失败 uid={user_id}: {e}");
        return Json(crate::utils::ApiResponse::error("删除失败，请稍后再试"));
    }
    // 审计留痕（20261001）：此前这一支**全函数没有一行 tracing**，误删之后再想查
    // "谁在什么时候删了谁"只剩一条不含操作人的 access log。与冻结/改身份对齐。
    tracing::info!(
        "[账号管理] 删除账号 uid={}（{who}）（发起人 uid={:?}）",
        user_id,
        operator
    );
    // 给**博主本人**（uid=1）留一条通知（20261001）：被删的人已经没有收件箱了
    // （通知行也随外键 CASCADE 一起没），所以这条不是"告知当事人"，而是给误删
    // 留一个看得见的痕迹——用户这次正是误删了几个账号、事后才发现。
    // 放在删除**成功之后**：删失败就没有这条，不留"已删除"的假记录。
    // uid<=0（起始账号不在库）时 `push_notice` 自己会跳过，不必在这里分支。
    crate::routes::notice::push_notice(
        &state.db,
        1,
        "账号已删除",
        Some(format!(
            "{}，账号 {who}（uid={user_id}）已被删除，其会话与通知记录一并清除。此操作不可恢复。",
            chrono::Local::now().format("%Y年%m月%d日 %H:%M"),
        )),
        None,
    )
    .await;
    Json(crate::utils::ApiResponse::success("用户已删除".to_string()))
}

/// 管理员替某个账号改密码。
///
/// 20260926：**代次 +1 ⇒ 那个人在全部设备上的登录状态当场失效**。
/// 这条路的典型场景就是"这个人的账号可能被人用了/设备丢了"，改完密码却让旧令牌
/// 继续能用，等于什么也没做。与本人改密码（`profile::change_password`）同一条纪律，
/// 区别只在于本人那台设备会拿到一枚新令牌、这里不签发（管理员不该拿到别人的令牌）。
pub async fn change_password(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i32>,
    Json(payload): Json<ChangePasswordReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    if payload.password.len() < 3 {
        return Json(crate::utils::ApiResponse::error("密码长度至少3位"));
    }
    let user_opt = user::Entity::find_by_id(user_id)
        .one(&state.db)
        .await
        .unwrap_or(None);
    match user_opt {
        Some(u) => {
            let new_ver = u.token_version + 1;
            let mut am: user::ActiveModel = u.into();
            am.password = Set(hash_password(&payload.password));   // 20260917：Argon2id
            am.token_version = Set(new_ver);
            // 不再顺手把 role 改写成 "user"（20260926）：原来列表里只有 role="user"
            // 的行，这一行是空转；现在管理员也会出现在列表里，留着它就意味着
            // 「给管理员改个密码」会**悄悄把管理员降成普通账号**（改密码不该动角色）。
            let _ = am.update(&state.db).await;
            Json(crate::utils::ApiResponse::success(
                "密码修改成功，该账号的登录状态已全部失效".to_string(),
            ))
        }
        None => Json(crate::utils::ApiResponse::error("用户不存在")),
    }
}

pub async fn create_password_reset_token(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i32>,
) -> Json<crate::utils::ApiResponse<String>> {
    let Some(_) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None) else {
        return Json(crate::utils::ApiResponse::error("用户不存在"));
    };
    password_reset_token::Entity::delete_many()
        .filter(password_reset_token::Column::UserId.eq(user_id))
        .exec(&state.db)
        .await
        .ok();

    let code = Uuid::new_v4().simple().to_string();
    let now = Utc::now().naive_utc();
    let expires_at = now + Duration::minutes(15);
    let record = password_reset_token::ActiveModel {
        user_id: Set(user_id),
        token_hash: Set(encrypt_password(&code)),
        expires_at: Set(expires_at),
        used_at: Set(None),
        created_at: Set(now),
        ..Default::default()
    };
    if record.insert(&state.db).await.is_err() {
        return Json(crate::utils::ApiResponse::error("恢复码生成失败"));
    }
    Json(crate::utils::ApiResponse::success(code))
}
