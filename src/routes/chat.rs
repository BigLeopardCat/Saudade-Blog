mod task_manager;
pub use task_manager::{list as tasks_handler, cancel as cancel_task_handler, cancel_schedule as cancel_schedule_handler, service_status};
mod weather;
pub use weather::WeatherSnapshot;
mod context;
mod execution_history;
use context::prepare_chat;
use execution_history::*;
mod control;
mod task_inputs;
pub use task_inputs::{submit_handler as task_input_handler, status_handler as task_input_status_handler};
pub use task_inputs::confirmation_handler as task_confirmation_handler;
mod pending;
mod persistence;
use persistence::{save_assistant_reply, save_execution_log, PERSISTENCE_ERROR};
mod protocol;
mod synchronous;
pub use synchronous::chat_handler;
#[cfg(test)]
mod stream_tests;
use protocol::{Frame, event as stream_event};
use eventsource_stream::Eventsource;
use axum::response::sse::{KeepAlive, Sse};
mod approval;
pub use approval::cancel_handler;
use approval::claim_confirm_token;
#[cfg(test)]
use approval::{b64url_decode, token_jti};

use axum::{
    Json,
    body::Bytes,
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::auth_jwt;
use crate::entity::user;
use tracing::{info, warn};

pub use control::BrowserResult;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub task_inputs: bool,
    #[serde(default)]
    pub turn_id: String,
    #[serde(default)]
    pub resume_task: String,
    #[serde(default)]
    pub browser_feedback: bool,
    #[serde(default)]
    pub browser_result: Option<BrowserResult>,
    #[serde(default)]
    pub current_url: Option<String>,
    #[serde(default)]
    pub page_title: Option<String>,
    #[serde(default)]
    pub current_effects: Option<String>,
    #[serde(default)]
    pub current_darkmode: Option<String>,
    #[serde(default, deserialize_with="weather::optional")]
    pub current_weather: Option<WeatherSnapshot>,
    #[serde(default)]
    pub image: Option<Vec<String>>,
    #[serde(default)]
    pub conversation_id: Option<i32>,
    #[serde(default)]
    pub confirm_token: Option<String>,
    #[serde(default)]
    pub confirm_pick: Option<String>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub reply: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, ColumnTrait, QuerySelect};
use sea_orm::sea_query::Expr; // Expr 不在 sea-orm 根（0.12.15 仅 pub use sea_query 全名）
use crate::entity::{chat_history, chat_image, conversation};
use crate::routes::conversation::resolve_conversation_id;
use super::chat_context::{self, BootstrapContext};
use futures::StreamExt;
use async_stream::stream;

/// 对话上下文：由 prepare_chat 组装，/chat 与 /chat/stream 共用
struct ChatCtx {
    uid: i32,
    conversation_id: i32,
    trace_id: String,
    turn_id: String,
    body: serde_json::Value,
    role: Option<String>,
}

/// 链路追踪：X-Request-ID 全链路透传（浏览器 → nginx → Rust → agent → LLM 日志）。
/// 上游给了就用，没给生成一个（r 前缀区分 Rust 生成，agent 端无上游 id 时会再生成）。
fn trace_id_of(req: &Request) -> String {
    req.headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("r{}", uuid::Uuid::new_v4().simple()))
}

/// 历史条目（GET /api/chat/history 返回）：id = DB 主键（前端稳定去重 id）
#[derive(Serialize)]
pub struct HistoryItem {
    pub id: i32,
    pub turn_id: Option<String>,
    pub parent_turn_id: Option<String>,
    pub role: String,
    pub content: String,
    pub time: i64,
    pub images: Vec<String>,
}

const CHAT_HISTORY_IMAGE_BUDGET: usize = 8 * 1024 * 1024;

/// 按预算裁剪图片（纯函数，判据在下面的 `mod tests`）。
/// 输入**从新到旧**的 `(消息 id, 该条图片总字节)`，返回允许带图的 id 集合。
/// 装不下的那条**与比它更早的全部**不给图 —— 给"残缺数组"（本该 3 张只给 1 张）
/// 会让用户以为图丢了，空数组走的是前端既有的"这条没图"路径，是诚实的那一个。
fn fit_image_budget(newest_first: &[(i32, usize)]) -> std::collections::HashSet<i32> {
    let mut out = std::collections::HashSet::new();
    let mut used = 0usize;
    for &(id, n) in newest_first {
        if n == 0 {
            continue; // 这条本来就没图，不占预算也不算"装不下"
        }
        if used + n > CHAT_HISTORY_IMAGE_BUDGET {
            break;
        }
        used += n;
        out.insert(id);
    }
    out
}

/// 先读取 id 与字节数，在预算内才读取 TOAST 大字段。
/// 第二次查询按第一步的图片 id 限定，避免两次查询之间新增图片突破预算。
async fn load_history_images(
    db: &sea_orm::DatabaseConnection,
    recent: &[chat_history::Model],
) -> Result<std::collections::HashMap<i32, Vec<String>>, sea_orm::DbErr> {
    let mut out = std::collections::HashMap::new();
    if recent.is_empty() { return Ok(out); }
    let ids: Vec<i32> = recent.iter().map(|h| h.id).collect();
    let sizes = chat_image::Entity::find()
        .select_only()
        .column(chat_image::Column::Id)
        .column(chat_image::Column::MessageId)
        .column_as(Expr::cust("octet_length(\"data\")"), "bytes")
        .filter(chat_image::Column::MessageId.is_in(ids))
        .into_tuple::<(i32, i32, i32)>()
        .all(db).await?;
    let mut totals = std::collections::HashMap::<i32, usize>::new();
    for (_, mid, bytes) in &sizes {
        *totals.entry(*mid).or_default() += (*bytes).max(0) as usize;
    }
    let budget_in: Vec<(i32, usize)> = recent.iter()
        .map(|h| (h.id, totals.get(&h.id).copied().unwrap_or(0))).collect();
    let allowed = fit_image_budget(&budget_in);
    let image_ids: Vec<i32> = sizes.into_iter()
        .filter(|(_, mid, _)| allowed.contains(mid)).map(|(id, _, _)| id).collect();
    if image_ids.is_empty() { return Ok(out); }
    let rows = chat_image::Entity::find()
        .filter(chat_image::Column::Id.is_in(image_ids))
        .order_by_asc(chat_image::Column::MessageId)
        .order_by_asc(chat_image::Column::Seq)
        .all(db).await?;
    for row in rows {
        out.entry(row.message_id).or_insert_with(Vec::new).push(row.data);
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub conversation_id: Option<i32>,
    #[serde(default)]
    pub before_id: Option<i32>,
}

pub async fn chat_history_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HistoryQuery>,
    headers: HeaderMap,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "items": [], "count": 0, "error": "unauthorized", "message": e.message()
                })),
            )
                .into_response();
        }
    };
    // 会话解析（GET 不自动建会话，保持无副作用）：无会话 → 200 空列表
    let conv_id = match resolve_conversation_id(&state.db, uid, query.conversation_id, false).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            return (StatusCode::OK, Json(serde_json::json!({"items": [], "count": 0}))).into_response();
        }
        Err(()) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"items": [], "count": 0, "error": "conversation_not_found"})),
            )
                .into_response();
        }
    };
    // 会话内最近 50 条（与前端显示上限一致）；会话内 order_by_desc(Id) 单调唯一、
    // 即时间序（单会话串行写入，CreatedAt 排序从此退役），命中 idx_conv_id 索引。
    // before_id 时改为"该 id 之前最近 50 条"（更早窗口翻页，仍升序回传）
    let mut finder = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conv_id));
    if let Some(bid) = query.before_id {
        finder = finder.filter(chat_history::Column::Id.lt(bid));
    }
    let recent = finder
        .order_by_desc(chat_history::Column::Id)
        .limit(50)
        .all(&state.db)
        .await
        .unwrap_or_default();
    let imgs = load_history_images(&state.db, &recent).await;
    let mut imgs_by_msg = match imgs {
        Ok(v) => v,
        Err(e) => {
            warn!(user_id = uid, conversation_id = conv_id,
                "chat: 历史图片查询失败（本轮历史不带图）: {}", e);
            std::collections::HashMap::new()
        }
    };
    let parents=match task_inputs::history_tasks(&state.db,uid,conv_id,
        &recent.iter().map(|row|row.id).collect::<Vec<_>>()).await {
        Ok(value)=>value,
        Err(error)=>{
            warn!(%error,conversation_id=conv_id,"history task identities unavailable");
            return (StatusCode::SERVICE_UNAVAILABLE,Json(serde_json::json!({"error":"history_unavailable"}))).into_response();
        }
    };
    let items: Vec<HistoryItem> = recent
        .iter()
        .rev() // 时间升序（聊天软件阅读序）
        .map(|h| HistoryItem {
            id: h.id,
            turn_id: h.turn_id.clone(),
            parent_turn_id: parents.get(&h.id).cloned(),
            role: h.role.clone(),
            content: h.content.clone(),
            time: h.created_at.and_local_timezone(chrono::Local).single().map(|dt| dt.timestamp_millis()).unwrap_or(0),
            images: imgs_by_msg.remove(&h.id).unwrap_or_default(),
        })
        .collect();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "items": items,
            "count": items.len(),
            "conversation_id": conv_id
        })),
    )
        .into_response()
}

mod discard;
pub use discard::discard_handler;

fn derive_conv_title(content: &str) -> Option<String> {
    let mut lines: Vec<&str> = content.lines().collect();
    while let Some(last) = lines.last() {
        let is_marker = *last == "[图片]"
            || (last.starts_with("[图片×") && last.ends_with(']'));
        if is_marker { lines.pop(); } else { break; }
    }
    let text = lines.join("\n").trim().to_string();
    if text.is_empty() { return None; }
    Some(text.chars().take(40).collect())
}


/// Complete proposal JSON and display text are rejected above these bounds, never truncated.
const PENDING_ARGS_COL_MAX: usize = 32_768;
const PENDING_QUESTION_COL_MAX: usize = 32_768;
/// Legacy choice lists and native confirmation/cancellation buttons share this bound.
const PENDING_OPTIONS_COL_MAX: usize = 600;

/// 取 JSON 字段并限长（缺字段/类型不对一律空串——待办是辅助事实，宁可少说）。
fn json_capped(v: &serde_json::Value, key: &str, cap: usize) -> String {
    v[key].as_str().unwrap_or("").chars().take(cap).collect()
}

fn agent_chat_url() -> String {
    std::env::var("AGENT_URL").unwrap_or_else(|_| "http://127.0.0.1:8010/chat".to_string())
}

/// Preserve business status codes and emit all other early outcomes as named SSE.
fn early_exit_response(status: StatusCode, body: ChatResponse, from: &str) -> Response {
    if status == StatusCode::NOT_FOUND || status == StatusCode::CONFLICT {
        return (status, Json(body)).into_response();
    }
    info!(stage = from, status = %status, "chat: early stream outcome");
    let events = if body.success && !body.reply.is_empty() {
        vec![stream_event("text", body.reply), stream_event("done", serde_json::json!({}))]
    } else {
        let message = body.error.filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "服务暂时不可用，这一轮没有生成回复，请稍后再试。".to_string());
        vec![stream_event("error", message)]
    };
    let stream = futures::stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
    ([(header::HeaderName::from_static("x-accel-buffering"), "no"),
      (header::HeaderName::from_static("x-agent-stream-version"), "2")],
     Sse::new(stream)).into_response()
}

fn agent_sse_response(
    stream: impl futures::Stream<Item = Result<axum::response::sse::Event, axum::Error>>
        + Send
        + 'static,
) -> Response {
    Sse::new(stream)
        .keep_alive(KeepAlive::new().text("ping"))
        .into_response()
}

pub async fn chat_stream_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Response {
    // Reject cached v1 clients before creating messages or consuming confirmation grants.
    if req.headers().get("x-agent-stream-version").and_then(|v| v.to_str().ok()) != Some("2") {
        return (StatusCode::CONFLICT, Json(ChatResponse {
            reply: String::new(), success: false,
            error: Some("聊天版本已更新，请刷新页面后重试。".to_string()),
        })).into_response();
    }
    let expected_version = crate::auth_jwt::claims_from_headers(req.headers()).and_then(|c| c.ver).unwrap_or(-1);
    let ctx = match prepare_chat(&state, req).await {
        Ok(c) => c,
        // 早退一律转成 SSE 帧（见 early_exit_response 的头注）：`e.into_response()`
        // 会把 200 + JSON 原样吐给一个只认 SSE 的客户端
        Err((status, Json(body))) => return early_exit_response(status, body, "prepare_chat"),
    };

    let stream_url = agent_chat_url().strip_suffix("/chat").unwrap_or("").to_string() + "/chat/stream/v2";
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, "chat: 转发 agent 流式");
    // 流式连接不设整体超时（长回答可达数分钟），connect/首字节由 reqwest 默认处理
    let upstream = match reqwest::Client::new()
        .post(&stream_url)
        // 身份断言（同上）：流式这条路同样要带，否则 agent 打开强制校验后它会 401
        .header("X-Agent-Assertion", crate::auth_jwt::create_chat_assertion(&state.db, ctx.uid, ctx.role.as_deref(), expected_version).await)
        .header("X-Request-ID", &ctx.trace_id)
        .json(&ctx.body)
        .send()
        .await {
        Ok(r) => r,
        Err(e) => {
            warn!(trace_id = %ctx.trace_id, error = %e, phase = "agent_connect",
                "Agent connection failed");
            return early_exit_response(
                StatusCode::OK,
                ChatResponse {
                    reply: String::new(),
                    success: false,
                    error: Some("服务暂时无法连接，这一轮没有生成回复，请稍后重试。".into()),
                },
                "agent_connect",
            );
        }
    };
    if !upstream.status().is_success() {
        warn!(trace_id = %ctx.trace_id, status = upstream.status().as_u16(),
            phase = "agent_status", "Agent returned an unsuccessful response");
        return early_exit_response(
            StatusCode::OK,
            ChatResponse {
                reply: String::new(),
                success: false,
                error: Some(format!(
                    "服务这边出了点问题（上游 {}），这一轮没有生成回复，请稍后再说一次。",
                    upstream.status().as_u16()
                )),
            },
            "agent_status",
        );
    }

    let state = state.clone();
    let uid = ctx.uid;
    let conversation_id = ctx.conversation_id;
    // 帧循环里的告警要用（stream! 生成器闭包不能借用 ctx——它后面还要用 ctx 写响应头）
    let trace_id = ctx.trace_id.clone();

    let body_stream = forward_agent_stream(state, uid, conversation_id, ctx.role, ctx.turn_id, trace_id, upstream.bytes_stream());

    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONNECTION, "keep-alive"),
            // 关键：告知 nginx 不要缓冲此响应，否则 SSE 会被攒到结束才一次性下发
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
            // 链路追踪：透传 trace id 给前端（前端可在网络面板按此 id 关联全链路日志）
            (header::HeaderName::from_static("x-request-id"), &ctx.trace_id),
        ],
        agent_sse_response(body_stream),
    ).into_response()
}

fn forward_agent_stream(
    state: Arc<AppState>,
    uid: i32,
    conversation_id: i32,
    source_role: Option<String>,
    turn_id: String,
    trace_id: String,
    upstream_stream: impl futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> impl futures::Stream<Item = Result<axum::response::sse::Event, axum::Error>> + Send {
    stream! {
        let upstream = upstream_stream.eventsource();
        futures::pin_mut!(upstream);
        let mut reply = String::new();
        let mut terminal = false;
        while let Some(incoming) = upstream.next().await {
            let incoming = match incoming {
                Ok(value) => value,
                Err(error) => {
                    crate::observability::agent_stream_failed(
                        &trace_id, uid, conversation_id, &error);
                    break;
                },
            };
            let frame = match protocol::decode(&incoming) {
                Ok(frame) => frame,
                Err(_) => {
                    warn!(trace_id = %trace_id, user_id = uid, "chat: invalid upstream SSE event");
                    break;
                }
            };
            match frame {
                Frame::Done(_) => {
                    terminal = true;
                    if uid > 0 && !reply.is_empty() {
                        let state = state.clone();
                        if persistence::run(&trace_id, async move {
                            save_assistant_reply(&state.db, uid, conversation_id, source_role, &turn_id, reply).await
                        }).await.is_err() {
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                    break;
                }
                Frame::Error(_) => {
                    terminal = true;
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                    break;
                }
                Frame::Receipts(rows) => {
                    if uid > 0 && !rows.is_empty() {
                        let state = state.clone();
                        if persistence::run(&trace_id, async move {
                            save_execution_log(&state.db, uid, conversation_id, &rows).await
                        }).await.is_err() {
                            terminal = true;
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                }
                Frame::Pending(value) => {
                    if uid > 0 {
                        let state = state.clone();
                        let turn_id=turn_id.clone();
                        if persistence::run(&trace_id, async move {
                            if pending::save_pending_action(&state.db, uid, conversation_id, &turn_id, &value.into()).await {
                                Ok(())
                            } else {
                                Err(sea_orm::DbErr::Custom("pending state was not saved".into()))
                            }
                        }).await.is_err() {
                            terminal = true;
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                }
                Frame::Text(text) => {
                    reply.push_str(&text);
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                }
                Frame::TextReset(_) => {
                    // Retract this turn's provisional prose, never execution facts or cards.
                    reply.clear();
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                }
                Frame::TaskInput(value) => {
                    match task_inputs::persist_event(&state.db, uid, conversation_id,
                        source_role.as_deref().unwrap_or(""), value).await {
                        Ok(value) => yield Ok(stream_event("task_input", value)),
                        Err(error) => {
                            warn!(%error, "task input stream persistence failed");
                            terminal = true;
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                }
                Frame::Progress(_) | Frame::Confirmation(_) | Frame::Command(_) => {
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                }
            }
        }
        if !terminal {
            warn!(trace_id = %trace_id, user_id = uid, conversation_id,
                phase = "upstream_eof", "Agent SSE ended without a terminal event");
            yield Ok::<_, axum::Error>(stream_event("error", "与 Agent 的连接中断，回复可能不完整"));
        }
    }
}

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests;
