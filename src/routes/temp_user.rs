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
}

/// 账号列表（20260926）：原来只回 `role="user"` 的临时账号，博主因此**在后台
/// 看不见管理员账号**，也就无从按角色筛。现在回全部**已知角色**的账号。
///
/// 只列已知角色（`authz::is_known_role`）：历史脏值或将来新增但未登记的角色，
/// 前端判不出该归到哪一类筛选项下——宁可不显示，也不给一行"哪一类都不是"的账号。
pub async fn list_temp_users(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<TempUserInfo>> {
    let users = user::Entity::find()
        .all(&state.db)
        .await
        .unwrap_or_default();
    Json(users.into_iter()
        .filter(|u| crate::authz::is_known_role(&u.role))
        .map(|u| TempUserInfo {
            id: u.id,
            username: u.username,
            role: u.role.clone(),
            status: u.status,
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
/// 三条拒绝（每条都对应一个真会出事的操作）：
///   ① **不许冻结自己**：冻了自己就再也解不开了（冻结账号正是改不动自己状态的那种
///      账号），唯一的管理员这么做等于把后台锁死，只能进库手改。
///   ② 目标账号必须存在。
///   ③ 目标角色必须是已知角色：与 `list_temp_users` 同一个取值域判据，
///      不让一个"列表里根本看不见"的账号从这里被改状态。
pub async fn set_user_status(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<i32>,
    Json(payload): Json<SetStatusReq>,
) -> Json<crate::utils::ApiResponse<String>> {
    // 谁在操作（不是"有没有权限"——本路由族整体挂在 auth_guard 后面，能进来的
    // 一定是管理员，见 routes/mod.rs）。这里取发起人 uid 只为挡住"冻自己"。
    let Some(operator) = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok() else {
        return Json(crate::utils::ApiResponse::error("未登录"));
    };
    if operator == user_id {
        return Json(crate::utils::ApiResponse::error("不能冻结自己的账号"));
    }
    let Some(target) = user::Entity::find_by_id(user_id).one(&state.db).await.unwrap_or(None) else {
        return Json(crate::utils::ApiResponse::error("用户不存在"));
    };
    if !crate::authz::is_known_role(&target.role) {
        return Json(crate::utils::ApiResponse::error("该账号角色未登记，不能改状态"));
    }
    let frozen = payload.frozen;
    let new_status = if frozen { crate::authz::STATUS_FROZEN } else { crate::authz::STATUS_ACTIVE };
    // 已经就是这个状态 ⇒ 幂等成功，**但不动代次**：否则同一个人连点两下"冻结"，
    // 第二下会再签发一轮代次（无害，但会让"这一下到底做了什么"变得不可解释）。
    if target.status == new_status {
        let word = if frozen { "该账号已经是冻结状态" } else { "该账号已经是正常状态" };
        return Json(crate::utils::ApiResponse::success(word.to_string()));
    }
    let new_ver = if frozen { target.token_version + 1 } else { target.token_version };
    let mut am: user::ActiveModel = target.into();
    am.status = Set(new_status);
    am.token_version = Set(new_ver);
    match am.update(&state.db).await {
        Ok(_) => {
            tracing::info!(
                "[账号管理] {} 账号 uid={}（发起人 uid={}）",
                if frozen { "冻结" } else { "解冻" },
                user_id,
                operator
            );
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
    Path(user_id): Path<i32>,
) -> Json<crate::utils::ApiResponse<String>> {
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
    let _ = user::Entity::delete_by_id(user_id)
        .exec(&state.db).await;
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
