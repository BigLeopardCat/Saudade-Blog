//! 首页展示柜「文章向量空间」的查询代理（20260915）。
//!
//! 浏览器 → `POST /api/public/graph/query` → 本模块 → agent `127.0.0.1:8010/graph/query`
//!
//! 两件事和别的公开接口不一样：
//!
//! 1. **挂 public_routes 但 handler 自己要求登录**。不能挂 protected_routes——那条
//!    链路是给后台管理用的（auth_guard 全 admin），而这里任何登录用户都该能用；
//!    也不能真的公开——查询每次要花一次 embedding 调用，匿名可刷就是费用敞口。
//!    mentions 的 `current_uid` 惯用法（talks.rs）正好合适：无 token → 401。
//! 2. **失败一律 HTTP 200 + `ok:false`**。这是个可降级端点：前端拿到非 ok 就退回
//!    本地关键词匹配，用户照样能定位（只是邻居没那么准）。返回 5xx 只会让浏览器
//!    控制台多一堆红字，还是一样的降级结果。

use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

use sea_orm::EntityTrait;

use crate::utils::ApiResponse;

use crate::routes::AppState;

/// 查询串上限。**防匿名刷费用**：一个查询一次 embedding 调用，
/// 长文本既贵又对「定位到最近的词」毫无帮助（图谱词表最长也就 4~5 字）。
const QUERY_MAX: usize = 64;
/// agent 硬超时。embedding 端点稳态 ~100ms，6s 是很宽的余量。
/// **必须比 agent 自己那 5s 的 embedding 超时更长**——否则这里先掐断，
/// agent 已经判定的 ok=false 就传不回来，白白丢掉一个更精确的失败原因。
/// 超时/失败一律降级成 `agent_unavailable`，绝不让首页挂着一个慢请求。
/// ⚠ 前端 AbortController 的超时必须比本值更长（见 wordgraph/locate.ts）。
const AGENT_TIMEOUT: Duration = Duration::from_secs(6);
/// 结果缓存 TTL。图谱是静态产物、embedding 是确定性的，同一个 query 反复查没有意义。
const CACHE_TTL: Duration = Duration::from_secs(600);
/// 缓存条数上限。到顶先清过期，再清不动就整体丢掉重来（**绝不让它无界增长**：
/// 匿名可写的 key 空间不能是内存敞口）。
const CACHE_MAX: usize = 500;

#[derive(Deserialize)]
pub struct GraphQueryReq {
    pub q: String,
}

#[derive(Serialize, Clone)]
pub struct Hit {
    pub w: String,
    pub s: f64,
}

#[derive(Serialize, Clone)]
pub struct GraphQueryResp {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub words: Vec<Hit>,
}

impl GraphQueryResp {
    fn fail(reason: &str) -> Self {
        Self { ok: false, reason: Some(reason.to_string()), words: Vec::new() }
    }
}

/// 从请求头取用户 id。与 talks.rs 的 current_uid 同款（同样是 `auth_jwt::auth_uid`
/// 的薄壳，20260926 起含**查库判冻结与令牌代次**）；这里 None 不是"游客"而是
/// **拒绝**——查询只对登录用户开放。
async fn current_uid(db: &sea_orm::DatabaseConnection, headers: &HeaderMap) -> Option<i32> {
    crate::auth_jwt::auth_uid(db, headers).await.ok()
}

/// agent 基址：AGENT_URL 的语义是「非流式对话端点」（chat.rs 直接 post 它），
/// 默认 `http://127.0.0.1:8010/chat`。这里要的是基址，所以把尾部的
/// `/chat`、`/chat/stream` 剥掉。**不动那个环境变量、不动 chat.rs**——
/// 改语义会波及对话主链路，风险远大于这里省几行。
fn agent_base_url() -> String {
    let raw = std::env::var("AGENT_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8010/chat".to_string());
    let trimmed = raw.trim_end_matches('/');
    for suffix in ["/chat/stream", "/chat"] {
        if let Some(base) = trimmed.strip_suffix(suffix) {
            return base.trim_end_matches('/').to_string();
        }
    }
    trimmed.to_string()
}

// 10 分钟 / 500 条的结果缓存。**不动 AppState**（那要改 main.rs）——
// 一个进程级全局就够了，它的生命周期本来就该和进程一样。
static CACHE: LazyLock<Mutex<HashMap<String, (Instant, GraphQueryResp)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cache_get(key: &str) -> Option<GraphQueryResp> {
    let mut g = CACHE.lock().ok()?;
    match g.get(key) {
        Some((at, resp)) if at.elapsed() < CACHE_TTL => Some(resp.clone()),
        Some(_) => { g.remove(key); None }
        None => None,
    }
}

fn cache_put(key: String, resp: GraphQueryResp) {
    let Ok(mut g) = CACHE.lock() else { return };
    if g.len() >= CACHE_MAX {
        let now = Instant::now();
        g.retain(|_, (at, _)| now.duration_since(*at) < CACHE_TTL);
        if g.len() >= CACHE_MAX {
            warn!(n = g.len(), "graph: 查询缓存到顶且无可清理项，整体清空");
            g.clear();
        }
    }
    g.insert(key, (Instant::now(), resp));
}

/// `POST /api/public/graph/query` — 查询串 → 图谱里最近的词。
/// 未登录 401（这是唯一一处会返回非 200 的情况）；其余一律 200 + ok=false。
pub async fn graph_query(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<GraphQueryReq>,
) -> impl IntoResponse {
    if current_uid(&state.db, &headers).await.is_none() {
        // 401 的响应体也保持 { ok:false, reason } 的形状，前端一个分支就能处理掉
        return (StatusCode::UNAUTHORIZED, Json(GraphQueryResp::fail("login_required")));
    }

    let q = req.q.trim();
    if q.is_empty() {
        return (StatusCode::OK, Json(GraphQueryResp::fail("empty_query")));
    }
    if q.chars().count() > QUERY_MAX {
        return (StatusCode::OK, Json(GraphQueryResp::fail("query_too_long")));
    }
    let key = q.to_lowercase();
    if let Some(hit) = cache_get(&key) {
        info!(q = %key, "graph: 命中查询缓存");
        return (StatusCode::OK, Json(hit));
    }

    // 不传 trace_id：这条路径与对话无关，硬塞一个会让日志里出现无对话的 trace 目录
    let url = format!("{}/graph/query", agent_base_url());
    let sent = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "q": q }))
        .timeout(AGENT_TIMEOUT)
        .send()
        .await;

    let resp = match sent {
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(v) => {
                let words: Vec<Hit> = v["words"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|it| {
                                Some(Hit {
                                    w: it["w"].as_str()?.to_string(),
                                    s: it["s"].as_f64().unwrap_or(0.0),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if v["ok"].as_bool().unwrap_or(false) && !words.is_empty() {
                    GraphQueryResp { ok: true, reason: None, words }
                } else {
                    GraphQueryResp::fail(v["reason"].as_str().unwrap_or("agent_declined"))
                }
            }
            Err(e) => {
                warn!(error = %e, "graph: agent 响应不是合法 JSON");
                GraphQueryResp::fail("agent_bad_response")
            }
        },
        Ok(r) => {
            warn!(status = %r.status(), "graph: agent 返回非 2xx");
            GraphQueryResp::fail("agent_unavailable")
        }
        Err(e) => {
            warn!(error = %e, url = %url, "graph: 请求 agent 失败");
            GraphQueryResp::fail("agent_unavailable")
        }
    };

    // 只缓存成功结果：把一次瞬时故障钉成 10 分钟的"不可用"毫无道理
    if resp.ok {
        cache_put(key, resp.clone());
    }
    (StatusCode::OK, Json(resp))
}


// ═══════════════════════════════════════════════════════════════════════════
// 图谱产物的供给与后台重建（20261003 用户第 2 条）
// ═══════════════════════════════════════════════════════════════════════════
//
// **要解决的问题**：产物原本写在 `frontend/public/graph/`，而 nginx 直服的是
// `frontend/dist` —— 中间隔着一次 `vite build`。于是"在后台点一下重建"这件事
// 走不通：服务端写的文件到不了浏览器，而且下一次 CI 部署的 dist 差集清理还会把
// `dist/graph` 换回仓库里的旧版（**静默回退成旧图**）。
//
// **现在的分工**：重建任务把产物写进 agent 自己的 `data/word_graph/web/`，由这两个
// 公开端点供出去；committed 的 `frontend/public/graph/*` 退化为"从没重建过的站点"
// 的种子（前端拿不到 manifest 就回落静态那份，见 `loader.ts`）。
//
// **为什么 nginx 不用改**：两个 443 块里都是 `location ^~ /api/`（`^~` ⇒ 跳过所有
// 正则 location），所以 `/api/public/graph/artifact/graph-xxx.js` 的 Content-Type 与
// Cache-Control **完全由这里决定**，不会被 `\.(js|css|json)$` 那条抢走。
// ⚠️ 日后若有人加一条能匹配 `/api/...js` 的正则 location，它会抢在 `^~ /api/` 之前
// ——那时这里设的头全部失效（症状是产物被 no-store、或类型变成 text/html）。

/// 展示产物目录。默认指向 agent 那个目录（重建任务写的就是它）；
/// 换机器/换布局时用 `GRAPH_ARTIFACT_DIR` 覆盖。
fn artifact_dir() -> std::path::PathBuf {
    std::env::var("GRAPH_ARTIFACT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from("/home/ubuntu/Saudade-Blog/saudade-blog-agent/data/word_graph/web")
        })
}

/// 产物文件名是否合法：`graph-<8 位以上 [A-Za-z0-9_-]>.js`。
///
/// **这是安全判据，不是格式洁癖**：文件名来自 URL，直接拼进路径就是目录穿越
/// （`../../.env`）。约束成"前缀 + 白名单字符 + .js"之后，`.`/`/` 结构性地进不来，
/// 所以这里**不需要**再单独判 `..`。规则与前端 `loader.ts` 里那条必须一致
/// （改一处要改两处——`wordgraph-artifact.test.mjs` 钉着这一对）。
fn valid_artifact_name(name: &str) -> bool {
    let Some(mid) = name.strip_prefix("graph-").and_then(|s| s.strip_suffix(".js")) else {
        return false;
    };
    mid.len() >= 8
        && mid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `GET /api/public/graph/manifest` —— 当前产物的清单（一百多字节，不缓存）。
///
/// 没有服务端产物时返回 **200 + `{}`**，不是 404。理由与 `/graph/query` 那条
/// "可降级端点一律 200"完全相同，且这里更严重：**首页每次加载都会问一次这个端点**，
/// 一个从没重建过的站点（正是"别人 clone 下去直接部署"的那一类）会让每个访客的控制台
/// 每次都多一条 `Failed to load resource: 404` 的红字。而这是可降级端点：读不到就回落
/// 仓库里的静态种子，用户照样看得到图 —— 失败不该长成错误的样子。
///
/// 契约：**`file` 字段缺席（不是空串）就是"本站还没有服务端产物"**，前端据此回落。
/// 真读出错（权限、IO）才 500，与"文件不存在"分开。
pub async fn graph_manifest() -> Response {
    let path = artifact_dir().join("manifest.json");
    match tokio::fs::read(&path).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            // no-store：这份文件**会被重建覆盖**（同名文件内容变），
            // 缓存住就等于"重建完首页还是旧图"，且没有任何办法察觉
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(Body::from(bytes))
            .unwrap(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            info!(path = %path.display(), "graph: 本站还没有服务端产物，前端将回落静态种子");
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from("{}"))
                .unwrap()
        }
        Err(e) => {
            warn!(error = %e, path = %path.display(), "graph: 读 manifest 失败");
            (StatusCode::INTERNAL_SERVER_ERROR, "manifest unreadable").into_response()
        }
    }
}

/// `GET /api/public/graph/artifact/:file` —— 产物 JS 本体。
///
/// 强缓存一年 + `immutable`：文件名里带 build_id（内容变了名字就变），所以这就是
/// 教科书上的"内容寻址"，不必担心改不回来。`nosniff` 是给"万一被当 HTML 解析"
/// 加的——这份内容由**服务端建图脚本**生成、又直接进浏览器执行，值得多一道。
pub async fn graph_artifact(Path(file): Path<String>) -> Response {
    if !valid_artifact_name(&file) {
        warn!(file = %file, "graph: 产物文件名不合法（拒目录穿越）");
        return (StatusCode::NOT_FOUND, "bad name").into_response();
    }
    let path = artifact_dir().join(&file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            // text/javascript（不是 application/javascript）：前者才是 ES module
            // 动态 import 在各浏览器上都有明确定义的那个类型
            .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header("X-Content-Type-Options", "nosniff")
            .body(Body::from(bytes))
            .unwrap(),
        Err(e) => {
            warn!(error = %e, path = %path.display(), "graph: 产物文件读不到");
            (StatusCode::NOT_FOUND, "no artifact").into_response()
        }
    }
}


// ── 后台重建的代理（浏览器 → Rust → agent 8010）───────────────────────────
//
// 挂 `protected_routes`（auth_guard 已经保证只有管理员进得来）。这里再以**发起人身份**
// 现签一张断言给 agent —— agent 侧 `_require_console` 拿它判 `admin.console`。
// 「谁点的」因此原样传到 agent，Rust 不持有任何 agent 侧凭据（同 `/review` 那条链路）。

const REBUILD_TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// 取 uid 与角色。**角色查库、不信登录 token 里的**（与 chat.rs:323、
/// middleware::auth_guard 同一条纪律）；查不到人时给 None ⇒ agent 侧按身份不明拒。
async fn console_actor(state: &Arc<AppState>, headers: &HeaderMap) -> Result<(i32, Option<String>), String> {
    let uid = crate::auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|e| e.message().to_string())?;
    let role = crate::entity::user::Entity::find_by_id(uid)
        .one(&state.db)
        .await
        .ok()
        .flatten()
        .map(|u| u.role);
    Ok((uid, role))
}

async fn call_agent(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<(StatusCode, serde_json::Value), String> {
    let (uid, role) = console_actor(state, headers).await?;
    let url = format!("{}{}", agent_base_url(), path);
    let mut req = reqwest::Client::new()
        .request(method, &url)
        .header("X-Agent-Assertion", crate::auth_jwt::create_agent_assertion(uid, role.as_deref()))
        .timeout(timeout);
    if let Some(b) = body {
        req = req.json(&b);
    }
    match req.send().await {
        Ok(r) => {
            // reqwest 的 StatusCode 与 axum 的是两个类型，显式转一次（别在这里
            // 把状态码丢掉——"agent 说 403"与"agent 不可达"给用户的建议完全不同）
            let status = StatusCode::from_u16(r.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let v = r.json::<serde_json::Value>().await.unwrap_or(serde_json::json!({}));
            Ok((status, v))
        }
        Err(e) => {
            warn!(error = %e, url = %url, "graph: 请求 agent 重建端点失败");
            Err(format!("agent 不可达：{e}"))
        }
    }
}

/// `POST /api/protected/graph/rebuild` —— 起一次重建 / 环境预检（非阻塞）。
///
/// `uid` 一并透传给 agent：那条链路的身份断言才是权威（agent 会用断言里的 uid
/// 覆盖 body 里的），这里带上只是为了让旧档（AGENT_REQUIRE_ASSERTION=0）也能用。
pub async fn rebuild_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut body): Json<serde_json::Value>,
) -> Json<ApiResponse<serde_json::Value>> {
    if let Some(obj) = body.as_object_mut() {
        if let Ok((uid, _)) = console_actor(&state, &headers).await {
            obj.insert("uid".into(), serde_json::json!(uid));
        }
    }
    match call_agent(&state, &headers, reqwest::Method::POST, "/graph/rebuild", Some(body), REBUILD_TIMEOUT).await {
        Ok((status, v)) if status.is_success() => {
            if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                Json(ApiResponse::success(v))
            } else {
                // 拒因（busy / low_memory / uv_missing）原样上抛给页面：
                // 它们各自要不同的处置建议，包成一句"操作失败"等于把信息丢掉
                Json(ApiResponse::error(
                    v.get("error").and_then(|x| x.as_str()).unwrap_or("无法开始重建"),
                ))
            }
        }
        Ok((status, _)) => Json(ApiResponse::error(&format!("agent 拒绝（HTTP {}）", status.as_u16()))),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// `GET /api/protected/graph/rebuild/status` —— 轮询任务进度（含日志尾部）。
pub async fn rebuild_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<serde_json::Value>> {
    match call_agent(&state, &headers, reqwest::Method::GET, "/graph/rebuild/status", None, STATUS_TIMEOUT).await {
        Ok((status, v)) if status.is_success() => Json(ApiResponse::success(v)),
        Ok((status, _)) => Json(ApiResponse::error(&format!("agent 拒绝（HTTP {}）", status.as_u16()))),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}

/// `POST /api/protected/graph/rebuild/cancel` —— 取消当前任务。
pub async fn rebuild_cancel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<serde_json::Value>> {
    match call_agent(&state, &headers, reqwest::Method::POST, "/graph/rebuild/cancel", Some(serde_json::json!({})), REBUILD_TIMEOUT).await {
        Ok((status, v)) if status.is_success() => {
            let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
            let payload = if ok {
                serde_json::json!({ "cancelled": true, "signal": v.get("signal") })
            } else {
                serde_json::json!({ "cancelled": false, "reason": v.get("reason") })
            };
            Json(ApiResponse::success(payload))
        }
        Ok((status, _)) => Json(ApiResponse::error(&format!("agent 拒绝（HTTP {}）", status.as_u16()))),
        Err(e) => Json(ApiResponse::error(&e)),
    }
}


#[cfg(test)]
mod artifact_name_tests {
    use super::valid_artifact_name;

    /// 文件名来自 URL —— 这是一条**安全判据**，不是格式洁癖。
    /// 用例里的每一个"坏名字"都是真能被拼进路径的输入。
    #[test]
    fn rejects_traversal_and_junk() {
        for bad in [
            "../../.env",                        // 目录穿越（最要命的一个）
            "graph-1d1323374540.js/../../.env",  // 前缀对、后缀对，中间带斜杠
            "/etc/passwd",
            "graph-..%2f..%2f.env.js",           // 编码后的穿越：`%` 不在白名单里
            "graph-short.js",                    // id 不足 8 位（与前端那条正则同步）
            "graph-1d1323374540.ts",             // 扩展名不是 .js
            "manifest.json",                     // 白名单之外的文件一律不放行
            "graph-1d1323374540.js.js",          // 双后缀：strip_prefix/suffix 后中间段带 `.`
            "",
        ] {
            assert!(!valid_artifact_name(bad), "应当拒绝：{bad}");
        }
    }

    #[test]
    fn accepts_real_artifact_names() {
        assert!(valid_artifact_name("graph-1d1323374540.js"));
        assert!(valid_artifact_name("graph-ABCDEFGH.js"));
        assert!(valid_artifact_name("graph-ab_cd-ef12.js"));
    }
}
