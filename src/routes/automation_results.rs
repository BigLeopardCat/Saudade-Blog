//! Owner-only, idempotent delivery of background task results.

use crate::{authz, entity::user, routes::AppState, utils::ApiResponse};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Failure = (StatusCode, Json<ApiResponse<serde_json::Value>>);
fn failure(status: StatusCode, message: &str) -> Failure {
    (status, Json(ApiResponse::error(message)))
}
fn storage_error(error: DbErr) -> Failure {
    tracing::error!("automation result storage failed: {error}");
    failure(StatusCode::SERVICE_UNAVAILABLE, "任务结果服务暂不可用")
}
#[derive(Serialize)]
pub struct Actor {
    id: i32,
    role: String,
}

pub(super) async fn authorized<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    lock: bool,
) -> Result<user::Model, Failure> {
    let mut query = user::Entity::find_by_id(owner);
    if lock {
        query = query.lock(sea_orm::sea_query::LockType::Share);
    }
    let actor = query
        .one(db)
        .await
        .map_err(storage_error)?
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "账号已失效"))?;
    if authz::is_frozen(actor.status) || !authz::can_access_console(&actor.role) {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "仅有效管理员可以使用后台计划任务",
        ));
    }
    Ok(actor)
}
pub async fn actor(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<Actor>>, Failure> {
    let uid = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let row = authorized(&state.db, uid, false).await?;
    Ok(Json(ApiResponse::success(Actor {
        id: row.id,
        role: row.role,
    })))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delivery {
    run_id: String,
    title: String,
    content: String,
    #[serde(default)]
    result_text: Option<String>,
    #[serde(default)]
    conversation_id: Option<i32>,
    #[serde(default)]
    schedule_id: Option<String>,
    #[serde(default = "completed")]
    status: String,
}
fn completed() -> String {
    "completed".into()
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    notification_id: Option<i32>,
    conversation_id: Option<i32>,
    replayed: bool,
}

fn validate(value: &Delivery) -> Result<(), Failure> {
    if value.run_id.is_empty()
        || value.run_id.len() > 200
        || !value
            .run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || value.title.trim().is_empty()
        || value.title.chars().count() > 80
        || value.result_text.as_ref().is_some_and(|text| {
            text.trim().is_empty() || text.chars().count() > 64000 || text.contains('\0')
        })
        || value.content.trim().is_empty()
        || value.content.chars().count() > 1000
        || value.title.contains('\0')
        || value.content.contains('\0')
        || value.conversation_id.is_some_and(|id| id <= 0)
        || value.conversation_id.is_some() && value.schedule_id.is_none()
        || !["completed", "incomplete", "failed", "unknown"].contains(&value.status.as_str())
        || value.schedule_id.as_ref().is_some_and(|id| {
            id.len() != 35
                || !id.starts_with("sc_")
                || !id[3..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Err(failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "执行编号、标题或正文无效",
        ));
    }
    Ok(())
}

async fn origin<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    value: &Delivery,
) -> Result<Option<i32>, Failure> {
    let cid = if let Some(cid) = value.conversation_id {
        Some(cid)
    } else if let Some(schedule) = &value.schedule_id {
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "SELECT conversation_id FROM execution_log WHERE user_id=$1 AND tool='create_automation' \
             AND (CASE WHEN payload IS JSON OBJECT THEN payload::jsonb ELSE '{}'::jsonb END) \
                 ->'args'->>'schedule_id'=$2 ORDER BY id ASC LIMIT 1",
            [owner.into(), schedule.clone().into()])).await.map_err(storage_error)?;
        row.map(|r| r.try_get("", "conversation_id"))
            .transpose()
            .map_err(storage_error)?
    } else {
        None
    };
    let Some(cid) = cid else { return Ok(None) };
    let row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT user_id FROM conversation WHERE id=$1 FOR SHARE",
            [cid.into()],
        ))
        .await
        .map_err(storage_error)?;
    match row {
        Some(row) if row.try_get::<i32>("", "user_id").map_err(storage_error)? != owner => {
            Err(failure(StatusCode::FORBIDDEN, "任务来源会话不属于当前账号"))
        }
        Some(_) => Ok(Some(cid)),
        None => Ok(None),
    }
}

async fn saved_conversation<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    value: &Delivery,
) -> Result<Option<i32>, Failure> {
    let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT conversation_id,content,status FROM chat_task_result WHERE owner_id=$1 AND run_id=$2",
        [owner.into(), value.run_id.clone().into()])).await.map_err(storage_error)?;
    let Some(row) = row else { return Ok(None) };
    if let Some(text) = &value.result_text {
        if row
            .try_get::<String>("", "content")
            .map_err(storage_error)?
            != *text
            || row.try_get::<String>("", "status").map_err(storage_error)? != value.status
        {
            return Err(failure(StatusCode::CONFLICT, "执行编号已对应其他完整结果"));
        }
    }
    row.try_get("", "conversation_id")
        .map(Some)
        .map_err(storage_error)
}

async fn save_chat_result<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    cid: Option<i32>,
    value: &Delivery,
    version: &str,
) -> Result<(), Failure> {
    let (Some(cid), Some(schedule)) = (cid, &value.schedule_id) else {
        return Ok(());
    };
    db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO chat_task_result (owner_id,run_id,conversation_id,schedule_id,title,content,status,event_version) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [owner.into(), value.run_id.clone().into(), cid.into(), schedule.clone().into(),
         value.title.clone().into(), value.result_text.as_ref().unwrap_or(&value.content).clone().into(), value.status.clone().into(), version.into()]))
        .await.map_err(storage_error)?;
    Ok(())
}
async fn apply<C: ConnectionTrait>(
    db: &C,
    owner: i32,
    value: &Delivery,
) -> Result<Receipt, Failure> {
    validate(value)?;
    authorized(db, owner, true).await?;
    let conversation_id = origin(db, owner, value).await?;
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&(&value.title, &value.content)).unwrap(),
    ));
    let claim = db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO automation_result_delivery (owner_id,run_id,payload_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [owner.into(), value.run_id.clone().into(), digest.clone().into()])).await.map_err(storage_error)?;
    if claim.rows_affected() == 0 {
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "SELECT payload_hash,notification_id FROM automation_result_delivery WHERE owner_id=$1 AND run_id=$2",
            [owner.into(), value.run_id.clone().into()])).await.map_err(storage_error)?
            .ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE, "无法核对任务投递状态"))?;
        let previous: String = row.try_get("", "payload_hash").map_err(storage_error)?;
        if previous != digest {
            return Err(failure(StatusCode::CONFLICT, "执行编号已对应其他结果"));
        }
        let saved = saved_conversation(db, owner, value).await?;
        if saved.is_some() && conversation_id.is_some() && saved != conversation_id {
            return Err(failure(StatusCode::CONFLICT, "任务结果已绑定其他会话"));
        }
        return Ok(Receipt {
            notification_id: row.try_get("", "notification_id").map_err(storage_error)?,
            conversation_id: saved,
            replayed: true,
        });
    }
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            &value.title,
            &value.status,
            value.result_text.as_ref().unwrap_or(&value.content),
        ))
        .unwrap(),
    ));
    save_chat_result(db, owner, conversation_id, value, &version).await?;
    let notification_id = super::notice::push_notice_checked(
        db,
        owner,
        &value.title,
        Some(value.content.clone()),
        None,
    )
    .await
    .map_err(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "任务结果通知未能保存"))?;
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE automation_result_delivery SET notification_id=$3 WHERE owner_id=$1 AND run_id=$2",
        [
            owner.into(),
            value.run_id.clone().into(),
            notification_id.into(),
        ],
    ))
    .await
    .map_err(storage_error)?;
    Ok(Receipt {
        notification_id: Some(notification_id),
        conversation_id,
        replayed: false,
    })
}

pub async fn deliver(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Delivery>,
) -> Result<Json<ApiResponse<Receipt>>, Failure> {
    let uid = crate::auth_jwt::auth_uid(&state.db, &headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "未登录或账号已失效"))?;
    let txn = state.db.begin().await.map_err(storage_error)?;
    let result = apply(&txn, uid, &value).await?;
    txn.commit().await.map_err(storage_error)?;
    Ok(Json(ApiResponse::success(result)))
}

#[cfg(test)]
mod tests;
