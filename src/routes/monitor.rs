use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::auth_jwt;
use crate::routes::AppState;

/// 前端错误报告；消息和堆栈落盘上限分别为 2000、4000 字节。
#[derive(Deserialize)]
pub struct ReportPayload {
    /// 取值必须落在 MONITOR_KINDS 里，否则在落盘时收敛成 `other`。
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub message: Option<String>,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// WebGL 缺失或无效时记为 unknown，不影响其他报告字段。
    #[serde(default)]
    pub webgl: Option<serde_json::Value>,
}

fn diagnostic_url(value: &str) -> String {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("blob:") {
        return format!("{}:[redacted]", lower.split(':').next().unwrap_or("data"));
    }
    if lower.starts_with("http://") || lower.starts_with("https://") || value.starts_with("//") {
        let absolute = if value.starts_with("//") {
            format!("https:{value}")
        } else {
            value.to_string()
        };
        return match reqwest::Url::parse(&absolute) {
            Ok(url) if url.has_host() => {
                let origin = url.origin().ascii_serialization();
                let origin = if value.starts_with("//") {
                    origin.trim_start_matches("https:")
                } else {
                    &origin
                };
                format!("{origin}{}", url.path())
            }
            _ => "[invalid-url]".to_string(),
        };
    }
    if let Some((scheme, _)) = value.split_once(':') {
        if scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return "[unsupported-url]".to_string();
        }
    }
    value.split(['?', '#']).next().unwrap_or("").to_string()
}

fn diagnostic_text(value: &str, source: &str, safe_source: &str) -> String {
    static URLS: OnceLock<regex::Regex> = OnceLock::new();
    let urls = URLS.get_or_init(|| {
        regex::Regex::new(r#"(?i)\bdata:[\s\S]*|\bblob:[^\s<>"']+|\bhttps?://[^\s<>"']+|//[^\s<>"']+|/api/[^\s<>"']+"#)
            .expect("fixed diagnostic URL expression")
    });
    let text = if source.is_empty() {
        value.to_string()
    } else {
        value.replace(source, safe_source)
    };
    urls.replace_all(&text, |capture: &regex::Captures<'_>| {
        diagnostic_url(&capture[0])
    })
    .into_owned()
}

/// Client payloads are untrusted; sanitize before truncation and deduplication.
fn report_fields(payload: &ReportPayload) -> (String, String, String) {
    let source = payload.url.as_deref().unwrap_or("");
    let safe_source = diagnostic_url(source);
    let message = diagnostic_text(
        payload.message.as_deref().unwrap_or(""),
        source,
        &safe_source,
    );
    let stack = diagnostic_text(payload.stack.as_deref().unwrap_or(""), source, &safe_source);
    (
        truncate(&clean(&message), 2000),
        truncate(&clean(&stack), 4000),
        truncate(&clean(&safe_source), 500),
    )
}

fn clean(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_control() || is_invisible_format(c) {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// 清除 is_control() 未覆盖的零宽、双向重排和 BOM 字符，避免伪造终端输出。
fn is_invisible_format(c: char) -> bool {
    matches!(c,
        '\u{200b}'..='\u{200f}'
        | '\u{202a}'..='\u{202e}'
        | '\u{2066}'..='\u{2069}'
        | '\u{feff}')
}

const MONITOR_KINDS: [&str; 14] = [
    // boot.js 全局捕获
    "js_error",
    "unhandled_rejection",
    "fetch_fail",
    "http_status",
    "module_load_fail",
    "session_init_fail",
    // chat-stream.js（对话链路：弹窗卡、命令流、工具绑定超时）
    "confirm_card",
    "confirm_flow",
    "widget_tool_bind_timeout",
    // chat-engine.js（消息流 DOM 清理兜底）
    "orphan_dom_drop",
    // renderer.js（渲染层：工具执行失败、Live2D 加载失败）
    "widget_tool_fail",
    "live2d_load_fail",
    "react_error",
    "resource_error",
];

fn normalize_kind(raw: Option<&str>) -> String {
    let k = clean(raw.unwrap_or(""));
    if MONITOR_KINDS.contains(&k.as_str()) {
        k
    } else {
        "other".to_string()
    }
}

/// 客户端 User-Agent 同样需要清洗，并按 UTF-8 字符边界截至 300 字节。
fn normalize_ua(raw: Option<&str>) -> String {
    truncate(&clean(raw.unwrap_or("")), 300)
}

/// `webgl` 标记归一。缺席 / 脏值 ⇒ `unknown`（**不是 `no`**）。
fn normalize_webgl(raw: Option<&serde_json::Value>) -> &'static str {
    match raw {
        Some(serde_json::Value::Bool(true)) => "yes",
        Some(serde_json::Value::Bool(false)) => "no",
        _ => "unknown",
    }
}

/// 同一 key 重复上报的合并窗口。
const DEDUPE_WINDOW: Duration = Duration::from_secs(60);
/// 表容量上限（防被刷爆内存：每个 key 只占一个短字符串 + 两个计数器）。
const DEDUPE_MAX_KEYS: usize = 512;

/// 固定窗口内累加 dup，不延后首次时间；持续错误每个窗口重新记录。
fn dedupe_hit(map: &mut HashMap<String, (Instant, u32)>, key: &str, now: Instant) -> u32 {
    match map.get_mut(key) {
        Some((first, n)) if now.duration_since(*first) < DEDUPE_WINDOW => {
            *n += 1;
            *n
        }
        _ => {
            map.insert(key.to_string(), (now, 1));
            1
        }
    }
}

/// 跨访客去重；dup 是报告次数，不归属于首条记录的 uid/ua。
/// 表满时先清过期项，再清空以限制内存；锁内不执行异步操作。
fn dedupe_count(key: &str) -> u32 {
    static TABLE: OnceLock<Mutex<HashMap<String, (Instant, u32)>>> = OnceLock::new();
    let table = TABLE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    // 锁不可用时保留本次报告，不去重。
    let Ok(mut map) = table.lock() else { return 1 };
    if map.len() >= DEDUPE_MAX_KEYS {
        map.retain(|_, (first, _)| now.duration_since(*first) < DEDUPE_WINDOW);
        if map.len() >= DEDUPE_MAX_KEYS {
            map.clear();
        }
    }
    dedupe_hit(&mut map, key, now)
}

pub async fn report_log(State(state): State<Arc<AppState>>, req: Request<Body>) -> Response {
    let ip = super::auth::get_client_ip(req.headers());
    if let Err(msg) = state.report_limiter.hit(&ip, "report") {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"ok": false, "error": msg})),
        )
            .into_response();
    }

    let uid = match auth_jwt::auth_uid(&state.db, req.headers()).await {
        Ok(u) => u.to_string(),
        Err(_) => "guest".to_string(),
    };

    // 消费请求体前读取 User-Agent。
    let ua = normalize_ua(
        req.headers()
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
    );

    // 报告请求体限制为 8 KiB。
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
    let (msg, stack, url) = report_fields(&payload);

    // 去重仅使用清洗后的 kind、url 和消息前 80 字节；不按 uid/ua 分组。
    let dup = dedupe_count(&format!("{kind}|{}|{url}", truncate(msg.as_str(), 80)));

    let level = if kind == "http_status" {
        "WARN"
    } else {
        "ERROR"
    };
    let webgl = normalize_webgl(payload.webgl.as_ref());
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    // 日志字段顺序供现有解析器使用；扩展字段只在末尾追加。
    let line = format!(
        "{ts} {level} [monitor] type={kind} uid={uid} url={url} msg={msg} stack={stack} ua={ua} webgl={webgl} dup={dup}\n"
    );

    let path = std::env::var("SAUDADE_MONITOR_LOG")
        .unwrap_or_else(|_| "logs/frontend/monitor.log".to_string());
    append_line(&path, &line).await;

    Json(serde_json::json!({"ok": true})).into_response()
}

async fn append_line(path: &str, line: &str) {
    use tokio::io::AsyncWriteExt;

    if let Some(parent) = std::path::Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            warn_write_failed(path, &error);
            return;
        }
    }

    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    {
        Ok(mut f) => {
            if let Err(e) = f.write_all(line.as_bytes()).await {
                warn_write_failed(path, &e);
            }
        }
        Err(e) => warn_write_failed(path, &e),
    }
}

/// 写入告警采用固定窗口限频，并在下个窗口首条告警报告被抑制数量。
const WRITE_WARN_WINDOW: Duration = Duration::from_secs(60);

/// 返回本次是否记录、窗口起点和新的抑制计数。
fn warn_decision(
    last: Option<Instant>,
    suppressed: u32,
    now: Instant,
) -> (bool, Option<Instant>, u32) {
    match last {
        Some(t) if now.duration_since(t) < WRITE_WARN_WINDOW => (false, last, suppressed + 1),
        _ => (true, Some(now), 0),
    }
}

fn warn_write_failed(path: &str, err: &std::io::Error) {
    static STATE: OnceLock<Mutex<(Option<Instant>, u32)>> = OnceLock::new();
    let state = STATE.get_or_init(|| Mutex::new((None, 0)));
    // 告警限频锁不可用时仍记录本次失败。
    let Ok(mut g) = state.lock() else {
        tracing::warn!("[monitor] 落盘失败 path={path} err={err}");
        return;
    };
    let (report, new_last, suppressed) = warn_decision(g.0, g.1, Instant::now());
    let carried = if report { g.1 } else { 0 }; // 上一窗口被压掉的条数
    *g = (new_last, suppressed);
    drop(g);
    if report {
        if carried > 0 {
            tracing::warn!(
                "[monitor] 落盘失败 path={path} err={err}（上一个窗口另有 {carried} 条同类失败未记）"
            );
        } else {
            tracing::warn!("[monitor] 落盘失败 path={path} err={err}");
        }
    }
}

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

    #[tokio::test]
    async fn monitor_creates_its_parent_directory_and_appends_without_truncating() {
        let root = std::env::temp_dir().join(format!("saudade-monitor-{}", uuid::Uuid::new_v4()));
        let path = root.join("logs/frontend/monitor.log");
        assert!(!path.parent().unwrap().exists());
        append_line(path.to_str().unwrap(), "synthetic first\n").await;
        append_line(path.to_str().unwrap(), "synthetic second\n").await;
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "synthetic first\nsynthetic second\n"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn invalid_parent_path_does_not_panic_or_overwrite_an_existing_file() {
        let root = std::env::temp_dir().join(format!("saudade-monitor-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let parent = root.join("not-a-directory");
        tokio::fs::write(&parent, "existing fixture").await.unwrap();
        let path = parent.join("monitor.log");
        append_line(path.to_str().unwrap(), "must not be written").await;
        assert!(!path.exists());
        assert_eq!(
            tokio::fs::read_to_string(parent).await.unwrap(),
            "existing fixture"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn untrusted_report_fields_strip_signed_sources_from_all_log_fields() {
        let source = "https://user:password@images.example/api/image_review/123?token=PRIVATE_TOKEN#fragment";
        let safe = "https://images.example/api/image_review/123";
        let payload: ReportPayload = serde_json::from_value(serde_json::json!({
            "type": "resource_error", "url": source,
            "message": format!("image failed {source} https://other.example/a.png?signature=SECOND_SECRET"),
            "stack": format!("at image {source}")
        })).unwrap();
        let (message, stack, url) = report_fields(&payload);
        assert_eq!(url, safe);
        assert_eq!(
            message,
            format!("image failed {safe} https://other.example/a.png")
        );
        assert_eq!(stack, format!("at image {safe}"));
        for value in [&message, &stack, &url] {
            for secret in ["PRIVATE_TOKEN", "SECOND_SECRET", "password", "fragment"] {
                assert!(!value.contains(secret));
            }
        }
    }

    #[test]
    fn report_urls_redact_inline_data_credentials_and_queries_without_losing_paths() {
        for source in [
            "data:image/svg+xml,<svg>PRIVATE_PIXELS</svg>",
            "blob:https://blog.example/PRIVATE_BLOB",
        ] {
            let payload: ReportPayload = serde_json::from_value(serde_json::json!({
                "type":"resource_error", "url":source,"message":format!("failed {source}"),"stack":source
            })).unwrap();
            let (message, stack, url) = report_fields(&payload);
            assert!(!format!("{message}{stack}{url}").contains("PRIVATE_"));
            assert!(url.ends_with(":[redacted]"));
        }
        assert_eq!(
            diagnostic_url("/article/54?preview=secret#section"),
            "/article/54"
        );
        assert_eq!(
            diagnostic_url("//user:password@images.example/a.png?token=secret"),
            "//images.example/a.png"
        );
        assert_eq!(
            diagnostic_url("https://[invalid?token=secret"),
            "[invalid-url]"
        );
        assert_eq!(
            diagnostic_text("metadata: unchanged", "", ""),
            "metadata: unchanged"
        );
        assert_eq!(
            diagnostic_text(
                "/api/image_review/123?token=secret //images.example/a?key=secret",
                "",
                ""
            ),
            "/api/image_review/123 //images.example/a"
        );
    }

    #[test]
    fn sanitized_fields_keep_existing_utf8_size_limits() {
        let payload: ReportPayload = serde_json::from_value(serde_json::json!({
            "type":"resource_error", "message":"汉".repeat(1000), "stack":"字".repeat(2000),
            "url":format!("/{}?token=PRIVATE_TOKEN", "a".repeat(600))
        }))
        .unwrap();
        let (message, stack, url) = report_fields(&payload);
        assert_eq!(message.len(), 1998);
        assert_eq!(stack.len(), 3999);
        assert_eq!(url.len(), 500);
        assert!(!url.contains("PRIVATE_TOKEN"));
    }

    /// ASCII 与多字节输入均按有效 UTF-8 边界截断。
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

    /// Controls and bidirectional formatting cannot forge terminal output;
    /// ordinary text and the character count remain unchanged.
    #[test]
    fn clean_strips_control_and_bidi() {
        let ansi = "\x1b[31mERROR\x1b[0m 伪造的红字";
        let cleaned = clean(ansi);
        assert!(!cleaned.chars().any(|c| c.is_control()), "{cleaned:?}");
        assert!(cleaned.contains("伪造的红字"));
        assert!(
            cleaned.contains("[31m"),
            "只换控制字符，正文照旧：{cleaned:?}"
        );

        assert_eq!(clean("a\tb\x7fc"), "a b c");
        assert_eq!(clean("a\u{202e}b\u{200b}c\u{feff}d"), "a b c d");

        // 长度不变（去重 key 与截断口径都按清洗后的串算）
        assert_eq!(clean(ansi).chars().count(), ansi.chars().count());

        // 普通中英文、数字和标点保持原样。
        let normal = "普通的一句「话」— 42% / path?a=1";
        assert_eq!(clean(normal), normal);
    }

    /// 写入告警窗口内合并计数，过期后恢复记录。
    #[test]
    fn write_warn_is_rate_limited() {
        let t0 = Instant::now();
        let (report, last, n) = warn_decision(None, 0, t0);
        assert!(report, "第一条必须记");
        assert_eq!(n, 0);

        // 窗口内：不记，被压条数累加
        let (report, last, n) = warn_decision(last, n, t0 + Duration::from_secs(1));
        assert!(!report);
        let (report, last, n) = warn_decision(last, n, t0 + Duration::from_secs(2));
        assert!(!report);
        assert_eq!(n, 2, "被压掉的两次要能被报出来");

        // 窗口一到：又记一条，计数归零
        let (report, _last, n) = warn_decision(last, n, t0 + WRITE_WARN_WINDOW);
        assert!(report, "窗口过后必须再记一条（否则盘满会变成彻底无声）");
        assert_eq!(n, 0);
    }

    /// 匿名 type 字段只接受封闭枚举，不能注入日志字段。
    #[test]
    fn kind_is_a_closed_enum() {
        assert_eq!(normalize_kind(Some("js_error")), "js_error");
        assert_eq!(normalize_kind(Some("http_status")), "http_status");
        assert_eq!(normalize_kind(None), "other");
        assert_eq!(normalize_kind(Some("SECAUDIT_FORGED")), "other");
        // 换行和空格不能扩展类型白名单。
        assert_eq!(
            normalize_kind(Some("js_error\n2026-01-01 ERROR x")),
            "other"
        );
        assert_eq!(normalize_kind(Some("js_error x")), "other");
        assert_eq!(normalize_kind(Some("JS_ERROR")), "other");
    }

    #[test]
    fn every_client_kind_passes_the_whitelist() {
        for k in [
            "session_init_fail",
            "confirm_card",
            "confirm_flow",
            "widget_tool_bind_timeout",
            "orphan_dom_drop",
            "widget_tool_fail",
            "live2d_load_fail",
            "react_error",
            "resource_error",
        ] {
            assert_eq!(normalize_kind(Some(k)), k, "{k} 不该被收敛成 other");
        }
    }

    /// 报告类型唯一，并采用小写 ASCII 字母、数字和下划线。
    #[test]
    fn whitelist_shape_is_sane() {
        let mut seen = std::collections::HashSet::new();
        for k in MONITOR_KINDS {
            assert!(seen.insert(k), "{k} 在白名单里出现了两次");
            assert!(
                !k.is_empty()
                    && k.chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{k} 不是小写字母数字下划线形状"
            );
        }
        assert_eq!(seen.len(), MONITOR_KINDS.len());
    }

    /// User-Agent 中的控制字符和超长内容不能破坏日志行。
    #[test]
    fn ua_is_cleaned_and_truncated() {
        assert_eq!(
            normalize_ua(Some("Mozilla/5.0 (X11; Linux)")),
            "Mozilla/5.0 (X11; Linux)"
        );
        assert_eq!(normalize_ua(None), "");
        assert_eq!(
            normalize_ua(Some("curl/8.5.0\r\nX-Forged: 1")),
            "curl/8.5.0  X-Forged: 1"
        );
        assert_eq!(normalize_ua(Some(&"u".repeat(500))).len(), 300);
        // 多字节 User-Agent 保持有效 UTF-8。
        assert_eq!(normalize_ua(Some(&"猫".repeat(200))).len(), 300);
    }

    /// 未知 WebGL 状态与明确不可用保持区分。
    #[test]
    fn webgl_absent_is_unknown_not_no() {
        use serde_json::json;
        assert_eq!(normalize_webgl(None), "unknown");
        assert_eq!(normalize_webgl(Some(&json!(true))), "yes");
        assert_eq!(normalize_webgl(Some(&json!(false))), "no");
        assert_eq!(normalize_webgl(Some(&json!("yes"))), "unknown");
        assert_eq!(normalize_webgl(Some(&json!(1))), "unknown");
        assert_eq!(normalize_webgl(Some(&serde_json::Value::Null)), "unknown");
    }

    /// 无效 webgl 值不影响其他载荷字段。
    #[test]
    fn bad_webgl_value_does_not_fail_the_whole_payload() {
        let p: ReportPayload =
            serde_json::from_str(r#"{"type":"js_error","message":"boom","webgl":"maybe"}"#)
                .expect("脏 webgl 不该让整条载荷反序列化失败");
        assert_eq!(normalize_kind(p.kind.as_deref()), "js_error");
        assert_eq!(normalize_webgl(p.webgl.as_ref()), "unknown");
    }

    /// 去重计数使用固定窗口，不随重复报告延后窗口起点。
    #[test]
    fn dedupe_counts_within_window_and_resets_after() {
        let mut m: HashMap<String, (Instant, u32)> = HashMap::new();
        let t0 = Instant::now();

        assert_eq!(dedupe_hit(&mut m, "a|b|c", t0), 1);
        assert_eq!(dedupe_hit(&mut m, "a|b|c", t0 + Duration::from_secs(1)), 2);
        assert_eq!(dedupe_hit(&mut m, "a|b|c", t0 + Duration::from_secs(59)), 3);
        // 不同 key 互不干扰
        assert_eq!(dedupe_hit(&mut m, "a|b|d", t0), 1);
        assert_eq!(dedupe_hit(&mut m, "a|b|c", t0 + Duration::from_secs(60)), 1);
        // 窗口重置后 old 那条已经过期（表里只剩新记录）
        assert_eq!(m.len(), 2);
        assert_eq!(m["a|b|c"].1, 1);
        assert_eq!(m["a|b|d"].1, 1);
    }
}
