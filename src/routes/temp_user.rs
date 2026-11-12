use axum::{Json, extract::{State, Path}};
use sea_orm::{EntityTrait, Set, QueryFilter, QuerySelect, ColumnTrait, ActiveModelTrait, TransactionTrait};
use chrono::{Duration, Utc};
use uuid::Uuid;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::entity::{password_reset_token, user};
use crate::utils::hash_password_async;

#[derive(Deserialize)]
pub struct CreateTempUser {
    pub username: String,
    pub password: String,
}

// 账号状态、身份与禁言的变更及通知由 account_actions 在同一事务提交。

pub(super) fn actor_label(row: &user::Model) -> String {
    let name = if row.nickname.trim().is_empty() {
        row.username.clone()
    } else {
        row.nickname.trim().to_string()
    };
    format!("{}「{}」（uid={}）", crate::authz::role_label(&row.role), name, row.id)
}

/// 账号变更通知的正文模板。**写在这里一处**，三个调用点各自只给"变了什么"
/// （"谁干的"由 `actor_label` 拼好，是 `action` 的开头一段）。
pub(super) fn account_change_body(action: &str, when: &str) -> String {
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
    pub role: String,
    pub status: i16,
    #[serde(rename = "chatQuotaUsed")]
    pub chat_quota_used: i32,
    #[serde(rename = "chatQuotaLimit")]
    pub chat_quota_limit: i32,
    pub muted: bool,
    /// 禁言截止时间为原始库值；null 表示无禁言，9999-12-31 23:59:59 表示永久。
    #[serde(rename = "mutedUntil")]
    pub muted_until: Option<String>,
}

pub async fn list_temp_users(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<TempUserInfo>> {
    let rows = user::Entity::find()
        .select_only()
        .column(user::Column::Id)
        .column(user::Column::Username)
        .column(user::Column::Role)
        .column(user::Column::Status)
        .column(user::Column::ChatQuotaUsed)
        .column(user::Column::MutedUntil)
        .into_tuple::<(i32, String, String, i16, i32, Option<chrono::NaiveDateTime>)>()
        .all(&state.db)
        .await
        .unwrap_or_default();
    Json(rows.into_iter()
        // 判据在 `authz::is_listable_role`（= 已知角色 且 不是超管），抽出去是为了
        // 让"超管不露脸"这条需求可测：两个条件写在两行里时，删掉任何一行都不报错
        .filter(|(_id, _username, role, _status, _quota, _muted)| {
            crate::authz::is_listable_role(role)
        })
        .map(|(id, username, role, status, chat_quota_used, muted_until)| TempUserInfo {
            id,
            username,
            role: role.clone(),
            status,
            chat_quota_used,
            chat_quota_limit: crate::routes::quota::limit_of(&role),
            muted: crate::authz::is_muted(muted_until, chrono::Local::now().naive_local()),
            muted_until: muted_until.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()),
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

/// Legacy admin UI entry; shares the native transaction service and authoritative policies.
pub async fn set_user_status(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<SetStatusReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    use super::account_actions::{Action, Intent, Target};
    legacy_account_action(
        &state,
        &headers,
        Intent {
            action: if payload.frozen {
                Action::Freeze
            } else {
                Action::Unfreeze
            },
            target: Target {
                id: Some(user_id),
                username: None,
            },
            role: None,
            muted_until: None,
        },
    )
    .await
}

async fn legacy_account_action(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    intent: super::account_actions::Intent,
) -> Json<crate::utils::ApiResponse<String>> {
    match super::account_actions::execute(state, headers, &intent, None).await {
        Ok(outcome) => Json(crate::utils::ApiResponse::success(if outcome.changed {
            "账号操作已完成".to_owned()
        } else {
            "账号已是目标状态，无需变更".to_owned()
        })),
        Err(error) => {
            let message = match error {
                sea_orm::DbErr::Custom(message) => message,
                other => {
                    tracing::warn!(%other, "legacy account transaction failed");
                    "账号操作失败或结果未知，请重新查询".to_owned()
                }
            };
            Json(crate::utils::ApiResponse::error(&message))
        }
    }
}

/// 按冻结或解冻方向返回确定的权限拒绝说明。
pub(super) fn freeze_denial_message(denial: crate::authz::FreezeDenial, frozen: bool) -> String {
    use crate::authz::FreezeDenial as D;
    let verb = if frozen { "冻结" } else { "解冻" };
    match denial {
        D::NotPermitted => "只有管理员可以冻结或解冻账号".to_string(),
        D::SelfTarget => format!("不能{verb}自己的账号"),
        D::TargetSuperadmin => format!("不能{verb}超级管理员账号"),
        D::PeerAdmin => format!("管理员之间不可互相{verb}"),
    }
}

pub(super) fn mute_denial_message(denial: crate::authz::FreezeDenial, muted: bool) -> String {
    use crate::authz::FreezeDenial as D;
    let verb = if muted { "禁言" } else { "解除禁言" };
    match denial {
        D::NotPermitted => "只有管理员可以禁言或解除禁言".to_string(),
        D::SelfTarget => format!("不能{verb}自己的账号"),
        D::TargetSuperadmin => format!("不能{verb}超级管理员账号"),
        D::PeerAdmin => format!("管理员之间不可互相{verb}"),
    }
}

pub(super) fn mute_change_body(muted: bool, action: &str, when: &str) -> String {
    if muted {
        format!(
            "{when}，{action}。你的登录状态不受影响——仍可正常登录、浏览文章、与泠月喵对话，\
只是暂时不能发布评论与留言。"
        )
    } else {
        format!("{when}，{action}。你现在可以正常发布评论与留言了。")
    }
}

#[derive(Deserialize)]
pub struct SetMuteReq {
    /// true 设置禁言，false 解除禁言；显式目标状态支持幂等重试。
    pub muted: bool,
    /// 禁言时长（小时）。**`null` 或 `<= 0` ⇒ 永久**（`authz::MUTE_FOREVER`）；
    /// 解禁方向忽略它。做成 `Option` 而不是"0 表示永久"：后台的时长选项里
    /// "永久"是一个明确的选项，不该与"填了个 0"共用一条路。
    #[serde(default)]
    pub hours: Option<i32>,
}

/// Legacy hours input is converted once into an absolute Shanghai deadline.
pub async fn set_user_muted(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<SetMuteReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    use super::account_actions::{Action, Intent, Target};
    let until = if payload.muted {
        let now = chrono::Utc::now()
            .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
            .naive_local();
        let value = match payload.hours {
            Some(hours) if hours > 0 => now.checked_add_signed(Duration::hours(i64::from(hours))),
            _ => Some(crate::authz::mute_forever_at()),
        };
        let Some(value) = value else {
            return Json(crate::utils::ApiResponse::error("禁言时长超出范围"));
        };
        Some(value.format("%Y-%m-%dT%H:%M:%S").to_string())
    } else {
        None
    };
    legacy_account_action(
        &state,
        &headers,
        Intent {
            action: if payload.muted {
                Action::Mute
            } else {
                Action::Unmute
            },
            target: Target {
                id: Some(user_id),
                username: None,
            },
            role: None,
            muted_until: until,
        },
    )
    .await
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

/// Send one notice through the same transaction service used by native approvals.

pub async fn send_user_notice(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<SendNoticeReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    super::notice_actions::legacy_send(&state, &headers, user_id, payload.title, payload.content).await
}

#[derive(Deserialize)]
pub struct SetRoleReq {
/// 目标身份。**取值域分两档**（`authz::check_role_change` 才是判据，这里只是
    pub role: String,
}

/// Legacy role input shares the same atomic account service.
pub async fn set_user_role(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<SetRoleReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    use super::account_actions::{Action, Intent, Target};
    legacy_account_action(
        &state,
        &headers,
        Intent {
            action: Action::SetRole,
            target: Target {
                id: Some(user_id),
                username: None,
            },
            role: Some(payload.role.trim().to_owned()),
            muted_until: None,
        },
    )
    .await
}

pub(super) fn role_change_denial_message(denial: crate::authz::RoleChangeDenial) -> String {
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

    /// 核对冻结和解冻的拒绝文案；权限组合由 authz 测试覆盖。
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

    #[test]
    fn 禁言话术与冻结同规则但各说各的动词() {
        use FreezeDenial as D;
        assert_eq!(
            super::mute_denial_message(D::NotPermitted, true),
            "只有管理员可以禁言或解除禁言"
        );
        assert_eq!(super::mute_denial_message(D::SelfTarget, true), "不能禁言自己的账号");
        assert_eq!(
            super::mute_denial_message(D::TargetSuperadmin, true),
            "不能禁言超级管理员账号"
        );
        assert_eq!(super::mute_denial_message(D::PeerAdmin, true), "管理员之间不可互相禁言");
        // 解禁方向换动词（与冻结那一族的"解冻"各说各的）
        assert_eq!(super::mute_denial_message(D::SelfTarget, false), "不能解除禁言自己的账号");
        assert_eq!(
            super::mute_denial_message(D::TargetSuperadmin, false),
            "不能解除禁言超级管理员账号"
        );
        assert_eq!(
            super::mute_denial_message(D::PeerAdmin, false),
            "管理员之间不可互相解除禁言"
        );
        assert_eq!(
            super::mute_denial_message(D::NotPermitted, false),
            "只有管理员可以禁言或解除禁言"
        );
        // **禁言话术里不许出现"冻结"**：这两件事混说，当事人会以为账号被封了
        for muted in [true, false] {
            for d in [D::NotPermitted, D::SelfTarget, D::TargetSuperadmin, D::PeerAdmin] {
                let s = super::mute_denial_message(d, muted);
                assert!(!s.contains("冻结") && !s.contains("解冻"), "{s}");
            }
        }
    }

    /// 永久禁言展示为“永久”，不暴露哨兵日期。
    #[test]
    fn 禁言到期时刻永久直说永久() {
        let until = chrono::NaiveDateTime::parse_from_str(
            "2026-10-04 12:00:00",
            "%Y-%m-%d %H:%M:%S",
        )
        .unwrap();
        assert_eq!(crate::authz::mute_until_text(until), "至 2026-10-04 12:00");
        let forever = crate::authz::mute_until_text(crate::authz::mute_forever_at());
        assert_eq!(forever, "永久");
        assert!(!forever.contains("9999"), "{forever}");
    }

    #[test]
    fn 禁言通知不说登录失效() {
        let muted = super::mute_change_body(true, "管理员「心关」（uid=7）禁言了你的账号（至 2026-10-04 12:00）", "2026年10月03日 12:00");
        assert!(muted.contains("禁言了你的账号"), "{muted}");
        assert!(muted.contains("至 2026-10-04 12:00"), "{muted}");
        assert!(muted.contains("仍可正常登录、浏览文章、与泠月喵对话"), "{muted}");
        assert!(!muted.contains("失效"), "{muted}");
        assert!(!muted.contains("重新登录"), "{muted}");

        let unmuted = super::mute_change_body(false, "管理员「心关」（uid=7）解除了你的禁言", "2026年10月03日 12:00");
        assert!(unmuted.contains("可以正常发布评论与留言"), "{unmuted}");
        assert!(!unmuted.contains("失效"), "{unmuted}");

        // 反面对照：冻结那一份**必须**保留那半句（两件事不是同一件事）
        let frozen = super::account_change_body("博主冻结了你的账号", "2026年10月03日 12:00");
        assert!(frozen.contains("需要重新登录"), "{frozen}");
    }

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
        assert_eq!(
            super::role_change_denial_message(D::AdminTargetTier),
            "管理员只能变更普通用户或杂鱼的身份"
        );
        assert_eq!(
            super::role_change_denial_message(D::AdminAssignTier),
            "管理员只能把账号改成普通用户或杂鱼"
        );
    }

    fn row(id: i32, username: &str, nickname: &str, role: &str) -> crate::entity::user::Model {
        crate::entity::user::Model {
            id,
            username: username.to_string(),
            nickname: nickname.to_string(),
            nickname_auto_renamed: 0,
            avatar: None,
            password: String::new(),
            role: role.to_string(),
            status: 0,
            token_version: 0,
            chat_quota_used: 0,
            muted_until: None,
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
            super::actor_label(&row(9, "niuniu", "牛牛", "zako")),
            "杂鱼「牛牛」（uid=9）"
        );
    }

    /// 昵称为空时回退账号名。
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
    let username = payload.username.trim();
    if let Some(msg) = crate::utils::username_reject(username) {
        return Json(crate::utils::ApiResponse::error(msg));
    }
    if let Some(msg) = crate::utils::password_reject(&payload.password) {
        return Json(crate::utils::ApiResponse::error(msg));
    }

    let encrypted_password = match hash_password_async(payload.password.clone()).await {
        Ok(v) => v,
        Err(msg) => return Json(crate::utils::ApiResponse::error(msg)),
    };

    let existing = user::Entity::find()
        .filter(user::Column::Username.eq(username))
        .one(&state.db)
        .await
        .unwrap_or(None);

    if existing.is_some() {
        return Json(crate::utils::ApiResponse::error("用户名已存在"));
    }

    let created = (user::ActiveModel {
        username: Set(username.to_string()),
        password: Set(encrypted_password),
        role: Set("user".into()),
        ..Default::default()
    }).save(&state.db).await;
    if let Err(e) = created {
        tracing::error!("[账号管理] 创建账号失败 username={username}: {e}");
        return Json(crate::utils::ApiResponse::error("创建失败，请稍后再试"));
    }

    Json(crate::utils::ApiResponse::success("临时用户创建成功".to_string()))
}

pub async fn delete_temp_user(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
) -> Json<crate::utils::ApiResponse<String>> {
    let operator = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok();
    let Some(target) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None) else {
        return Json(crate::utils::ApiResponse::error("用户不存在"));
    };
    if target.role != crate::authz::ROLE_USER {
        return Json(crate::utils::ApiResponse::error("该账号不是普通用户，不能在这里删除"));
    }
    // 删除前保留目标称呼，用于操作通知。
    let who = if target.nickname.trim().is_empty() {
        target.username.clone()
    } else {
        format!("{}（{}）", target.nickname.trim(), target.username)
    };
    let txn = match state.db.begin().await {
        Ok(txn) => txn,
        Err(error) => {
            tracing::error!(%error, "账号删除事务启动失败");
            return Json(crate::utils::ApiResponse::error("删除失败，请稍后再试"));
        }
    };
    let deletion = async {
        let threads = crate::routes::conversation::purge_conversation_data(
            &txn, crate::routes::conversation::ConvScope::UserId(user_id),
        ).await?;
        user::Entity::delete_by_id(user_id).exec(&txn).await?;
        Ok::<_, sea_orm::DbErr>(threads)
    }.await;
    let threads = match deletion {
        Ok(threads) => threads,
        Err(error) => {
            tracing::error!(%error, user_id, "账号与会话删除失败，事务回滚");
            let _ = txn.rollback().await;
            return Json(crate::utils::ApiResponse::error("删除失败，请稍后再试"));
        }
    };
    if let Err(error) = txn.commit().await {
        tracing::error!(%error, user_id, "账号删除提交失败");
        return Json(crate::utils::ApiResponse::error("删除失败，请稍后再试"));
    }
    crate::checkpoint_cleanup::dispatch(&state.db, &threads).await;
    tracing::info!(
        "[账号管理] 删除账号 uid={}（{who}）（发起人 uid={:?}）",
        user_id,
        operator
    );
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

async fn credential_change_transaction(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    target_id: i32,
) -> Result<(sea_orm::DatabaseTransaction, user::Model), &'static str> {
    let operator = crate::auth_jwt::auth_uid(&state.db, headers).await
        .map_err(|_| "未登录")?;
    if operator == target_id {
        return Err("请在个人中心验证原密码后修改自己的密码");
    }
    let txn = state.db.begin().await.map_err(|e| {
        tracing::error!("[账号管理] 开启凭据事务失败: {e}");
        "服务暂时不可用，请稍后再试"
    })?;
    let actor = user::Entity::find_by_id(operator).lock_shared().one(&txn).await
        .map_err(|_| "服务暂时不可用，请稍后再试")?
        .ok_or("未登录")?;
    let target = user::Entity::find_by_id(target_id).lock_exclusive().one(&txn).await
        .map_err(|_| "服务暂时不可用，请稍后再试")?
        .ok_or("用户不存在")?;
    if crate::authz::is_frozen(actor.status)
        || !crate::authz::can_manage_credentials(actor.id, &actor.role, target.id, &target.role)
    {
        return Err("无权管理该账号的密码或恢复码");
    }
    Ok((txn, target))
}

pub async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<ChangePasswordReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    if let Some(msg) = crate::utils::password_reject(&payload.password) {
        return Json(crate::utils::ApiResponse::error(msg));
    }
    let (txn, target) = match credential_change_transaction(&state, &headers, user_id).await {
        Ok(v) => v,
        Err(msg) => return Json(crate::utils::ApiResponse::error(msg)),
    };
    let mut am: user::ActiveModel = target.clone().into();
    am.password = Set(match hash_password_async(payload.password.clone()).await {
        Ok(v) => v,
        Err(msg) => return Json(crate::utils::ApiResponse::error(msg)),
    });
    am.token_version = Set(target.token_version + 1);
    if let Err(e) = am.update(&txn).await {
        tracing::error!("[账号管理] 修改密码失败 uid={user_id}: {e}");
        return Json(crate::utils::ApiResponse::error("密码修改失败，请稍后再试"));
    }
    // 修改凭据后，之前签发的恢复码也不再允许取回账号。
    if let Err(e) = password_reset_token::Entity::delete_many()
        .filter(password_reset_token::Column::UserId.eq(user_id)).exec(&txn).await
    {
        tracing::error!("[账号管理] 清理恢复码失败 uid={user_id}: {e}");
        return Json(crate::utils::ApiResponse::error("密码修改失败，请稍后再试"));
    }
    if let Err(e) = txn.commit().await {
        tracing::error!("[账号管理] 提交密码修改失败 uid={user_id}: {e}");
        return Json(crate::utils::ApiResponse::error("密码修改失败，请稍后再试"));
    }
    Json(crate::utils::ApiResponse::success(
        "密码修改成功，该账号的登录状态已全部失效".to_string(),
    ))
}

pub async fn create_password_reset_token(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
) -> Json<crate::utils::ApiResponse<String>> {
    let (txn, _) = match credential_change_transaction(&state, &headers, user_id).await {
        Ok(v) => v,
        Err(msg) => return Json(crate::utils::ApiResponse::error(msg)),
    };
    if let Err(e) = password_reset_token::Entity::delete_many()
        .filter(password_reset_token::Column::UserId.eq(user_id)).exec(&txn).await
    {
        tracing::error!("[账号管理] 清理旧恢复码失败 uid={user_id}: {e}");
        return Json(crate::utils::ApiResponse::error("恢复码生成失败"));
    }
    let code = Uuid::new_v4().simple().to_string();
    let now = Utc::now().naive_utc();
    let record = password_reset_token::ActiveModel {
        user_id: Set(user_id),
        token_hash: Set(match hash_password_async(code.clone()).await {
            Ok(v) => v,
            Err(msg) => return Json(crate::utils::ApiResponse::error(msg)),
        }),
        expires_at: Set(now + Duration::minutes(15)),
        used_at: Set(None),
        created_at: Set(now),
        ..Default::default()
    };
    if let Err(e) = record.insert(&txn).await {
        tracing::error!("[账号管理] 保存恢复码失败 uid={user_id}: {e}");
        return Json(crate::utils::ApiResponse::error("恢复码生成失败"));
    }
    if let Err(e) = txn.commit().await {
        tracing::error!("[账号管理] 提交恢复码失败 uid={user_id}: {e}");
        return Json(crate::utils::ApiResponse::error("恢复码生成失败"));
    }
    Json(crate::utils::ApiResponse::success(code))
}
