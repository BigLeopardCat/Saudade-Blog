use axum::{Json, extract::{State, Request}, http::header};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::process::Command;
use crate::routes::AppState;
use crate::auth_jwt;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub current_url: Option<String>,
    #[serde(default)]
    pub page_title: Option<String>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub reply: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, ColumnTrait, QueryTrait, ActiveModelTrait};
use crate::entity::chat_history;

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

    let agent_path = std::env::var("AGENT_PATH")
        .unwrap_or_else(|_| "/home/ubuntu/memory_blog_rust/saudade-blog-agent".to_string());

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
    let history_ctx = if uid > 0 {
        let mut recent = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .order_by_desc(chat_history::Column::CreatedAt)
            
            .all(&state.db)
            .await.unwrap_or_default();
        let lines: Vec<String> = recent.iter().rev().map(|h| format!("{}: {}", h.role, h.content)).collect();
        if lines.is_empty() { String::new() } else { format!("\n[最近对话]:\n{}", lines.join("\n")) }
    } else { String::new() };

    let full_prompt = format!("[系统: 用户当前在页面 '{}' (标题: {})。用户ID: {}。{}]\n用户消息: {}",
        payload.current_url.as_deref().unwrap_or(""),
        payload.page_title.as_deref().unwrap_or(""),
        uid,
        history_ctx,
        payload.message
    );

    let output = Command::new("./.venv/bin/python3")
        .args(["main.py", "--ask", &full_prompt])
        .current_dir(&agent_path)
        .output()
        .await;

    // 保存 Agent 回复
    if uid > 0 {
        if let Ok(ref out) = output {
            let reply = String::from_utf8_lossy(&out.stdout);
            let reply_text = if reply.contains("Agent: ") {
                reply.split("Agent: ").nth(1).unwrap_or(&reply).trim().to_string()
            } else { reply.trim().to_string() };
            let _ = chat_history::ActiveModel {
                user_id: Set(uid),
                role: Set("assistant".into()),
                content: Set(reply_text),
                ..Default::default()
            }.save(&state.db).await;
        }
    }

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();

            let reply = if stdout.contains("Agent: ") {
                stdout.split("Agent: ")
                    .nth(1)
                    .unwrap_or(&stdout)
                    .trim()
                    .to_string()
            } else {
                stdout.trim().to_string()
            };

            if !out.status.success() {
                Json(ChatResponse {
                    reply: String::new(),
                    success: false,
                    error: Some(stderr.trim().to_string()),
                })
            } else {
                Json(ChatResponse {
                    reply,
                    success: true,
                    error: None,
                })
            }
        }
        Err(e) => {
            Json(ChatResponse {
                reply: String::new(),
                success: false,
                error: Some(e.to_string()),
            })
        }
    }
}
