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
//
// 20261004 复核（前端日志「无效状态」那一轮）：
//   - `type` 白名单补到与客户端实际清单一一对应（见 MONITOR_KINDS 头注）；
//   - 载荷新增 `ua`（服务端从请求头取，客户端伪造不了）与 `webgl` 标记——今天那批
//     `Texture loading error` 究竟是真实访客还是无 GPU 的爬虫，原来从落盘行里分不出来；
//   - 服务端按 `type|msg 前 80 字|url` 做 60 秒窗口计数（`dup=N`），跨访客生效：
//     同一个 bug 被一百个访客各报一次，落盘仍是一行 + 计数，而不是一百行把真线索冲掉。
//
// 落盘行的字段顺序**是对账侧的契约**（`saudade-blog-agent/eval/trace_reconcile.py` 按
// 位置解析 `type=`/`uid=`）。新增字段一律**追加在行尾**，旧解析器因此不受影响。

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Write;
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
    /// 类型故意是 `Value` 而不是 `Option<bool>`：这个端点**匿名可写**，`webgl: "yes"`
    /// 之类的坏值若让 serde 在整条载荷上失败，一条真实错误就被 400 吞掉了——局部
    /// 字段的脏值不该有能力毁掉整条记录。缺席（老客户端）与脏值一律记 `unknown`，
    /// **不猜成 `no`**（与「缺键绝不编 0」同一条纪律：unknown 与 no 是两件事）。
    #[serde(default)]
    pub webgl: Option<serde_json::Value>,
}

/// 换行清洗：错误消息/堆栈可能含 \n，一行一记录保证 grep 语义
fn clean(s: &str) -> String {
    s.replace(['\n', '\r'], " ")
}

/// 前端上报器实际会发的 type —— **这份清单是客户端清单的镜像，不是我们自己挑的子集**。
///
/// `type` 必须收敛成可枚举值（20260925 审计 A2）：这里原先把 `payload.kind` 原样拼进
/// 落盘行，而它是**匿名可写**的字段 ⇒ 任何访客能整行伪造（自定时间戳/级别/`uid=`），
/// 且伪造行会把真实那条记录的 uid/url/msg/stack 全冲到伪造行末尾（真线索被毁）。
/// 白名单比清洗彻底：清洗只挡换行，白名单让 `type=` 变成可枚举字段——对账侧
/// （`eval/trace_reconcile.py` 按 `type=` 分类）因此能把"未知 type"直接标成可疑。
///
/// ⚠️ 关键在于清单要**跟得上**：审计当时只登记了 `boot.js` 那五种，而客户端随后
/// （20260924–20261003）又加了七种（`chat-stream.js` / `chat-engine.js` / `renderer.js`），
/// 白名单没跟着涨 ⇒ 生产 `monitor.log` 里 `type=other` 占了 66%（193/292 行），
/// 那些行**看不出是哪一类故障**。「可枚举」这个前提就是这么无声失效的：白名单把
/// 未知值收敛成 other，于是"漏登记"看起来和一个真·未知类型一模一样。
/// 防漂由 `frontend/tests/monitor-report.test.mjs` 钉住（扫客户端源码里的上报点
/// 与这份数组逐字比对），改客户端 type 而没改这里会**当场变红**。
///
/// 顺序 = 客户端文件序，便于人工对照：
/// `boot.js`（前六）→ `chat-stream.js` → `chat-engine.js` → `renderer.js` → SPA 侧。
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
    // SPA（src/utils/report.ts / components/ErrorBoundary）—— 20261004 补
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
    // 带 token 时解析 uid，无则 guest（访客错误同样值得记录）——headers 须在 into_body 前读。
    // 20260926：身份走同一个出口 ⇒ 冻结/令牌被收回的账号在这里也归 guest（它确实已经
    // 不是"登录中的用户"了）。这条端点本就匿名可写，**uid 只是日志归属**、不授予任何能力；
    // 之所以仍然走查库那一版，是不给"绕过身份出口"留第二个先例（见 auth_jwt::auth_uid 头注）。
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
    // 20260830f：全量——截断放宽（message 2000/stack 4000，用户要求全量追踪 agent 问题）
    let msg = truncate(&clean(payload.message.as_deref().unwrap_or("")), 2000);
    let stack = truncate(&clean(payload.stack.as_deref().unwrap_or("")), 4000);
    // 20260925 审计：`url` 此前只清换行不截断 ⇒ 8KB body 内能占满整行（与 msg/stack 同一口径）
    let url = truncate(&clean(payload.url.as_deref().unwrap_or("")), 500);

    // 去重 key：只由**已清洗截断**的三个字段拼成（原始载荷进不来）⇒ 访客没法用超长
    // msg 掏空表，也没法把 uid/ua 拼进去制造互相干扰的 key。
    // `msg` 只取前 80 字：同一类错误的正文尾部常带变址（id/时间），全串相同才是少数。
    let dup = dedupe_count(&format!(
        "{kind}|{}|{url}",
        truncate(msg.as_str(), 80)
    ));

    let level = if kind == "http_status" { "WARN" } else { "ERROR" };
    let webgl = normalize_webgl(payload.webgl.as_ref());
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    // 字段顺序是对账契约：`type=`/`uid=` 后面**只能追加**，见文件头注。
    let line = format!(
        "{ts} {level} [monitor] type={kind} uid={uid} url={url} msg={msg} stack={stack} ua={ua} webgl={webgl} dup={dup}\n"
    );

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

    /// 白名单补全后，原来落成 `other` 的那七种必须能原样通过——这是 20261004 那次
    /// 「前端日志 66% 是 other」的直接回归锁（少一个就少一类故障的可见性）。
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
        assert_eq!(normalize_ua(Some("Mozilla/5.0 (X11; Linux)")), "Mozilla/5.0 (X11; Linux)");
        assert_eq!(normalize_ua(None), "");
        assert_eq!(normalize_ua(Some("curl/8.5.0\r\nX-Forged: 1")), "curl/8.5.0  X-Forged: 1");
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
        let p: ReportPayload = serde_json::from_str(
            r#"{"type":"js_error","message":"boom","webgl":"maybe"}"#,
        )
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
