//! One recipient-scoped snapshot of unread counts and bounded, readable headers.

use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    Json,
    extract::{Query, State},
    http::HeaderMap,
};
use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverviewQuery {
    #[serde(default = "default_limit")]
    limit: u64,
}
fn default_limit() -> u64 {
    5
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub user_id: i32,
    pub notifications: i64,
    pub messages: i64,
    pub total: i64,
    pub limit: u64,
    pub unread_only: bool,
    pub notification_items: Vec<Value>,
    pub message_items: Vec<Value>,
    pub notifications_has_more: bool,
    pub messages_has_more: bool,
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    limit: u64,
) -> Result<Overview, DbErr> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            include_str!("inbox_overview/query.sql"),
            [uid.into(), (limit as i64).into()],
        ))
        .await?;
    let mut result = Overview {
        user_id: uid,
        limit,
        unread_only: true,
        ..Default::default()
    };
    for row in rows {
        result.notifications = row.try_get("", "notifications")?;
        result.messages = row.try_get("", "messages")?;
        let Some(id) = row.try_get::<Option<i32>>("", "id")? else {
            continue;
        };
        let created: chrono::NaiveDateTime = row.try_get("", "created_at")?;
        let mut item = json!({"id":id,"title":row.try_get::<String>("","title")?,
            "titleTruncated":row.try_get::<bool>("","title_truncated")?,
            "createdAt":created,"isRead":false});
        let source: String = row.try_get("", "source")?;
        match source.as_str() {
            "notification" => {
                item["type"] = json!(row.try_get::<String>("", "type")?);
                result.notification_items.push(item);
            }
            "message" => {
                item["fromUserId"] = json!(row.try_get::<i32>("", "from_user_id")?);
                item["peerName"] = json!(row.try_get::<String>("", "peer_name")?);
                result.message_items.push(item);
            }
            _ => return Err(DbErr::Custom("invalid inbox source".into())),
        }
    }
    result.total = result.notifications + result.messages;
    result.notifications_has_more = (result.notification_items.len() as i64) < result.notifications;
    result.messages_has_more = (result.message_items.len() as i64) < result.messages;
    Ok(result)
}

pub async fn get_inbox_overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<OverviewQuery>,
) -> Json<ApiResponse<Overview>> {
    if !(1..=10).contains(&query.limit) {
        return Json(ApiResponse::error("每类预览只能读取1至10条"));
    }
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(value) => value,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    let task = async {
        let tx = state.db.begin().await?;
        tx.execute_unprepared("SET TRANSACTION READ ONLY").await?;
        tx.execute_unprepared("SET LOCAL statement_timeout = '2000ms'")
            .await?;
        let result = read(&tx, uid, query.limit).await?;
        tx.commit().await?;
        Ok::<_, DbErr>(result)
    };
    match tokio::time::timeout(Duration::from_secs(3), task).await {
        Ok(Ok(result)) => Json(ApiResponse::success(result)),
        Ok(Err(error)) => crate::routes::db_error("未读收件总览", &error),
        Err(_) => Json(ApiResponse::error("未读收件查询超时，请稍后重试")),
    }
}

#[cfg(test)]
mod tests;
