//! Current-actor policy checks are read-only and never grant execution authority.
use super::{targets, Action};
use crate::{authz, entity::user, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    AccessMode, ColumnTrait, EntityTrait, IsolationLevel, QueryFilter, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EligibilityQuery {
    pub account_id: i32,
    pub action: Action,
    pub role: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Eligibility {
    account_id: i32,
    action: Action,
    role: Option<String>,
    allowed: bool,
    reason_code: Option<&'static str>,
    message: String,
}

fn failure(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ApiResponse {
            code: i32::from(status.as_u16()),
            message: message.to_owned(),
            data: serde_json::Value::Null,
        }),
    )
        .into_response()
}

pub async fn read(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<EligibilityQuery>,
) -> Response {
    if query.account_id <= 0
        || (query.action == Action::SetRole) != query.role.is_some()
        || query
            .role
            .as_deref()
            .is_some_and(|role| !authz::is_known_role(role))
    {
        return failure(
            StatusCode::BAD_REQUEST,
            "请提供确切账号编号；仅变更身份须提供已登记的目标身份",
        );
    }
    let Some(claims) = crate::auth_jwt::claims_from_headers(&headers) else {
        return failure(StatusCode::UNAUTHORIZED, "请先登录");
    };
    let result = async {
        let txn = state
            .db
            .begin_with_config(
                Some(IsolationLevel::RepeatableRead),
                Some(AccessMode::ReadOnly),
            )
            .await?;
        let rows = user::Entity::find()
            .filter(user::Column::Id.is_in([claims.sub, query.account_id]))
            .all(&txn)
            .await?;
        let Some(actor) = rows.iter().find(|row| row.id == claims.sub) else {
            return Ok::<_, sea_orm::DbErr>(failure(StatusCode::UNAUTHORIZED, "登录账号已不存在"));
        };
        if authz::check_token(actor.status, actor.token_version, claims.ver).is_err() {
            return Ok(failure(
                StatusCode::UNAUTHORIZED,
                "登录状态已变化，请重新登录",
            ));
        }
        if !authz::can_access_console(&actor.role) {
            return Ok(failure(StatusCode::FORBIDDEN, "当前身份无权管理账号"));
        }
        let Some(target) = rows.iter().find(|row| row.id == query.account_id) else {
            return Ok(failure(StatusCode::NOT_FOUND, "目标账号不存在"));
        };
        let (allowed, reason_code, message) =
            match targets::policy(actor, target, &query.action, query.role.as_deref()) {
                Ok(()) => (
                    true,
                    None,
                    "当前身份允许此账号操作；仍需完整参数、确认及执行时重新核验。".to_owned(),
                ),
                Err(denial) => (false, Some(denial.code()), denial.message(&query.action)),
            };
        txn.commit().await?;
        Ok(Json(ApiResponse::success(Eligibility {
            account_id: query.account_id,
            action: query.action,
            role: query.role,
            allowed,
            reason_code,
            message,
        }))
        .into_response())
    }
    .await;
    match result {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(event="account_eligibility_failed",error=%error,"account policy could not be verified");
            failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "账号操作资格暂时无法核对，请稍后重试",
            )
        }
    }
}
