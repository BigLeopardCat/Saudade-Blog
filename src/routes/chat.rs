use axum::{Json, extract::{State, Request}, http::header};
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

pub async fn chat_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Json<ChatResponse> {
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
        Err(_) => return Json(ChatResponse { reply: String::new(), success: false, error: Some("请求体过大".into()) }),
    };
    let payload: ChatRequest = match serde_json::from_slice(&body_bytes) {
        Ok(p) => p,
        Err(e) => return Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("JSON解析失败: {}", e)) }),
    };

    if user_id.is_none() {
        return Json(ChatResponse {
            reply: "尊敬的访客：\n\n本站部署的AI虚拟形象Agent（导航/解读助手）仅供技术学习交流与功能展示使用，不视为面向公众开放的经营性AI服务。\n\n为严格遵守《生成式人工智能服务管理暂行办法》等相关法律法规，履行合规义务，本项目已采取访问限制措施，当前未向不特定公众开放。\n\n如您确因学习、交流或前端技术测试需要体验该功能，请通过博客底部或关于页面的联系方式，联系管理员申请临时体验账号。管理员将在确认您的需求后，为您开通限时访问权限。\n\n感谢您的理解与支持！\n我们始终坚持合规先导，也期待与各位爱好者共同交流学习。\n\nSaudade Blog\n2026年7月29日".into(),
            success: true,
            error: None,
        });
    }

    let uid = user_id.unwrap_or(0);
    // 保存用户消息
    if uid > 0 {
        let _ = chat_history::ActiveModel {
            user_id: Set(uid),
            role: Set("user".into()),
            content: Set(payload.message.clone()),
            ..Default::default()
        }.save(&state.db).await;
    }
    // 读取最近历史
        let history_items: Vec<serde_json::Value> = if uid > 0 {
        let recent = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .order_by_desc(chat_history::Column::CreatedAt)
            .limit(Some(20))
            .all(&state.db)
            .await.unwrap_or_default();
        recent.iter().rev().map(|h| serde_json::json!({"role": h.role, "content": h.content})).collect()
    } else { vec![] };

    // 加载压缩摘要
    let summary_text = if uid > 0 {
        chat_summary::Entity::find()
            .filter(chat_summary::Column::UserId.eq(uid))
            .one(&state.db)
            .await.unwrap_or_default()
            .map(|s| s.summary)
            .unwrap_or_default()
    } else { String::new() };

    // 统计总消息数，决定是否触发压缩
    let total_count: i64 = if uid > 0 {
        chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .count(&state.db)
            .await.unwrap_or(0) as i64
    } else { 0 };
    let needs_summary = uid > 0 && total_count > 20 && (total_count % 10 == 0 || total_count % 10 == 1);

    let agent_url = std::env::var("AGENT_URL").unwrap_or_else(|_| "http://127.0.0.1:8010/chat".to_string());
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

    // 传输层偶发失败（agent worker 重启、瞬时断连等）自动重试最多 3 次，
    // 避免对话偶发 "connection closed before message completed" 报错。
    // 超时不重试：长回答（公式推导等）单次生成可长达 180s，超时重试只会从头再生成一遍
    let mut resp_opt: Option<reqwest::Response> = None;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match reqwest::Client::new().post(&agent_url)
            .json(&body)
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
                if uid > 0 {
                    let _ = chat_history::ActiveModel {
                        user_id: Set(uid),
                        role: Set("assistant".into()),
                        content: Set(reply.clone()),
                        ..Default::default()
                    }.save(&state.db).await;
                }
                // 如果 agent 返回了新的摘要，保存
                if let Some(new_summary) = data["new_summary"].as_str() {
                    if uid > 0 && !new_summary.is_empty() {
                        let existing = chat_summary::Entity::find()
                            .filter(chat_summary::Column::UserId.eq(uid))
                            .one(&state.db)
                            .await.unwrap_or_default();
                        if let Some(rec) = existing {
                            let mut am: chat_summary::ActiveModel = rec.into();
                            am.summary = Set(new_summary.to_string());
                            am.message_count = Set(total_count as i32);
                            let _ = am.update(&state.db).await;
                        } else {
                            let _ = chat_summary::ActiveModel {
                                user_id: Set(uid),
                                summary: Set(new_summary.to_string()),
                                message_count: Set(total_count as i32),
                                ..Default::default()
                            }.save(&state.db).await;
                        }
                    }
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
