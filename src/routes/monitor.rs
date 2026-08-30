// 前端错误上报端点（20260830，监控补齐 B）：
// POST /api/monitor/log —— 浏览器侧 JS 异常 / 未捕获 Promise / API 失败（fetch 包装）
// 经 keepalive fetch 上报，落盘 logs/frontend/monitor.log（20260830f 日志分组：前端组），
// 纳入统一日志体系（logrotate 同规则轮转）。
//
// 设计取舍：
//   - 匿名可写：访客错误上报最有价值，不要求登录（带 token 时解析出 uid 标记来源）；
//   - 防刷：body 上限 8KB（超限 413）+ logrotate 兜底磁盘；不做 per-IP 限流，
//     异常增长时 health.log 的 WARN（access 日志）会暴露；
//   - 落盘方式：每条开-写-关（低流量无碍），copytruncate 轮转安全（不持 fd）；
//     手动拼行与 rust.log 视觉对齐（%Y-%m-%d %H:%M:%S%.3f + key=value）。

use axum::{
    Json,
    body::Body,
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::io::Write;

use crate::auth_jwt;

/// 上报载荷（前端 autoload.js 全局捕获打包；message 截 500 / stack 截 1500）
#[derive(Deserialize)]
pub struct ReportPayload {
    #[serde(rename = "type")]
    pub kind: Option<String>, // js_error | unhandled_rejection | fetch_fail | http_status | module_load_fail
    pub message: Option<String>,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// 换行清洗：错误消息/堆栈可能含 \n，一行一记录保证 grep 语义
fn clean(s: &str) -> String {
    s.replace(['\n', '\r'], " ")
}

pub async fn report_log(req: Request<Body>) -> Response {
    // 带 token 时解析 uid，无则 guest（访客错误同样值得记录）——headers 须在 into_body 前读
    let uid = auth_jwt::auth_uid(&req.headers())
        .map(|u| u.to_string())
        .unwrap_or_else(|| "guest".to_string());

    // 照抄 chat.rs 模式：手动限体 + serde_json::from_slice
    let body_bytes = match axum::body::to_bytes(req.into_body(), 8 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({"ok": false, "error": "payload too large"})),
            )
                .into_response()
        }
    };
    let payload: ReportPayload = match serde_json::from_slice(&body_bytes) {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"ok": false, "error": "bad json"})),
            )
                .into_response()
        }
    };

    let kind = payload.kind.unwrap_or_else(|| "unknown".to_string());
    // 20260830f：全量——截断放宽（message 2000/stack 4000，用户要求全量追踪 agent 问题）
    let msg = truncate(&clean(payload.message.as_deref().unwrap_or("")), 2000);
    let stack = truncate(&clean(payload.stack.as_deref().unwrap_or("")), 4000);
    let url = clean(payload.url.as_deref().unwrap_or(""));

    let level = if kind == "http_status" { "WARN" } else { "ERROR" };
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("{ts} {level} [monitor] type={kind} uid={uid} url={url} msg={msg} stack={stack}\n");

    // 20260830f 日志分组：前端组 logs/frontend/（agent 组 logs/agent/、后端 rust.log 不动）
    let path = std::env::var("SAUDADE_MONITOR_LOG").unwrap_or_else(|_| "logs/frontend/monitor.log".to_string());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }

    Json(serde_json::json!({"ok": true})).into_response()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { s.to_string() } else { s[..max].to_string() }
}
