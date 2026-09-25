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
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::io::Write;
use std::sync::Arc;

use crate::auth_jwt;
use crate::routes::AppState;

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

/// 前端上报器实际会发的 type（`autoload.js` 全局捕获那五种）。
///
/// `type` 必须收敛成可枚举值（20260925 审计 A2）：这里原先把 `payload.kind` 原样拼进
/// 落盘行，而它是**匿名可写**的字段 ⇒ 任何访客能整行伪造（自定时间戳/级别/`uid=`），
/// 且伪造行会把真实那条记录的 uid/url/msg/stack 全冲到伪造行末尾（真线索被毁）。
/// 白名单比清洗彻底：清洗只挡换行，白名单让 `type=` 变成可枚举字段——对账侧
/// （`eval/trace_reconcile.py` 按 `type=` 分类）因此能把"未知 type"直接标成可疑。
const MONITOR_KINDS: [&str; 5] = [
    "js_error",
    "unhandled_rejection",
    "fetch_fail",
    "http_status",
    "module_load_fail",
];

fn normalize_kind(raw: Option<&str>) -> String {
    let k = clean(raw.unwrap_or(""));
    if MONITOR_KINDS.contains(&k.as_str()) {
        k
    } else {
        "other".to_string()
    }
}

pub async fn report_log(State(state): State<Arc<AppState>>, req: Request<Body>) -> Response {
    // 带 token 时解析 uid，无则 guest（访客错误同样值得记录）——headers 须在 into_body 前读。
    // 20260926：身份走同一个出口 ⇒ 冻结/令牌被收回的账号在这里也归 guest（它确实已经
    // 不是"登录中的用户"了）。这条端点本就匿名可写，**uid 只是日志归属**、不授予任何能力；
    // 之所以仍然走查库那一版，是不给"绕过身份出口"留第二个先例（见 auth_jwt::auth_uid 头注）。
    let uid = match auth_jwt::auth_uid(&state.db, req.headers()).await {
        Ok(u) => u.to_string(),
        Err(_) => "guest".to_string(),
    };

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

    let kind = normalize_kind(payload.kind.as_deref());
    // 20260830f：全量——截断放宽（message 2000/stack 4000，用户要求全量追踪 agent 问题）
    let msg = truncate(&clean(payload.message.as_deref().unwrap_or("")), 2000);
    let stack = truncate(&clean(payload.stack.as_deref().unwrap_or("")), 4000);
    // 20260925 审计：`url` 此前只清换行不截断 ⇒ 8KB body 内能占满整行（与 msg/stack 同一口径）
    let url = truncate(&clean(payload.url.as_deref().unwrap_or("")), 500);

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

/// 多字节安全的截断（20260925 审计 A1）。
///
/// `s.len()` 是**字节**长度、`s[..max]` 是**字节**索引切片——落在多字节字符中间时
/// Rust 直接 panic（实测：`{"message": "汉"×700}` 恰好让 2000 落在第 667 个汉字中间）。
/// 影响不是"进程崩了"（tokio 在任务边界接住 panic，服务 `NRestarts=0`），而是两件事：
/// ① 匿名、公网可达的一发就能刷 `rust.log`（panic 回溯把整个载荷写进去）；
/// ② **它在静默丢真实数据**——前端错误正文超 2000 字节的中文很常见（3 字节/字，667 字
///    就够），这一条上报直接消失，而调用方收到的是断连、不是任何错误码。
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 审计 A1 的两种实测输入：ASCII 落在边界（对照）与多字节落在字符中间（原 panic）。
    /// 判据是"任何时候不出现 `&str[..n]` 的裸切片"——这个用例是它的回归锁。
    #[test]
    fn truncate_never_splits_a_char() {
        let ascii = "A".repeat(2500);
        assert_eq!(truncate(&ascii, 2000).len(), 2000);

        let cjk = "汉".repeat(700); // 2100 字节，2000 落在第 667 个汉字中间
        let cut = truncate(&cjk, 2000);
        assert_eq!(cut.len(), 1998, "应回退到上一个字符边界");
        assert!(cjk.starts_with(&cut));

        // 边界情况：正好等于上限不动、上限落在多字节字符起点也不该多退
        assert_eq!(truncate("汉汉", 6), "汉汉");
        assert_eq!(truncate("汉汉", 3), "汉");
        assert_eq!(truncate("", 10), "");
    }

    /// 审计 A2：`type` 是匿名可写字段，原样插值可被整行伪造。
    #[test]
    fn kind_is_a_closed_enum() {
        assert_eq!(normalize_kind(Some("js_error")), "js_error");
        assert_eq!(normalize_kind(Some("http_status")), "http_status");
        assert_eq!(normalize_kind(None), "other");
        assert_eq!(normalize_kind(Some("SECAUDIT_FORGED")), "other");
        // 换行与空格都不许把值撑出白名单（审计那条伪造行就是靠 \n 撑进来的）
        assert_eq!(normalize_kind(Some("js_error\n2026-01-01 ERROR x")), "other");
        assert_eq!(normalize_kind(Some("js_error x")), "other");
        assert_eq!(normalize_kind(Some("JS_ERROR")), "other");
    }
}
