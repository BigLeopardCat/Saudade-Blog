use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::process::Command;
use crate::routes::AppState;

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

pub async fn chat_handler(
    State(_state): State<Arc<AppState>>,
    Json(payload): Json<ChatRequest>,
) -> Json<ChatResponse> {
    let agent_path = std::env::var("AGENT_PATH")
        .unwrap_or_else(|_| "/home/ubuntu/memory_blog_rust/saudade-blog-agent".to_string());

    let output = Command::new("./.venv/bin/python3")
        .args(["main.py", "--ask", &format!("[系统: 用户当前在页面 '{}' (标题: {})。如果需要导航请使用 navigate_to 工具。]\n用户消息: {}", payload.current_url.as_deref().unwrap_or(""), payload.page_title.as_deref().unwrap_or(""), payload.message)])
        .current_dir(&agent_path)
        .output()
        .await;

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
