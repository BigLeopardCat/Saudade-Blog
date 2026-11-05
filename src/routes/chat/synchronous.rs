//! Aggregate chat responses keep typed controls separate from display text.

use super::*;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct AgentResponse {
    reply: String,
    success: bool,
    error: Option<String>,
    events: Vec<ControlEvent>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ControlEvent {
    name: String,
    data: Value,
}

impl ControlEvent {
    fn frame(&self) -> Result<Frame, serde_json::Error> {
        serde_json::from_value(json!({"event": self.name, "data": self.data}))
    }
}

impl AgentResponse {
    fn parse(value: Value) -> Result<Self, String> {
        let response: Self =
            serde_json::from_value(value).map_err(|_| "invalid_agent_response".to_owned())?;
        if !response.success {
            return Err(response
                .error
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "agent_request_failed".into()));
        }
        if response.events.len() > 64 {
            return Err("too_many_agent_events".into());
        }
        let mut visible = !response.reply.trim().is_empty();
        for event in &response.events {
            match event.frame().map_err(|_| "invalid_agent_event")? {
                Frame::Command(_) | Frame::Confirmation(_) => visible = true,
                Frame::Pending(_)
                | Frame::Receipts(_)
                | Frame::TaskInput(_)
                | Frame::Progress(_) => {}
                _ => return Err("invalid_aggregate_event".into()),
            }
        }
        if !visible {
            return Err("empty_agent_response".into());
        }
        Ok(response)
    }
}

pub async fn chat_handler(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let expected_version = crate::auth_jwt::claims_from_headers(req.headers())
        .and_then(|c| c.ver)
        .unwrap_or(-1);
    let ctx = match prepare_chat(&state, req).await {
        Ok(ctx) => ctx,
        Err(error) => return error.into_response(),
    };
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, "chat: forwarding aggregate turn");
    let result = async {
        // A lost response cannot prove whether the Agent executed; never replay the turn here.
        let upstream = reqwest::Client::new()
            .post(agent_chat_url())
            .header(
                "X-Agent-Assertion",
                crate::auth_jwt::create_chat_assertion(
                    &state.db,
                    ctx.uid,
                    ctx.role.as_deref(),
                    expected_version,
                )
                .await,
            )
            .header("X-Request-ID", &ctx.trace_id)
            .json(&ctx.body)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|_| "agent_transport_failed".to_owned())?;
        if !upstream.status().is_success() {
            return Err(format!("agent_http_{}", upstream.status().as_u16()));
        }
        let value = upstream
            .json::<Value>()
            .await
            .map_err(|_| "invalid_agent_response".to_owned())?;
        let mut response = AgentResponse::parse(value)?;
        let write_state = state.clone();
        let (uid, cid) = (ctx.uid, ctx.conversation_id);
        let role = ctx.role;
        let events = std::mem::take(&mut response.events);
        let reply = response.reply.clone();
        // The existing tracked persistence survives a disconnected HTTP waiter.
        let public = persistence::run(&ctx.trace_id, async move {
            persist(&write_state.db, uid, cid, role, &reply, events).await
        })
        .await
        .map_err(|_| PERSISTENCE_ERROR.to_owned())?;
        Ok(json!({"reply": response.reply, "success": true, "error": null, "events": public}))
    }
    .await;
    match result {
        Ok(body) => Json(body).into_response(),
        Err(error) => {
            warn!(trace_id = %ctx.trace_id, %error, "aggregate Agent turn failed");
            Json(ChatResponse {
                reply: String::new(),
                success: false,
                error: Some(error),
            })
            .into_response()
        }
    }
}

async fn persist(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    cid: i32,
    role: Option<String>,
    reply: &str,
    events: Vec<ControlEvent>,
) -> Result<Vec<ControlEvent>, sea_orm::DbErr> {
    let mut public = Vec::new();
    for mut event in events {
        let frame = event
            .frame()
            .map_err(|_| sea_orm::DbErr::Custom("invalid event".into()))?;
        match frame {
            Frame::Receipts(rows) => {
                if uid > 0 {
                    save_execution_log(db, uid, cid, &rows).await?;
                }
                continue;
            }
            Frame::Pending(value) => {
                if uid > 0 && !pending::save_pending_action(db, uid, cid, &value.into()).await {
                    return Err(sea_orm::DbErr::Custom("pending state was not saved".into()));
                }
                continue;
            }
            Frame::TaskInput(value) => {
                event.data =
                    task_inputs::persist_event(db, uid, cid, role.as_deref().unwrap_or(""), value)
                        .await?
                        .into();
            }
            _ => {}
        }
        public.push(event);
    }
    if uid > 0 && !reply.is_empty() {
        save_assistant_reply(db, uid, cid, role, reply.to_owned()).await?;
    }
    Ok(public)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_contract_rejects_failure_missing_fields_and_stream_only_events() {
        for body in [
            json!({"reply":"x"}),
            json!({"reply":"x", "success":false, "error":"failed", "events":[]}),
            json!({"reply":"", "success":true, "events":[]}),
            json!({"reply":"x", "success":true, "events":[{"name":"command", "data":"x"}]}),
            json!({"reply":"x", "success":true, "events":[{"name":"text", "data":"y"}]}),
            json!({"reply":"x", "success":true, "events":[{"name":"done", "data":{}}]}),
            json!({"reply":"x", "success":true, "events":[{"name":"future", "data":{}}]}),
        ] {
            assert!(AgentResponse::parse(body).is_err());
        }
    }

    #[tokio::test]
    async fn controls_keep_order_literal_prose_never_becomes_an_action() {
        let body = json!({"reply":"AUTO_NAVIGATE:/quoted", "success":true, "events":[
            {"name":"command", "data":{"kind":"navigate", "url":"/article/1"}},
            {"name":"command", "data":{"kind":"appearance", "settings":{"rain":"off"}}},
            {"name":"confirmation", "data":{"q":"确认？"}},
            {"name":"receipts", "data":[]}
        ]});
        let response = AgentResponse::parse(body).unwrap();
        let db = sea_orm::MockDatabase::new(sea_orm::DatabaseBackend::Postgres).into_connection();
        let public = persist(&db, 0, 0, None, &response.reply, response.events)
            .await
            .unwrap();
        assert_eq!(response.reply, "AUTO_NAVIGATE:/quoted");
        assert_eq!(public.len(), 3);
        assert_eq!(public[0].data["url"], "/article/1");
        assert_eq!(public[1].data["settings"]["rain"], "off");
        assert_eq!(public[2].name, "confirmation");
        assert!(db.into_transaction_log().is_empty());
        assert!(AgentResponse::parse(json!({"reply":"", "success":true,
            "events":[{"name":"command", "data":{"kind":"navigate", "url":"/"}}]}))
        .is_ok());
    }
}
