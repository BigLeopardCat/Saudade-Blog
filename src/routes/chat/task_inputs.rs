//! Authenticated task controls and idempotent persistence of applied user inputs.

use crate::{
    auth_jwt,
    entity::{chat_history, user},
    routes::AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, DbBackend, DbErr, EntityTrait, Set,
    Statement, TransactionTrait,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{sync::Arc, time::Duration};

#[derive(Deserialize)]
pub struct Control {
    conversation_id: i32,
    task_id: String,
    input_id: Option<String>,
    turn_id: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
pub struct ConfirmationControl {
    conversation_id: i32,
    task_id: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Submit,
    Inputs,
    Confirmation,
}

impl Action {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Submit => "tasks/input",
            Self::Inputs => "tasks/inputs/status",
            Self::Confirmation => "tasks/confirmation",
        }
    }
}

fn identifier(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 100
        && text
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn failure(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({"error":error}))).into_response()
}

pub async fn submit_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<Control>,
) -> Response {
    control(state, headers, req, Action::Submit).await
}

pub async fn status_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<Control>,
) -> Response {
    control(state, headers, req, Action::Inputs).await
}

pub async fn confirmation_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ConfirmationControl>,
) -> Response {
    control(
        state,
        headers,
        Control {
            conversation_id: req.conversation_id,
            task_id: req.task_id.unwrap_or_default(),
            input_id: None,
            turn_id: None,
            text: None,
        },
        Action::Confirmation,
    )
    .await
}

async fn control(
    state: Arc<AppState>,
    headers: HeaderMap,
    req: Control,
    action: Action,
) -> Response {
    let submit = action == Action::Submit;
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(_) => return failure(StatusCode::UNAUTHORIZED, "unauthorized"),
    };
    if (!(action == Action::Confirmation && req.task_id.is_empty()) && !identifier(&req.task_id))
        || (submit
            && (!req.turn_id.as_deref().is_some_and(identifier)
                || !req.input_id.as_deref().is_some_and(identifier)
                || !req
                    .text
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 2000)))
    {
        return failure(StatusCode::BAD_REQUEST, "invalid_input");
    }
    if !matches!(
        super::resolve_conversation_id(&state.db, uid, Some(req.conversation_id), false).await,
        Ok(Some(_))
    ) {
        return failure(StatusCode::NOT_FOUND, "conversation_not_found");
    }
    let role = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(row)) if crate::authz::is_known_role(&row.role) => row.role,
        _ => return failure(StatusCode::SERVICE_UNAVAILABLE, "identity_unavailable"),
    };
    let endpoint = action.endpoint();
    let mut payload =
        json!({"user_id":uid,"conversation_id":req.conversation_id,"task_id":req.task_id});
    if action == Action::Confirmation && req.task_id.is_empty() {
        payload.as_object_mut().unwrap().remove("task_id");
    }
    if submit {
        payload["turn_id"] = json!(req.turn_id);
        payload["input_id"] = json!(req.input_id);
        payload["text"] = json!(req.text.as_deref().unwrap_or("").trim());
    }
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(value) => value,
        Err(_) => return failure(StatusCode::BAD_GATEWAY, "agent_unavailable"),
    };
    let response = match client
        .post(format!(
            "{}/{endpoint}",
            crate::ai_services::agent_base_url()
        ))
        .header(
            "X-Agent-Assertion",
            auth_jwt::create_agent_assertion(uid, Some(&role)),
        )
        .json(&payload)
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(value) => value,
        Err(_) => return failure(StatusCode::BAD_GATEWAY, "agent_unavailable"),
    };
    let status = response.status();
    let mut body = match response.json::<Value>().await {
        Ok(value) => value,
        Err(_) => return failure(StatusCode::BAD_GATEWAY, "invalid_agent_response"),
    };
    if status.is_success() {
        if !req.task_id.is_empty() && body["task_id"].as_str() != Some(&req.task_id) {
            return failure(StatusCode::BAD_GATEWAY, "task_mismatch");
        }
        if action == Action::Confirmation {
            let mut response = (status, Json(body)).into_response();
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                "no-store".parse().unwrap(),
            );
            return response;
        }
        // Every applied snapshot contains its ordered prefix. Replayed HTTP
        // responses cannot insert a later supplemental message ahead of it.
        let items = body["inputs"].as_array().cloned().unwrap_or_default();
        let mut saved = Vec::new();
        for item in items {
            match save(
                &state.db,
                uid,
                req.conversation_id,
                &role,
                &req.task_id,
                item["turn_id"].as_str().unwrap_or(""),
                &item,
            )
            .await
            {
                Ok(item) => saved.push(item),
                Err(error) => {
                    tracing::warn!(%error, "task input persistence failed");
                    return failure(StatusCode::SERVICE_UNAVAILABLE, "input_sync_failed");
                }
            }
        }
        if submit {
            let Some(item) = saved
                .iter()
                .find(|item| item["id"].as_str() == req.input_id.as_deref())
            else {
                return failure(StatusCode::BAD_GATEWAY, "input_mismatch");
            };
            body["input"] = item.clone();
            body["inputs"] = json!(saved);
        } else {
            body["inputs"] = json!(saved);
        }
    }
    (status, Json(body)).into_response()
}

pub(super) async fn save<C: ConnectionTrait + TransactionTrait>(
    db: &C,
    uid: i32,
    cid: i32,
    role: &str,
    task: &str,
    turn_id: &str,
    item: &Value,
) -> Result<Value, DbErr> {
    let invalid = || DbErr::Custom("invalid task input".into());
    let id = item["id"]
        .as_str()
        .filter(|id| identifier(id))
        .ok_or_else(invalid)?;
    let text = item["text"]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= 2000)
        .ok_or_else(invalid)?;
    let status = item["status"]
        .as_str()
        .filter(|s| ["queued", "applied", "not_applied"].contains(s))
        .ok_or_else(invalid)?;
    if !identifier(turn_id) || !identifier(task) || !crate::authz::is_known_role(role) {
        return Err(invalid());
    }
    let txn = db.begin().await?;
    let owner = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id FROM conversation WHERE id=$1 AND user_id=$2 FOR UPDATE",
            [cid.into(), uid.into()],
        ))
        .await?;
    if owner.is_none() || crate::checkpoint_cleanup::turn_discarded(&txn, cid, turn_id).await? {
        return Err(DbErr::Custom("turn_discarded".into()));
    }
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO chat_task_input (user_id,conversation_id,task_id,input_id,content,source_role,status,turn_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [uid.into(),cid.into(),task.into(),id.into(),text.into(),role.into(),status.into(),turn_id.into()])).await?;
    let row = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT task_id,turn_id,content,source_role,status,message_id FROM chat_task_input \
         WHERE user_id=$1 AND conversation_id=$2 AND input_id=$3 FOR UPDATE",
            [uid.into(), cid.into(), id.into()],
        ))
        .await?
        .ok_or_else(invalid)?;
    if row.try_get::<String>("", "task_id")? != task
        || row.try_get::<String>("", "content")? != text
        || row.try_get::<String>("", "source_role")? != role
    {
        return Err(invalid());
    }
    if row.try_get::<Option<String>>("", "turn_id")?.as_deref() != Some(turn_id) {
        return Err(invalid());
    }
    let mut message_id: Option<i32> = row.try_get("", "message_id")?;
    let previous: String = row.try_get("", "status")?;
    let status = if previous == "applied" || status == "queued" {
        previous.as_str()
    } else {
        status
    };
    if status == "applied" && message_id.is_none() {
        let message = chat_history::ActiveModel {
            user_id: Set(uid),
            conversation_id: Set(cid),
            role: Set("user".into()),
            source_role: Set(Some(role.into())),
            content: Set(text.into()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        message_id = Some(message.id);
    }
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE chat_task_input SET status=$4,message_id=$5 \
         WHERE user_id=$1 AND conversation_id=$2 AND input_id=$3",
        [
            uid.into(),
            cid.into(),
            id.into(),
            status.into(),
            message_id.into(),
        ],
    ))
    .await?;
    txn.commit().await?;
    Ok(json!({"id":id,"text":text,"status":status,"message_id":message_id,"turn_id":turn_id}))
}

pub(super) async fn persist_event(
    db: &DatabaseConnection,
    uid: i32,
    cid: i32,
    role: &str,
    mut value: Map<String, Value>,
) -> Result<Map<String, Value>, DbErr> {
    let task = value
        .get("task_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    if !identifier(&task) {
        return Err(DbErr::Custom("invalid task identity".into()));
    }
    let items = value
        .get("input")
        .cloned()
        .map(|item| vec![item])
        .or_else(|| value.get("inputs").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();
    let mut saved = Vec::new();
    for item in items {
        saved.push(
            save(
                db,
                uid,
                cid,
                role,
                &task,
                item["turn_id"].as_str().unwrap_or(""),
                &item,
            )
            .await?,
        );
    }
    if value.contains_key("input") {
        value.insert("input".into(), saved.remove(0));
    } else if value.contains_key("inputs") {
        value.insert("inputs".into(), json!(saved));
    }
    Ok(value)
}

pub(super) async fn history_tasks(
    db: &DatabaseConnection,
    uid: i32,
    cid: i32,
    ids: &[i32],
) -> Result<std::collections::HashMap<i32, String>, DbErr> {
    let mut tasks = std::collections::HashMap::new();
    let (Some(first), Some(last)) = (ids.iter().min(), ids.iter().max()) else {
        return Ok(tasks);
    };
    for row in db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT message_id,turn_id FROM chat_task_input WHERE user_id=$1 AND conversation_id=$2 \
         AND turn_id IS NOT NULL AND message_id BETWEEN $3 AND $4",[uid.into(),cid.into(),(*first).into(),(*last).into()])).await? {
        tasks.insert(row.try_get("","message_id")?,row.try_get("","turn_id")?);
    }
    Ok(tasks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::conversation;
    use sea_orm::{ColumnTrait, Database, PaginatorTrait, QueryFilter};
    #[test]
    fn task_identifiers_do_not_accept_paths_or_unbounded_values() {
        for value in ["", "../other", "task/id", "task:1", &"x".repeat(101)] {
            assert!(!identifier(value));
        }
        assert!(identifier("lmvqr9o10-ugeu6"));
    }

    #[tokio::test]
    async fn postgres_replayed_inputs_save_one_user_message_and_delete_with_conversation() {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            eprintln!("未评估：未设置 TEST_PG_URL，CI 提供独立 PostgreSQL 服务");
            return;
        };
        let db = Database::connect(url).await.unwrap();
        let unique = format!(
            "task-input-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        );
        let actor = user::ActiveModel {
            username: Set(unique.clone()),
            nickname: Set(unique),
            password: Set("fixture-only-not-a-login".into()),
            role: Set("user".into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap();
        let conv = conversation::ActiveModel {
            user_id: Set(actor.id),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap();
        let queued = json!({"id":"one","text":"只列标题","status":"queued"});
        let pending = save(
            &db,
            actor.id,
            conv.id,
            "user",
            "task",
            "fixture-turn",
            &queued,
        )
        .await
        .unwrap();
        assert!(pending["message_id"].is_null());
        let mut applied = queued.clone();
        applied["status"] = json!("applied");
        let (left, right) = tokio::join!(
            save(
                &db,
                actor.id,
                conv.id,
                "user",
                "task",
                "fixture-turn",
                &applied
            ),
            save(
                &db,
                actor.id,
                conv.id,
                "user",
                "task",
                "fixture-turn",
                &applied
            )
        );
        let left = left.unwrap();
        let right = right.unwrap();
        assert_eq!(left["message_id"], right["message_id"]);
        let stale = save(
            &db,
            actor.id,
            conv.id,
            "user",
            "task",
            "fixture-turn",
            &queued,
        )
        .await
        .unwrap();
        assert_eq!(stale["status"], "applied");
        assert!(save(
            &db,
            actor.id,
            conv.id,
            "admin",
            "task",
            "fixture-turn",
            &applied
        )
        .await
        .is_err());
        let changed = json!({"id":"one","text":"另一个正文","status":"applied"});
        assert!(save(
            &db,
            actor.id,
            conv.id,
            "user",
            "task",
            "fixture-turn",
            &changed
        )
        .await
        .is_err());
        assert_eq!(
            chat_history::Entity::find()
                .filter(chat_history::Column::ConversationId.eq(conv.id))
                .count(&db)
                .await
                .unwrap(),
            1
        );
        conversation::Entity::delete_by_id(conv.id)
            .exec(&db)
            .await
            .unwrap();
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT count(*)::bigint AS n FROM chat_task_input WHERE conversation_id=$1",
                [conv.id.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<i64>("", "n").unwrap(), 0);
        user::Entity::delete_by_id(actor.id)
            .exec(&db)
            .await
            .unwrap();
    }
}
