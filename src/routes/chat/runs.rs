//! Browser requests submit/subscribe; DBOS owns execution of the existing chat pipeline.
use super::{input, run_ticket, transport, ChatRequest};
use crate::{auth_jwt, entity::user, routes::AppState};
use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{ConnectionTrait, DbBackend, EntityTrait, Statement};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

fn failure(status: StatusCode, error: &str) -> Response {
    (
        status,
        [("Cache-Control", "no-store")],
        Json(json!({"error": error})),
    )
        .into_response()
}

async fn session(state: &AppState, headers: &HeaderMap) -> Result<user::Model, Response> {
    let uid = auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| failure(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    user::Entity::find_by_id(uid)
        .one(&state.db)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "unauthorized"))
}

fn endpoint(path: &str) -> String {
    format!(
        "{}/chat/runs{}",
        super::agent_chat_url().trim_end_matches("/chat"),
        path
    )
}

async fn relay(request: reqwest::RequestBuilder, streaming: bool) -> Response {
    let upstream = match transport::send(request).await {
        Ok(value) => value,
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "background_chat_unavailable",
            )
        }
    };
    let status = upstream.status();
    let content_type = if streaming && status.is_success() {
        "text/event-stream"
    } else {
        "application/json"
    };
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap()
}

#[derive(Deserialize)]
pub struct Submission {
    run_id: String,
    request: Value,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(submission): Json<Submission>,
) -> Response {
    let actor = match session(&state, &headers).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    let payload: ChatRequest = match serde_json::from_value(submission.request.clone()) {
        Ok(p) => p,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "invalid_chat_request"),
    };
    if !run_ticket::valid_id(&submission.run_id)
        || input::validate(&payload).is_err()
        || !super::control::valid(&payload)
    {
        return failure(StatusCode::BAD_REQUEST, "invalid_chat_request");
    }
    let Some(cid) = payload.conversation_id.filter(|c| *c > 0) else {
        return failure(StatusCode::BAD_REQUEST, "conversation_required");
    };
    if !matches!(crate::routes::conversation::resolve_conversation_id(
        &state.db, actor.id, Some(cid), false).await, Ok(Some(id)) if id == cid)
    {
        return failure(StatusCode::NOT_FOUND, "conversation_not_found");
    }
    let body = match serde_json::to_string(&submission.request) {
        Ok(body) if body.len() <= 8 * 1024 * 1024 => body,
        _ => return failure(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
    };
    let Some(ticket) = run_ticket::issue(
        actor.id,
        actor.token_version,
        actor.role.clone(),
        cid,
        submission.run_id.clone(),
        body.as_bytes(),
    ) else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "background_chat_unavailable",
        );
    };
    relay(
        transport::client()
            .post(endpoint(""))
            .header(
                "X-Agent-Assertion",
                auth_jwt::create_agent_assertion(actor.id, Some(&actor.role)),
            )
            .json(&json!({"run_id":submission.run_id,"conversation_id":cid,
                      "body":body,"ticket":ticket})),
        false,
    )
    .await
}

#[derive(Deserialize)]
pub struct ListQuery {
    conversation_id: Option<i32>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let actor = match session(&state, &headers).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    let path = query
        .conversation_id
        .map(|cid| format!("?conversation_id={cid}"))
        .unwrap_or_default();
    let request = transport::client().get(endpoint(&path)).header(
        "X-Agent-Assertion",
        auth_jwt::create_agent_assertion(actor.id, Some(&actor.role)),
    );
    relay(request, false).await
}

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    offset: u64,
}

pub async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Response {
    let actor = match session(&state, &headers).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    if !run_ticket::valid_id(&run_id) {
        return failure(StatusCode::NOT_FOUND, "run_not_found");
    }
    relay(
        transport::client()
            .get(endpoint(&format!(
                "/{run_id}/events?offset={}",
                query.offset
            )))
            .header(
                "X-Agent-Assertion",
                auth_jwt::create_agent_assertion(actor.id, Some(&actor.role)),
            ),
        true,
    )
    .await
}

pub async fn cancel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> Response {
    let actor = match session(&state, &headers).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    if !run_ticket::valid_id(&run_id) {
        return failure(StatusCode::NOT_FOUND, "run_not_found");
    }
    relay(
        transport::client()
            .post(endpoint(&format!("/{run_id}/cancel")))
            .header(
                "X-Agent-Assertion",
                auth_jwt::create_agent_assertion(actor.id, Some(&actor.role)),
            ),
        false,
    )
    .await
}

async fn claim<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    run_id: &str,
    cid: i32,
) -> Result<sea_orm::ExecResult, sea_orm::DbErr> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "WITH expired AS (DELETE FROM chat_run_claim WHERE user_id=$1 \
         AND created_at < now() - interval '1 day') \
         INSERT INTO chat_run_claim (user_id,run_id,conversation_id) \
         SELECT $1,$2,id FROM conversation WHERE id=$3 AND user_id=$1 \
         ON CONFLICT (user_id,run_id) DO NOTHING",
        [uid.into(), run_id.to_owned().into(), cid.into()],
    ))
    .await
}

pub async fn execute(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let ticket = req
        .headers()
        .get("X-Chat-Run-Ticket")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = match axum::body::to_bytes(req.into_body(), 8 * 1024 * 1024).await {
        Ok(body) => body,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "invalid_body"),
    };
    let Some(grant) = run_ticket::verify(&ticket, &body) else {
        return failure(StatusCode::UNAUTHORIZED, "invalid_run_ticket");
    };
    let actor = user::Entity::find_by_id(grant.uid)
        .one(&state.db)
        .await
        .ok()
        .flatten();
    if !actor.is_some_and(|a| {
        !crate::authz::is_frozen(a.status)
            && a.token_version == grant.version
            && a.role == grant.role
    }) {
        return failure(StatusCode::UNAUTHORIZED, "run_authorization_expired");
    }
    let payload: ChatRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "invalid_chat_request"),
    };
    if payload.conversation_id != Some(grant.conversation_id) {
        return failure(StatusCode::UNAUTHORIZED, "run_scope_mismatch");
    }
    // Claim before any quota/message/approval mutation. A lost response never permits replay.
    let claimed = claim(&state.db, grant.uid, &grant.run_id, grant.conversation_id).await;
    match claimed {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return failure(StatusCode::CONFLICT, "run_already_claimed_or_removed"),
        Err(_) => return failure(StatusCode::SERVICE_UNAVAILABLE, "run_claim_unavailable"),
    }
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/chat/stream")
        .header("X-Agent-Stream-Version", "2")
        .header("X-Request-ID", format!("bg{}", grant.run_id))
        .body(Body::from(body))
        .unwrap();
    request.extensions_mut().insert(grant);
    super::chat_stream_handler(State(state), request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, TransactionTrait};

    fn state(db: sea_orm::DatabaseConnection) -> Arc<AppState> {
        Arc::new(AppState {
            db,
            rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 300, 900),
            post_limiter: crate::risk::PostRateLimiter::new(),
            report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
        })
    }

    #[tokio::test]
    async fn execution_rejects_invalid_ticket_before_database_access() {
        let state = state(sea_orm::MockDatabase::new(DbBackend::Postgres).into_connection());
        let request = Request::builder()
            .header("X-Chat-Run-Ticket", "invalid")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            execute(State(state.clone()), request).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let db = Arc::try_unwrap(state).ok().unwrap().db;
        assert!(db.into_transaction_log().is_empty());
    }

    #[tokio::test]
    async fn queued_execution_rechecks_revocation_role_freeze_and_deleted_actor() {
        if std::env::var("BLOG_DELEGATION_SECRET").is_err() {
            return;
        }
        let body = r#"{"conversation_id":42,"message":"hello"}"#;
        let ticket =
            run_ticket::issue(7, 3, "user".into(), 42, "a".repeat(32), body.as_bytes()).unwrap();
        for (status, version, role, exists) in [
            (1, 3, "user", true),
            (0, 4, "user", true),
            (0, 3, "admin", true),
            (0, 3, "user", false),
        ] {
            let actor = user::Model {
                id: 7,
                username: "fixture".into(),
                nickname: "fixture".into(),
                nickname_auto_renamed: 0,
                avatar: None,
                password: "fixture".into(),
                role: role.into(),
                status,
                token_version: version,
                chat_quota_used: 0,
                muted_until: None,
            };
            let state = state(
                sea_orm::MockDatabase::new(DbBackend::Postgres)
                    .append_query_results([if exists { vec![actor] } else { vec![] }])
                    .into_connection(),
            );
            let request = Request::builder()
                .header("X-Chat-Run-Ticket", &ticket)
                .body(Body::from(body))
                .unwrap();
            assert_eq!(
                execute(State(state.clone()), request).await.status(),
                StatusCode::UNAUTHORIZED
            );
            let db = Arc::try_unwrap(state).ok().unwrap().db;
            assert_eq!(
                db.into_transaction_log().len(),
                1,
                "no claim or business mutations"
            );
        }
    }

    #[tokio::test]
    async fn postgres_request_claim_rejects_replay_and_other_owners() {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            return;
        };
        let db = Database::connect(url).await.unwrap();
        let transaction = db.begin().await.unwrap();
        let run_id = uuid::Uuid::new_v4().simple().to_string();
        let row = transaction.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO \"user\"(username,nickname,password,role) VALUES($1,$1,'fixture','user') RETURNING id",
            [format!("run-{run_id}").into()])).await.unwrap().unwrap();
        let uid: i32 = row.try_get("", "id").unwrap();
        let row = transaction.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO conversation(user_id,title) VALUES($1,'background claim probe') RETURNING id",
            [uid.into()])).await.unwrap().unwrap();
        let cid: i32 = row.try_get("", "id").unwrap();
        assert_eq!(
            claim(&transaction, uid, &run_id, cid)
                .await
                .unwrap()
                .rows_affected(),
            1
        );
        assert_eq!(
            claim(&transaction, uid, &run_id, cid)
                .await
                .unwrap()
                .rows_affected(),
            0
        );
        assert_eq!(
            claim(&transaction, 0, &run_id, cid)
                .await
                .unwrap()
                .rows_affected(),
            0
        );
        transaction.rollback().await.unwrap();
    }
}
