//! Owner-bound background results, unread state and references for native conversation reports.
use crate::{auth_jwt, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DbErr, FromQueryResult, Statement, TransactionTrait, Value,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Failure = (StatusCode, Json<ApiResponse<serde_json::Value>>);
fn failure(status: StatusCode, text: &str) -> Failure {
    (status, Json(ApiResponse::error(text)))
}
fn unavailable(error: DbErr) -> Failure {
    tracing::warn!(%error, "conversation completion storage unavailable");
    failure(StatusCode::SERVICE_UNAVAILABLE, "任务消息暂不可用")
}
fn stmt(sql: impl Into<String>, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values)
}
async fn actor(state: &AppState, headers: &HeaderMap) -> Result<i32, Failure> {
    let uid = auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "账号登录已失效"))?;
    super::automation_results::authorized(&state.db, uid, false).await?;
    Ok(uid)
}
async fn owns<C: ConnectionTrait>(db: &C, uid: i32, cid: i32) -> Result<(), Failure> {
    let row = db
        .query_one(stmt(
            "SELECT id FROM conversation WHERE id=$1 AND user_id=$2",
            vec![cid.into(), uid.into()],
        ))
        .await
        .map_err(unavailable)?;
    if row.is_none() {
        return Err(failure(StatusCode::NOT_FOUND, "conversation_not_found"));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskEvent {
    pub run_id: String,
    pub version: String,
}
impl TaskEvent {
    pub fn valid(&self) -> bool {
        !self.run_id.is_empty()
            && self.run_id.len() <= 200
            && self
                .run_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && self.version.len() == 64
            && self
                .version
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    pub fn turn_id(&self) -> String {
        format!(
            "task_{}",
            hex::encode(Sha256::digest(format!("{}:{}", self.run_id, self.version)))
        )
    }
}

#[derive(Serialize, FromQueryResult)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub run_id: String,
    pub schedule_id: String,
    pub conversation_id: i32,
    pub event_version: String,
    pub status: String,
    pub title: String,
    pub content: String,
    pub report_pending: bool,
}
pub async fn read(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run): Path<String>,
    Query(query): Query<ConversationQuery>,
) -> Result<Json<ApiResponse<TaskResult>>, Failure> {
    let uid = actor(&state, &headers).await?;
    let cid = query
        .conversation_id
        .ok_or_else(|| failure(StatusCode::BAD_REQUEST, "缺少来源会话"))?;
    owns(&state.db, uid, cid).await?;
    let value = task_result(&state.db, uid, cid, &run)
        .await
        .map_err(unavailable)?
        .ok_or_else(|| failure(StatusCode::NOT_FOUND, "任务结果不存在"))?;
    Ok(Json(ApiResponse::success(value)))
}
async fn task_result<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    cid: i32,
    run: &str,
) -> Result<Option<TaskResult>, DbErr> {
    TaskResult::find_by_statement(stmt(
        "SELECT run_id,schedule_id,conversation_id,event_version,status,title,content, \
         (reported_version IS DISTINCT FROM event_version) AS report_pending \
         FROM chat_task_result WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3",
        vec![uid.into(), cid.into(), run.into()],
    ))
    .one(db)
    .await
}
pub async fn verify(
    state: &AppState,
    uid: i32,
    cid: i32,
    event: &TaskEvent,
) -> Result<bool, DbErr> {
    if !event.valid() {
        return Err(DbErr::Custom("invalid completion reference".into()));
    }
    let row = task_result(&state.db, uid, cid, &event.run_id)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("completion missing".into()))?;
    if row.event_version != event.version {
        return Err(DbErr::Custom("completion version changed".into()));
    }
    Ok(row.report_pending)
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationQuery {
    #[serde(default)]
    conversation_id: Option<i32>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Task,
    Image,
}
#[derive(Clone, Serialize, FromQueryResult)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    kind: String,
    id: String,
    conversation_id: i32,
    version: String,
    reported: bool,
}
#[derive(Serialize, FromQueryResult)]
#[serde(rename_all = "camelCase")]
pub struct UnreadConversation {
    id: i32,
    unread: i64,
    total: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    unread: i64,
    conversations: Vec<UnreadConversation>,
    items: Vec<Item>,
}
fn pending() -> String {
    format!(
        "WITH pending AS (\
        SELECT 'task'::text AS kind,run_id::text AS id,conversation_id,event_version AS version,\
            (reported_version IS NOT DISTINCT FROM event_version) AS reported,created_at \
        FROM chat_task_result WHERE owner_id=$1 AND read_at IS NULL \
        UNION ALL \
        SELECT 'image'::text,id::text,conversation_id,{},\
            (reported_version IS NOT DISTINCT FROM {}),created_at \
        FROM image_generation WHERE owner_id=$1 AND conversation_id IS NOT NULL \
            AND ({}) IN ('review','accepted','failed','unknown') \
            AND read_version IS DISTINCT FROM {} \
        ) ",
        super::image_generation::chat::VERSION,
        super::image_generation::chat::VERSION,
        super::image_generation::chat::STATUS,
        super::image_generation::chat::VERSION
    )
}
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ConversationQuery>,
) -> Result<Json<ApiResponse<Snapshot>>, Failure> {
    let uid = actor(&state, &headers).await?;
    if let Some(cid) = query.conversation_id {
        owns(&state.db, uid, cid).await?;
    }
    let conversations = UnreadConversation::find_by_statement(stmt(format!(
        "{} SELECT p.conversation_id AS id,COUNT(*) AS unread,SUM(COUNT(*)) OVER()::bigint AS total \
         FROM pending p JOIN conversation c ON c.id=p.conversation_id AND c.user_id=$1 \
         GROUP BY p.conversation_id ORDER BY MAX(p.created_at) DESC LIMIT 100", pending()),
        vec![uid.into()])).all(&state.db).await.map_err(unavailable)?;
    let items = Item::find_by_statement(stmt(
        format!(
            "{} SELECT kind,p.id,p.conversation_id,version,reported FROM pending p \
         JOIN conversation c ON c.id=p.conversation_id AND c.user_id=$1 \
         WHERE p.conversation_id=$2 ORDER BY reported,p.created_at,p.id LIMIT 20",
            pending()
        ),
        vec![uid.into(), query.conversation_id.unwrap_or(0).into()],
    ))
    .all(&state.db)
    .await
    .map_err(unavailable)?;
    let unread = conversations.first().map_or(0, |x| x.total);
    Ok(Json(ApiResponse::success(Snapshot {
        unread,
        conversations,
        items,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    conversation_id: i32,
    events: Vec<ReadEvent>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadEvent {
    kind: Kind,
    id: String,
    version: String,
}
#[derive(Default, Serialize)]
pub struct ReadReceipt {
    marked: u64,
}
pub async fn mark_read(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<ReadRequest>,
) -> Result<Json<ApiResponse<ReadReceipt>>, Failure> {
    let uid = actor(&state, &headers).await?;
    let txn = state.db.begin().await.map_err(unavailable)?;
    let result = acknowledge(&txn, uid, &value).await?;
    txn.commit().await.map_err(unavailable)?;
    Ok(Json(ApiResponse::success(result)))
}

async fn acknowledge<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    value: &ReadRequest,
) -> Result<ReadReceipt, Failure> {
    owns(db, uid, value.conversation_id).await?;
    if value.events.is_empty()
        || value.events.len() > 20
        || value.events.iter().any(|event| {
            !(TaskEvent {
                run_id: event.id.clone(),
                version: event.version.clone(),
            })
            .valid()
                || matches!(event.kind, Kind::Image) && uuid::Uuid::parse_str(&event.id).is_err()
        })
    {
        return Err(failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "未读消息引用无效",
        ));
    }
    let mut result = ReadReceipt::default();
    for event in &value.events {
        let sql = match event.kind {
            Kind::Task => "UPDATE chat_task_result SET read_at=now() WHERE owner_id=$1 \
                AND conversation_id=$2 AND run_id=$3 AND event_version=$4 AND reported_version=$4 AND read_at IS NULL".to_owned(),
            Kind::Image => format!("UPDATE image_generation SET read_version=$4 WHERE owner_id=$1 \
                AND conversation_id=$2 AND id::text=$3 AND {}=$4 AND reported_version=$4 \
                AND read_version IS DISTINCT FROM $4", super::image_generation::chat::VERSION),
        };
        result.marked += db
            .execute(stmt(
                sql,
                vec![
                    uid.into(),
                    value.conversation_id.into(),
                    event.id.clone().into(),
                    event.version.clone().into(),
                ],
            ))
            .await
            .map_err(unavailable)?
            .rows_affected();
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
