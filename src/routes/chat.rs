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
    needs_summary: bool,
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
        "current_darkmode": payload.current_darkmode.as_deref().unwrap_or(""),
        "user_id": uid,
        "history": history_items,
        "summary": summary_text,
        "needs_summary": needs_summary,
    });

    if std::env::var("CHAT_DEBUG_BODY").is_ok() {
        eprintln!("[chat-debug] body={}", body);
    }
    Ok(ChatCtx { uid, total_count, needs_summary, body })
}

/// 判断一段文本是否为模型未带 SUMMARY: 前缀输出的裸摘要（格式漂移兜底）。
/// 特征：以"访客/用户"第三人称开头 + 含会话时序词（之前/随后/最后/接着/首先/然后）
/// + 无互动语气词（喵/波浪号/感叹问号/颜文字）。判定较严格，正常对话回复不会被误删。
fn looks_like_summary_paragraph(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > 300 {
        return false;
    }
    if !(t.starts_with("访客") || t.starts_with("用户")) {
        return false;
    }
    if !["之前", "随后", "最后", "接着", "首先", "然后"]
        .iter()
        .any(|w| t.contains(w))
    {
        return false;
    }
    // 互动语气词排除（"喵"单独不算——"泠月喵"是 agent 名字，摘要中常出现）
    if t.chars().any(|c| "呜~～!！?？🐱😿🐾😂😭".contains(c)) {
        return false;
    }
    true
}

/// 从回复中剥离摘要（SUMMARY: 前缀优先；无前缀时对 needs_summary 轮做裸摘要特征兜底）。
/// 返回 (剥离后的回复, 新摘要或 None)。
fn strip_summary_from_reply(
    raw_reply: &str,
    needs_summary: bool,
    new_summary_override: Option<&str>,
) -> (String, Option<String>) {
    let mut new_summary = new_summary_override.map(|s| s.to_string());
    let mut lines: Vec<&str> = Vec::new();
    let mut found_prefix = false;
    for line in raw_reply.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("SUMMARY:") {
            found_prefix = true;
            if new_summary.is_none() {
                let s = rest.trim();
                if !s.is_empty() {
                    new_summary = Some(s.to_string());
                }
            }
            continue;
        }
        lines.push(line);
    }
    // 无前缀裸摘要兜底：模型格式漂移不带 SUMMARY: 前缀时，摘要会原样显示给访客且无法入库
    if !found_prefix && new_summary.is_none() && needs_summary {
        let paragraphs: Vec<&str> = raw_reply
            .split("\n\n")
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();
        if let Some(last) = paragraphs.last() {
            if looks_like_summary_paragraph(last) {
                new_summary = Some(last.to_string());
                if let Some(idx) = raw_reply.rfind(last) {
                    return (raw_reply[..idx].trim().to_string(), new_summary);
                }
            }
        }
    }
    (lines.join("\n"), new_summary)
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
    needs_summary: bool,
) {
    let (reply, new_summary) =
        strip_summary_from_reply(&raw_reply, needs_summary, new_summary_override.as_deref());

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
                    save_assistant_reply(&state.db, ctx.uid, reply.clone(), agent_summary, ctx.total_count, ctx.needs_summary).await;
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

/// 流式对话中断清理：客户端中途断开（用户点击"停止生成"、关闭标签页、网络中断）时，
/// 本轮已写入 chat_history 的用户消息及其后的残缺回复一并删除——
/// 被终止的对话不进入记忆（history 上下文 / 摘要），避免残缺问答污染后续对话。
///
/// Drop 在 SSE 生成器（body_stream）被取消时同步执行；DB 删除是异步操作，用 tokio::spawn 异步完成。
/// 仅当流未正常收尾（未收到终止标记即被取消）时才清理；正常结束由 done 标记关闭清理，
/// 保留既有行为（含上游异常时保存残缺回复的逻辑，见 chat_stream_handler 尾部）。
struct DiscardAbortedExchange {
    state: Arc<AppState>,
    uid: i32,
    done: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for DiscardAbortedExchange {
    fn drop(&mut self) {
        if self.done.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let state = self.state.clone();
        let uid = self.uid;
        // 删除该用户最后一条 user 消息及其后的所有记录（最多一条残缺 assistant 回复）。
        // id 单调递增，user 消息之后只会出现本轮自己的回复
        tokio::spawn(async move {
            let last_user = chat_history::Entity::find()
                .filter(chat_history::Column::UserId.eq(uid))
                .filter(chat_history::Column::Role.eq("user"))
                .order_by_desc(chat_history::Column::Id)
                .one(&state.db)
                .await;
            let Ok(Some(u)) = last_user else { return };
            let _ = chat_history::Entity::delete_many()
                .filter(chat_history::Column::UserId.eq(uid))
                .filter(chat_history::Column::Id.gte(u.id))
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
    let needs_summary = ctx.needs_summary;

    let body_stream = stream! {
        let mut upstream_stream = upstream.bytes_stream();
        let mut frame_buf: Vec<u8> = Vec::new();
        let mut reply = String::new();
        let mut terminal = false;

        // 客户端中断清理（见 DiscardAbortedExchange）：流被取消时删除本轮已入库的用户消息；
        // 正常走完 while 循环后置位 done，关闭清理
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _guard = DiscardAbortedExchange { state: state.clone(), uid, done: done.clone() };

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

        // 正常收尾（无论是否收到终止标记）：不再触发中断清理
        done.store(true, std::sync::atomic::Ordering::SeqCst);

        // 上游中断且未收到终止标记：显式告知前端（否则静默截断无法区分）
        if !terminal {
            yield Ok::<_, axum::Error>(Bytes::from(
                "data: __ERROR__:\"与 Agent 的连接中断，回复可能不完整\"\n\n",
            ));
        }

        // 流结束：保存历史 + 摘要（流式路径 agent 未剥离 SUMMARY，此处解析；
        // needs_summary 为真时还会对无前缀裸摘要做特征兜底，防止模型格式漂移导致摘要泄露给访客）
        if !reply.is_empty() && uid > 0 {
            save_assistant_reply(&state.db, uid, reply, None, total_count, needs_summary).await;
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

#[cfg(test)]
mod summary_tests {
    use super::*;

    #[test]
    fn strips_summary_prefix_line() {
        let (reply, summary) =
            strip_summary_from_reply("好的喵~\nSUMMARY: 访客咨询了博客功能", true, None);
        assert_eq!(reply, "好的喵~");
        assert_eq!(summary.as_deref(), Some("访客咨询了博客功能"));
    }

    #[test]
    fn strips_bare_summary_paragraph_when_needs_summary() {
        // 模型格式漂移：无 SUMMARY: 前缀的裸摘要，需剥离且入库为摘要
        let raw = "好的喵~\n\n访客之前多次要求开启夜间模式，随后询问了物联网控制台，最后称赞了泠月喵。";
        let (reply, summary) = strip_summary_from_reply(raw, true, None);
        assert_eq!(reply, "好的喵~");
        assert!(summary.is_some());
        assert!(summary.unwrap().starts_with("访客之前多次"));
    }

    #[test]
    fn keeps_bare_summary_when_not_needs_summary() {
        // 非摘要轮：正常回复段落即使形似总结也不剥离
        let raw = "好的喵~\n\n访客之前问过这个问题，最后我们再确认一下就好啦。";
        let (reply, summary) = strip_summary_from_reply(raw, false, None);
        assert_eq!(reply, raw);
        assert!(summary.is_none());
    }

    #[test]
    fn keeps_interactive_reply_ending() {
        // 带互动语气词的正常回复不误删
        let raw = "好的喵~\n\n访客大人之前说的都对，最后我们看效果吧！";
        let (reply, summary) = strip_summary_from_reply(raw, true, None);
        assert_eq!(reply, raw);
        assert!(summary.is_none());
    }

    #[test]
    fn respects_new_summary_override() {
        // 非流式路径：agent 已返回 new_summary，直接使用，不再从回复里提取
        let raw = "好的喵~\n\n访客之前多次要求开启特效。";
        let (reply, summary) =
            strip_summary_from_reply(raw, true, Some("agent返回的摘要"));
        assert_eq!(reply, raw);
        assert_eq!(summary.as_deref(), Some("agent返回的摘要"));
    }

    #[test]
    fn looks_like_summary_paragraph_detection() {
        assert!(looks_like_summary_paragraph("访客之前多次要求开启夜间模式，随后确认了状态，最后表示满意。"));
        assert!(!looks_like_summary_paragraph("访客大人之前的问题我来解答一下喵~"));
        assert!(!looks_like_summary_paragraph("好的，之前说的都办好了！"));
    }
}
