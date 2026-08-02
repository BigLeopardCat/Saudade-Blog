use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Request, State},
    http::header,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::auth_jwt;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub current_url: Option<String>,
    #[serde(default)]
    pub page_title: Option<String>,
    #[serde(default)]
    pub current_effects: Option<String>,
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
    body: serde_json::Value,
}

/// 鉴权 + 请求体解析 + 保存用户消息 + 加载历史/摘要 + 组装 agent 请求体
async fn prepare_chat(state: &Arc<AppState>, req: Request) -> Result<ChatCtx, Json<ChatResponse>> {
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

    // 保存用户消息
    let _ = chat_history::ActiveModel {
        user_id: Set(uid),
        role: Set("user".into()),
        content: Set(payload.message.clone()),
        ..Default::default()
    }.save(&state.db).await;

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
        "user_id": uid,
        "history": history_items,
        "summary": summary_text,
        "needs_summary": needs_summary,
    });

    if std::env::var("CHAT_DEBUG_BODY").is_ok() {
        eprintln!("[chat-debug] body={}", body);
    }
    Ok(ChatCtx { uid, total_count, body })
}

/// 对话结束后保存 assistant 消息 + 摘要（/chat 与 /chat/stream 共用）。
/// - 非流式路径：agent 已剥离 SUMMARY 并单独返回 new_summary，直接使用；
/// - 流式路径：原始流里仍带 SUMMARY 行，此处剥离。
/// 摘要指令行不写入历史。
async fn save_assistant_reply(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    raw_reply: String,
    new_summary_override: Option<String>,
    total_count: i64,
) {
    let mut new_summary = new_summary_override;
    let mut lines: Vec<&str> = Vec::new();
    for line in raw_reply.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("SUMMARY:") {
            // 流式路径兜底：如果 agent 未剥离（流式不经 agent 的 SUMMARY 解析），此处剥离
            if new_summary.is_none() {
                let s = rest.trim();
                if !s.is_empty() { new_summary = Some(s.to_string()); }
            }
            continue;
        }
        lines.push(line);
    }
    let reply = lines.join("\n");

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
    // 传输层偶发失败（agent worker 重启、瞬时断连等）自动重试最多 3 次，
    // 避免对话偶发 "connection closed before message completed" 报错。
    // 超时不重试：长回答（公式推导等）单次生成可长达 180s，超时重试只会从头再生成一遍
    let mut resp_opt: Option<reqwest::Response> = None;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match reqwest::Client::new().post(&agent_url)
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
                // 非流式：agent 已剥离 SUMMARY 并单独返回 new_summary
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
    // 流式连接不设整体超时（长回答可达数分钟），connect/首字节由 reqwest 默认处理
    let upstream = match reqwest::Client::new()
        .post(&stream_url)
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

    let body_stream = stream! {
        let mut upstream_stream = upstream.bytes_stream();
        let mut frame_buf: Vec<u8> = Vec::new();
        let mut reply = String::new();
        let mut terminal = false;

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
                // 文本块：JSON 编码，解码后累积（用于历史保存），原样转发
                if let Ok(text) = serde_json::from_str::<String>(&payload) {
                    reply.push_str(&text);
                    yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                }
            }
            if terminal { break; }
        }

        // 上游中断且未收到终止标记：显式告知前端（否则静默截断无法区分）
        if !terminal {
            yield Ok::<_, axum::Error>(Bytes::from(
                "data: __ERROR__:\"与 Agent 的连接中断，回复可能不完整\"\n\n",
            ));
        }

        // 流结束：保存历史 + 摘要（流式路径 agent 未剥离 SUMMARY，此处解析）
        if !reply.is_empty() && uid > 0 {
            save_assistant_reply(&state.db, uid, reply, None, total_count).await;
        }
    };

    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONNECTION, "keep-alive"),
            // 关键：告知 nginx 不要缓冲此响应，否则 SSE 会被攒到结束才一次性下发
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(body_stream),
    ).into_response()
}
