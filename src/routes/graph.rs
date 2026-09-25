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

use axum::{Json, extract::State, http::{HeaderMap, StatusCode}, response::IntoResponse};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

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
