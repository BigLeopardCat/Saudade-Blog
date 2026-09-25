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
        .map(|u| TempUserInfo { id: u.id, username: u.username, role: u.role.clone() })
        .collect())
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
            let mut am: user::ActiveModel = u.into();
            am.password = Set(hash_password(&payload.password));   // 20260917：Argon2id
            // 不再顺手把 role 改写成 "user"（20260926）：原来列表里只有 role="user"
            // 的行，这一行是空转；现在管理员也会出现在列表里，留着它就意味着
            // 「给管理员改个密码」会**悄悄把管理员降成普通账号**（改密码不该动角色）。
            let _ = am.update(&state.db).await;
            Json(crate::utils::ApiResponse::success("密码修改成功".to_string()))
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
