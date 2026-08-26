use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::auth_jwt;
use tracing::info;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub current_url: Option<String>,
    #[serde(default)]
    pub page_title: Option<String>,
    #[serde(default)]
    pub current_effects: Option<String>,
    #[serde(default)]
    pub current_darkmode: Option<String>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub reply: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, ColumnTrait, QuerySelect, ActiveModelTrait, PaginatorTrait};
use crate::entity::{chat_history, chat_summary};
use futures::StreamExt;
use async_stream::stream;

/// 对话上下文：由 prepare_chat 组装，/chat 与 /chat/stream 共用
struct ChatCtx {
    uid: i32,
    total_count: i64,
    trace_id: String,
    body: serde_json::Value,
    /// 本轮 user 消息入库后的 DB 主键（None = 入库失败）。
    /// 中断清理（DiscardAbortedExchange）按此快照只删其后残缺回复，保留用户消息本身
    user_msg_id: Option<i32>,
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

/// 从 Authorization: Bearer 头提取用户 id（与 prepare_chat 内联逻辑同源，
/// 20260828 重构：聊天框前端改从 DB 拉权威历史，历史接口复用此鉴权）
fn auth_uid(headers: &HeaderMap) -> Option<i32> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| auth_jwt::verify_token(token))
        .map(|claims| claims.sub)
}

/// 历史条目（GET /api/chat/history 返回）：id = DB 主键（前端稳定去重 id）
#[derive(Serialize)]
pub struct HistoryItem {
    pub id: i32,
    pub role: String,
    pub content: String,
    pub time: i64,
}

/// 前端对话历史的权威数据源（20260828 重构：localStorage 降级为离线缓存）。
/// 无/无效 token → 401（前端统一 fallback 本地 guest 历史；合规长文只属于
/// "使用 AI 服务"，历史读取有本地兜底）；DB 查询失败 → 500（日志可定位）。
pub async fn chat_history_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(uid) = auth_uid(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"items": [], "count": 0, "error": "unauthorized"})),
        )
            .into_response();
    };
    // 最近 50 条（与前端显示上限一致）；order_by_desc(Id) 单调唯一，命中 idx_user 索引
    let recent = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .order_by_desc(chat_history::Column::Id)
        .limit(50)
        .all(&state.db)
        .await
        .unwrap_or_default();
    let items: Vec<HistoryItem> = recent
        .iter()
        .rev() // 时间升序（聊天软件阅读序）
        .map(|h| HistoryItem {
            id: h.id,
            role: h.role.clone(),
            content: h.content.clone(),
            time: h.created_at.and_utc().timestamp_millis(),
        })
        .collect();
    (
        StatusCode::OK,
        Json(serde_json::json!({"items": items, "count": items.len()})),
    )
        .into_response()
}

/// 丢弃本轮（POST /api/chat/discard，20260828b 新增）：用户点击"停止生成"时前端显式调用，
/// 删除该用户最后一条 user 消息及后续残缺回复（全删语义）——主动停止 = 用户明确
/// 不想要这条进记忆，与连接中断清理（DiscardAbortedExchange 只删残缺、保留 user）互补。
/// 无/无效 token → 401。幂等：无 user 消息时无操作返回 success。
pub async fn discard_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(uid) = auth_uid(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"success": false, "error": "unauthorized"})),
        )
            .into_response();
    };
    let last_user = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::Role.eq("user"))
        .order_by_desc(chat_history::Column::Id)
        .one(&state.db)
        .await;
    let Ok(Some(u)) = last_user else {
        return (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response();
    };
    let _ = chat_history::Entity::delete_many()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::Id.gte(u.id))
        .exec(&state.db)
        .await;
    (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response()
}

/// 鉴权 + 请求体解析 + 保存用户消息 + 加载历史/摘要 + 组装 agent 请求体
async fn prepare_chat(state: &Arc<AppState>, req: Request) -> Result<ChatCtx, Json<ChatResponse>> {
    // 先取链路追踪 id（headers 在 into_body 前可读）
    let trace_id = trace_id_of(&req);
    // 从 Authorization header 提取 token
    let user_id = req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| auth_jwt::verify_token(token))
        .map(|claims| claims.sub);

    // 解析请求体
    let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return Err(Json(ChatResponse { reply: String::new(), success: false, error: Some("请求体过大".into()) })),
    };
    let payload: ChatRequest = match serde_json::from_slice(&body_bytes) {
        Ok(p) => p,
        Err(e) => return Err(Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("JSON解析失败: {}", e)) })),
    };

    let uid = match user_id {
        Some(id) => id,
        None => return Err(Json(ChatResponse {
            reply: "尊敬的访客：\n\n本站部署的AI虚拟形象Agent（导航/解读助手）仅供技术学习交流与功能展示使用，不视为面向公众开放的经营性AI服务。\n\n为严格遵守《生成式人工智能服务管理暂行办法》等相关法律法规，履行合规义务，本项目已采取访问限制措施，当前未向不特定公众开放。\n\n如您确因学习、交流或前端技术测试需要体验该功能，请通过博客顶部或关于页面的联系方式，联系管理员申请临时体验账号。管理员将在确认您的需求后，为您开通限时访问权限。\n\n感谢您的理解与支持！\n我们始终坚持合规先导，也期待与各位爱好者共同交流学习。\n\nSaudade Blog\n2026年7月29日".into(),
            success: true,
            error: None,
        })),
    };

    // 保存用户消息（取回主键供中断清理快照：只删其后的残缺回复，用户消息本体保留）
    let user_msg_id = chat_history::ActiveModel {
        user_id: Set(uid),
        role: Set("user".into()),
        content: Set(payload.message.clone()),
        ..Default::default()
    }.insert(&state.db).await.ok().map(|m| m.id);

    // 读取最近历史
    let history_items: Vec<serde_json::Value> = {
        let recent = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .order_by_desc(chat_history::Column::CreatedAt)
            .limit(Some(20))
            .all(&state.db)
            .await.unwrap_or_default();
        recent.iter().rev().map(|h| serde_json::json!({"role": h.role, "content": h.content})).collect()
    };

    // 加载压缩摘要
    let summary_text = chat_summary::Entity::find()
        .filter(chat_summary::Column::UserId.eq(uid))
        .one(&state.db)
        .await.unwrap_or_default()
        .map(|s| s.summary)
        .unwrap_or_default();

    // 统计总消息数，决定是否触发压缩
    let total_count: i64 = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .count(&state.db)
        .await.unwrap_or(0) as i64;
    let needs_summary = total_count > 20 && (total_count % 10 == 0 || total_count % 10 == 1);

    // 保留策略：单用户历史最多保留 CHAT_HISTORY_LIMIT（默认 500）条，
    // 超出时删除最旧的多余记录，控制表增长与磁盘/备份/隐私面。
    // 提示词窗口只看最近 20 条，清理不影响对话连续性。
    let history_limit: i64 = std::env::var("CHAT_HISTORY_LIMIT")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    let excess = total_count - history_limit;
    if excess > 0 {
        let oldest = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .order_by_asc(chat_history::Column::Id)
            .limit(excess as u64)
            .all(&state.db)
            .await.unwrap_or_default();
        if let Some(max_id) = oldest.last().map(|r| r.id) {
            let _ = chat_history::Entity::delete_many()
                .filter(chat_history::Column::UserId.eq(uid))
                .filter(chat_history::Column::Id.lte(max_id))
                .exec(&state.db)
                .await;
        }
    }

    let body = serde_json::json!({
        "message": payload.message,
        "current_url": payload.current_url.as_deref().unwrap_or(""),
        "page_title": payload.page_title.as_deref().unwrap_or(""),
        "current_effects": payload.current_effects.as_deref().unwrap_or(""),
        "current_darkmode": payload.current_darkmode.as_deref().unwrap_or(""),
        "user_id": uid,
        "history": history_items,
        "summary": summary_text,
        "needs_summary": needs_summary,
    });

    if std::env::var("CHAT_DEBUG_BODY").is_ok() {
        eprintln!("[chat-debug] body={}", body);
    }
    Ok(ChatCtx { uid, total_count, trace_id, body, user_msg_id })
}


/// 对话结束后保存 assistant 消息 + 摘要（/chat 与 /chat/stream 共用）。
/// 摘要由 agent 侧独立生成（needs_summary 轮的后端总结调用，与回复解耦），
/// 经 new_summary（非流式响应字段 / 流式 __SUMMARY__ 帧）传入；
/// None 表示本轮无摘要，不写入 chat_summary（旧摘要保留）。
async fn save_assistant_reply(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    reply: String,
    new_summary: Option<String>,
    total_count: i64,
) {
    let _ = chat_history::ActiveModel {
        user_id: Set(uid),
        role: Set("assistant".into()),
        content: Set(reply.clone()),
        ..Default::default()
    }.save(db).await;

    if let Some(new_summary) = new_summary {
        if !new_summary.is_empty() {
            let existing = chat_summary::Entity::find()
                .filter(chat_summary::Column::UserId.eq(uid))
                .one(db)
                .await.unwrap_or_default();
            if let Some(rec) = existing {
                let mut am: chat_summary::ActiveModel = rec.into();
                am.summary = Set(new_summary);
                am.message_count = Set(total_count as i32);
                let _ = am.update(db).await;
            } else {
                let _ = chat_summary::ActiveModel {
                    user_id: Set(uid),
                    summary: Set(new_summary),
                    message_count: Set(total_count as i32),
                    ..Default::default()
                }.save(db).await;
            }
        }
    }
}

fn agent_chat_url() -> String {
    std::env::var("AGENT_URL").unwrap_or_else(|_| "http://127.0.0.1:8010/chat".to_string())
}

pub async fn chat_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Json<ChatResponse> {
    let ctx = match prepare_chat(&state, req).await {
        Ok(c) => c,
        Err(e) => return e,
    };

    let agent_url = agent_chat_url();
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, total_count = ctx.total_count, "chat: 转发 agent 非流式");
    // 传输层偶发失败（agent worker 重启、瞬时断连等）自动重试最多 3 次，
    // 避免对话偶发 "connection closed before message completed" 报错。
    // 超时不重试：长回答（公式推导等）单次生成可长达 180s，超时重试只会从头再生成一遍
    let mut resp_opt: Option<reqwest::Response> = None;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match reqwest::Client::new().post(&agent_url)
            .header("X-Request-ID", &ctx.trace_id)
            .json(&ctx.body)
            .timeout(std::time::Duration::from_secs(180))
            .send()
            .await {
            Ok(r) => { resp_opt = Some(r); break; }
            Err(e) => {
                last_err = e.to_string();
                if e.is_timeout() { break; } // 超时说明生成确实很慢，重试无意义
                if attempt < 2 {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                }
            }
        }
    }

    match resp_opt {
        Some(r) => {
            if r.status().is_success() {
                let data: serde_json::Value = r.json().await.unwrap_or_default();
                let reply = data["reply"].as_str().unwrap_or("").to_string();
                // 非流式：agent 独立生成摘要并返回 new_summary（needs_summary 轮才有值）
                let agent_summary = data["new_summary"].as_str().map(|s| s.to_string());
                if ctx.uid > 0 {
                    save_assistant_reply(&state.db, ctx.uid, reply.clone(), agent_summary, ctx.total_count).await;
                }
                Json(ChatResponse { reply, success: true, error: None })
            } else {
                Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent error: {}", r.status())) })
            }
        }
        None => {
            Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent unavailable: {}", last_err)) })
        }
    }
}

/// 在帧缓冲中查找 SSE 帧结束位置（\n\n 之后），返回消费长度
fn find_frame_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n").map(|i| i + 2)
}

/// 流式对话中断清理（20260828b 语义修正）：客户端中途断开（页面转跳/关闭标签页/网络中断）时，
/// 删除本轮 user 消息之后的残缺 assistant 回复，**保留 user 消息本身**——
/// 用户"发完消息不等回复就转跳"是最常见使用模式，转跳导致连接中断后，
/// 新页面应从 DB 权威历史看到"消息已发出"（聊天软件形态）；只有残缺回复不入记忆
/// （history 上下文 / 摘要），避免半截命令/问答污染后续对话。
///
/// 与主动停止的区别：用户点击"停止生成"是明确不想要这条，前端会显式调用
/// POST /api/chat/discard 全删（user + 残缺）；这里的连接中断无法区分"跳走"与
/// "删除意图"，一律保守保留 user。
///
/// Drop 在 SSE 生成器（body_stream）被取消时同步执行；DB 删除是异步操作，用 tokio::spawn 异步完成。
/// 仅当流未正常收尾（未收到终止标记即被取消）时才清理；正常结束由 done 标记关闭清理，
/// 保留既有行为（含上游异常时保存残缺回复的逻辑，见 chat_stream_handler 尾部）。
struct DiscardAbortedExchange {
    state: Arc<AppState>,
    uid: i32,
    /// 本轮 user 消息的 DB 主键快照（prepare_chat 入库时取得）。
    /// 只删 id 大于快照的 assistant 记录——即使清理延迟执行（期间新轮 user 已插入），
    /// role=user 的新记录也不会被误删。
    user_msg_id: Option<i32>,
    done: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for DiscardAbortedExchange {
    fn drop(&mut self) {
        if self.done.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(user_msg_id) = self.user_msg_id else { return };
        let state = self.state.clone();
        let uid = self.uid;
        // 只删本轮 user 消息之后的残缺 assistant 回复（id 单调递增 + role 双重限定）。
        // 若 drop 延迟到新轮已插入：新轮 user（role=user）不受影响；新轮尚未收尾，
        // 其 assistant 记录不可能先于旧轮清理存在，不会误删
        tokio::spawn(async move {
            let _ = chat_history::Entity::delete_many()
                .filter(chat_history::Column::UserId.eq(uid))
                .filter(chat_history::Column::Id.gt(user_msg_id))
                .filter(chat_history::Column::Role.eq("assistant"))
                .exec(&state.db)
                .await;
        });
    }
}

/// SSE 流式对话：转发 agent /chat/stream，边转发边累积文本，
/// 流结束后保存历史与摘要（agent 端 payload 为 JSON 编码，避免 \n\n 破坏帧边界）
pub async fn chat_stream_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Response {
    let ctx = match prepare_chat(&state, req).await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };

    let stream_url = agent_chat_url().strip_suffix("/chat").unwrap_or("").to_string() + "/chat/stream";
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, total_count = ctx.total_count, "chat: 转发 agent 流式");
    // 流式连接不设整体超时（长回答可达数分钟），connect/首字节由 reqwest 默认处理
    let upstream = match reqwest::Client::new()
        .post(&stream_url)
        .header("X-Request-ID", &ctx.trace_id)
        .json(&ctx.body)
        .send()
        .await {
        Ok(r) => r,
        Err(e) => {
            return Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent unavailable: {}", e)) }).into_response();
        }
    };
    if !upstream.status().is_success() {
        return Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent error: {}", upstream.status())) }).into_response();
    }

    let state = state.clone();
    let uid = ctx.uid;
    let total_count = ctx.total_count;
    let user_msg_id = ctx.user_msg_id;

    let body_stream = stream! {
        let mut upstream_stream = upstream.bytes_stream();
        let mut frame_buf: Vec<u8> = Vec::new();
        let mut reply = String::new();
        let mut terminal = false;
        // 独立摘要（agent 侧 needs_summary 轮后端总结的返回值，随 __SUMMARY__ 帧到达）
        let mut summary_override: Option<String> = None;

        // 客户端中断清理（见 DiscardAbortedExchange）：流被取消时删除本轮 user 消息
        // 之后的残缺回复（user 消息本体保留）；正常走完 while 循环后置位 done，关闭清理
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _guard = DiscardAbortedExchange { state: state.clone(), uid, user_msg_id, done: done.clone() };

        while let Some(chunk) = upstream_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(_) => break, // 上游中断：以已累积文本收尾
            };
            frame_buf.extend_from_slice(&chunk);
            loop {
                let Some(end) = find_frame_end(&frame_buf) else { break };
                // drain 到分隔符之后，再把帧尾的 \n\n 去掉，避免转发时出现双分隔符
                let mut frame: Vec<u8> = frame_buf.drain(..end).collect();
                frame.truncate(frame.len().saturating_sub(2));
                let payload = frame.strip_prefix(b"data: ")
                    .map(|p| String::from_utf8_lossy(p).to_string())
                    .unwrap_or_default();
                if payload.is_empty() { continue; }
                // 终端/错误标记：原样转发给前端
                if payload.starts_with("__END__") || payload.starts_with("__NAV_END__") {
                    terminal = true;
                    yield Ok::<_, axum::Error>(Bytes::from(format!("data: {}\n\n", payload)));
                    break;
                } else if payload.starts_with("__ERROR__:") {
                    terminal = true;
                    yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                    break;
                }
                // 独立摘要结果帧：不终止流、不进回复（agent 在 __END__ 之前发出），
                // 内容记入内存供流结束后写入 chat_summary
                if let Some(s) = payload.strip_prefix("__SUMMARY__:") {
                    if let Ok(s) = serde_json::from_str::<String>(s) {
                        summary_override = Some(s);
                    }
                    continue;
                }
                // 文本块：JSON 编码，解码后累积（用于历史保存），原样转发
                if let Ok(text) = serde_json::from_str::<String>(&payload) {
                    if text.starts_with("__RESET__") {
                        // 质检重置帧：原样转发给前端清空重绘，但已累积的回复作废——
                        // 被 REVISE 否定的轮次不入历史（否则 __RESET__ 标记与废轮文本
                        // 会污染 chat_history，进而注入后续对话上下文，形成坏 few-shot）
                        reply.clear();
                        yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                        continue;
                    }
                    if text.starts_with("__PROCESS__") {
                        // 过程步骤帧（计划/工具调用/质检打回，前端灰色过程行展示）：
                        // 属于"执行过程"而非最终回复，转发但不累积进历史
                        yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                        continue;
                    }
                    reply.push_str(&text);
                    yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                }
            }
            if terminal { break; }
        }

        // 正常收尾（无论是否收到终止标记）：不再触发中断清理
        done.store(true, std::sync::atomic::Ordering::SeqCst);

        // 上游中断且未收到终止标记：显式告知前端（否则静默截断无法区分）
        if !terminal {
            yield Ok::<_, axum::Error>(Bytes::from(
                "data: __ERROR__:\"与 Agent 的连接中断，回复可能不完整\"\n\n",
            ));
        }

        // 流结束：保存历史 + 独立摘要（来自 __SUMMARY__ 帧，无则不入库）
        if !reply.is_empty() && uid > 0 {
            save_assistant_reply(&state.db, uid, reply, summary_override, total_count).await;
        }
    };

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
        Body::from_stream(body_stream),
    ).into_response()
}
