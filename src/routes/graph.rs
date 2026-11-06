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

pub(crate) fn agent_base_url() -> String {
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

fn cache_key(query: &str, version: &str) -> String {
    format!("{version}:{}", query.to_lowercase())
}

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

pub async fn graph_query(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<GraphQueryReq>,
) -> impl IntoResponse {
    let (uid, role) = match assertion_actor(&state, &headers).await {
        Ok(v) => v,
        // 401 的响应体也保持 { ok:false, reason } 的形状，前端一个分支就能处理掉。
        // 拒因（没令牌 / 冻结 / 已收回）不细分：这条路径的前端行为是同一个降级分支。
        Err(_) => {
            return (StatusCode::UNAUTHORIZED, Json(GraphQueryResp::fail("login_required")));
        }
    };

    let q = req.q.trim();
    if q.is_empty() {
        return (StatusCode::OK, Json(GraphQueryResp::fail("empty_query")));
    }
    if q.chars().count() > QUERY_MAX {
        return (StatusCode::OK, Json(GraphQueryResp::fail("query_too_long")));
    }
    // A rebuild changes the embedding space and vocabulary together. Cache only
    // when its published manifest identifies the current snapshot.
    let version = tokio::fs::read(artifact_dir().join("manifest.json")).await.ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("v").and_then(|v| v.as_str()).map(str::to_owned));
    let key = version.as_deref().map(|version| cache_key(q, version));
    if let Some(hit) = key.as_deref().and_then(cache_get) {
        info!(q = %q, "graph: 命中查询缓存");
        return (StatusCode::OK, Json(hit));
    }

    // 不传 trace_id：这条路径与对话无关，硬塞一个会让日志里出现无对话的 trace 目录
    let Some(url) = crate::ai_services::graph_endpoint("/graph/query") else {
        return (StatusCode::OK, Json(GraphQueryResp::fail("service_unavailable")));
    };
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);
    let sent = CLIENT
        .post(&url)
        .header("X-Agent-Assertion", crate::auth_jwt::create_agent_assertion(uid, role.as_deref()))
        .json(&serde_json::json!({ "q": q, "uid": uid }))
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
        if let Some(key) = key { cache_put(key, resp.clone()); }
    }
    (StatusCode::OK, Json(resp))
}



/// 博客持有展示产物；构建服务通过 GRAPH_ARTIFACT_DIR 共享目录发布。
fn artifact_dir() -> std::path::PathBuf {
    std::env::var("GRAPH_ARTIFACT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from("data/article-graph")
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


// 后台重建的代理（浏览器 → Rust → agent 8010）
//
// 挂 `protected_routes`（auth_guard 已经保证只有管理员进得来）。这里再以**发起人身份**
// 现签一张断言给 agent —— agent 侧 `_require_console` 拿它判 `admin.console`。
// 「谁点的」因此原样传到 agent，Rust 不持有任何 agent 侧凭据（同 `/review` 那条链路）。

const REBUILD_TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

async fn assertion_actor(state: &Arc<AppState>, headers: &HeaderMap) -> Result<(i32, Option<String>), String> {
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
    let (uid, role) = assertion_actor(state, headers).await?;
    let url = crate::ai_services::graph_endpoint(path)
        .ok_or_else(|| "图谱服务未配置".to_string())?;
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
        if let Ok((uid, _)) = assertion_actor(&state, &headers).await {
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

#[cfg(test)]
mod snapshot_cache_tests {
    use super::{cache_get, cache_key, cache_put, GraphQueryResp, Hit};

    #[test]
    fn rebuilds_cannot_reuse_previous_snapshot_results() {
        let query = "snapshot-cache-test";
        cache_put(cache_key(query, "build-a"), GraphQueryResp {
            ok: true, reason: None, words: vec![Hit { w: "word".into(), s: 0.9 }],
        });
        assert!(cache_get(&cache_key(&query.to_uppercase(), "build-a")).is_some());
        assert!(cache_get(&cache_key(query, "build-b")).is_none());
    }
}
