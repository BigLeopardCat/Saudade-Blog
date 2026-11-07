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

/// 上报载荷（前端 boot.js 全局捕获打包；落盘时 message 截 2000 / stack 截 4000）。
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
    /// WebGL 可用性标记（前端探测后随载荷上报）。
    ///
    /// This anonymous endpoint retains valid report fields when webgl is malformed.
    /// Missing and invalid values remain unknown rather than claiming WebGL is absent.
    #[serde(default)]
    pub webgl: Option<serde_json::Value>,
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

/// 零宽 / 双向控制字符（Unicode `Cf` 里会改变终端观感的那一批）。
///
/// 只列"能在终端里把已打印文本重排/隐藏"的：ZWSP/ZWNJ/ZWJ、LRM/RLM、LRE…RLO、LRI…PDI、
/// 以及 BOM。它们不是控制字符（`is_control()` 判不出来），但危害与 ANSI 转义同类。
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

/// `User-Agent` 归一：清换行 + 截 300 字节。
///
/// 它是**请求头**、不是载荷里的字段 ⇒ 访客没法在 JSON 里伪造它（伪造只能改自己发的
/// 头，那是另一回事：它仍然如实描述了"谁在报"）。但正因为它来自客户端，照样要清洗
/// 截断——头里塞换行就能整行伪造，这条纪律与 `type` 一样。
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

/// 去重决策的**纯函数**内核（`now` 注入 ⇒ 窗口过期能被测到，不用 sleep）。
///
/// 语义：**固定窗口**——命中一次就记下第一次的时间戳，窗口内再来只加计数、**不推后**时间戳。
/// 因此持续发生的错误每 60 秒会重新落一行（"现在还在发生"看得见），而不是永远只留第一行。
/// 返回本次落盘行应记的 `dup`：首次 1，之后 2、3…
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

/// 全局去重表的加锁入口。
///
/// **跨访客**去重（key 里不含 uid）：同一个 bug 一百个访客各报一次，落盘仍是一行 + 计数。
/// 代价要记住：第一个报的人决定了这一行的 uid/ua，后来者的身份不落盘——所以 `dup>1`
/// 是"至少这么多访客/次数"，不是"这个人报了 N 次"。
///
/// 表满了先按窗口过期清理；清完还满就整体清空（宁可丢窗口也不能让内存无界增长）。
/// 这把锁只在同步的极小临界区里持有、里面没有 `.await` ⇒ 不会卡住 tokio worker。
fn dedupe_count(key: &str) -> u32 {
    static TABLE: OnceLock<Mutex<HashMap<String, (Instant, u32)>>> = OnceLock::new();
    let table = TABLE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    // 锁中毒（某个线程在临界区里 panic）⇒ 退化成不去重，但**绝不吞掉这条上报**。
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

    // UA 与 uid 同理：必须在 `into_body()` 之前从 headers 取出（之后 req 只剩 body）。
    let ua = normalize_ua(
        req.headers()
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
    );

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
    let msg = truncate(&clean(payload.message.as_deref().unwrap_or("")), 2000);
    let stack = truncate(&clean(payload.stack.as_deref().unwrap_or("")), 4000);
    let url = truncate(&clean(payload.url.as_deref().unwrap_or("")), 500);

    // 去重 key：只由**已清洗截断**的三个字段拼成（原始载荷进不来）⇒ 访客没法用超长
    // msg 掏空表，也没法把 uid/ua 拼进去制造互相干扰的 key。
    // `msg` 只取前 80 字：同一类错误的正文尾部常带变址（id/时间），全串相同才是少数。
    let dup = dedupe_count(&format!("{kind}|{}|{url}", truncate(msg.as_str(), 80)));

    let level = if kind == "http_status" {
        "WARN"
    } else {
        "ERROR"
    };
    let webgl = normalize_webgl(payload.webgl.as_ref());
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    // 字段顺序是对账契约：`type=`/`uid=` 后面**只能追加**，见文件头注。
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

/// 落盘失败的 WARNING 间隔。
///
/// 限频是必需的：盘满时**每一条上报都会失败**，不限频就会用 WARNING 把 `rust.log`
/// 也写满（次生灾害：真线索被淹没在同一个错误的重复里）。语义与 `dedupe_count` 同族——
/// 固定窗口，窗口内只记第一条，被压掉的条数在下一个窗口的首条里报出来。
const WRITE_WARN_WINDOW: Duration = Duration::from_secs(60);

/// 限频决策（纯函数，`now` 注入 ⇒ 窗口行为可测，不用 sleep）。
/// 返回 `(这次记不记, 新的 last, 新的被压条数)`。
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
    // 锁中毒（临界区里 panic）⇒ 退化成不限频地记一条，**绝不因为"限频器坏了"而不留痕**。
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

    /// 两种边界输入：ASCII 落在边界（对照）与多字节落在字符中间（回归点）。
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

        // 反控：正常中英数标点原样通过（换错就是"把真日志改花"）
        let normal = "普通的一句「话」— 42% / path?a=1";
        assert_eq!(clean(normal), normal);
    }

    /// 审计 SAU-022：落盘失败的限频决策。
    ///
    /// 窗口内只记第一条、被压掉的条数在下一条里报出来；窗口一过又能记。
    /// 反控：把窗口判据去掉（永远记）⇒ 第三条断言当场红。
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

    /// 审计 A2：`type` 是匿名可写字段，原样插值可被整行伪造。
    #[test]
    fn kind_is_a_closed_enum() {
        assert_eq!(normalize_kind(Some("js_error")), "js_error");
        assert_eq!(normalize_kind(Some("http_status")), "http_status");
        assert_eq!(normalize_kind(None), "other");
        assert_eq!(normalize_kind(Some("SECAUDIT_FORGED")), "other");
        // 换行与空格都不许把值撑出白名单（审计那条伪造行就是靠 \n 撑进来的）
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

    /// 清单本身不许有重复项：重复项不会报错，只会让"清单长度 = 类型数"这个前提悄悄失真
    /// （前端那条防漂测试按集合比对，重复项会让两边看起来一致而实际各少一种）。
    /// 顺带钉住形状：小写 ASCII 字母 / **数字** / 下划线——数字这一格必须有，
    /// `live2d_load_fail` 里就带着个 `2`（前端那条提取规则 `monitor-report.test.mjs`
    /// 的头注写明了"写成 `[a-z_]+` 会静默漏掉它"）：两边必须是同一个形状，
    /// 否则防漂测试会一边漏、一边不认。
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

    /// `ua` 是请求头来的、一样是客户端可控 ⇒ 清洗截断一条不能少（头里塞 `\n` 能整行伪造）。
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
        // 多字节也要落在字符边界上（复用 truncate 的那条回归锁）
        assert_eq!(normalize_ua(Some(&"猫".repeat(200))).len(), 300);
    }

    /// 缺席与脏值都是 `unknown`：`unknown`（没说）与 `no`（探针说不可用）是两件事，
    /// 混起来会让"多少访客没有 WebGL"这个数凭空变大。
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

    /// 局部脏值不许毁掉整条载荷：`webgl` 是 Value 而不是 bool 就是为了这个。
    #[test]
    fn bad_webgl_value_does_not_fail_the_whole_payload() {
        let p: ReportPayload =
            serde_json::from_str(r#"{"type":"js_error","message":"boom","webgl":"maybe"}"#)
                .expect("脏 webgl 不该让整条载荷反序列化失败");
        assert_eq!(normalize_kind(p.kind.as_deref()), "js_error");
        assert_eq!(normalize_webgl(p.webgl.as_ref()), "unknown");
    }

    /// 60 秒**固定**窗口：窗口内累加计数，窗口一过重新从 1 起。
    /// 断言"不推后时间戳"是有意的——推后的话持续发生的错误会永远停在第一行，
    /// "现在还在发生"就看不出来了。
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
