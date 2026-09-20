use axum::{
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode, header},
    middleware::Next,
    response::Response,
};
use sea_orm::EntityTrait;
use std::sync::Arc;
use std::time::Instant;
use tracing::info;
use crate::routes::AppState;
use crate::entity::user;

/// 全局 HTTP access 日志（20260830，监控补齐 A）：
/// 每请求一条 `http method= path= status= ms=`，博客主流量（文章/搜索/留言）从此在
/// rust.log 可见。挂载在最外层（routes/mod.rs `.layer(cors)` 之后追加），不碰 body——
/// /api/chat/stream 的 DiscardAbortedExchange Drop guard 依赖 body 流原样透传。
/// 语义：ms 为到响应头就绪的耗时（SSE 流式路径是 TTFB，非全流时长，与 TraceLayer 一致）。
pub async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let t0 = Instant::now();
    let resp = next.run(req).await;
    let ms = t0.elapsed().as_millis();
    // 探针噪音过滤：healthcheck 每分钟 GET /api/login → 405（存活已由 health.log 记录）
    if !(method == Method::GET && path == "/api/login") {
        info!(method = %method, path = %path, status = %resp.status().as_u16(), ms = ms, "http");
    }
    resp
}

pub async fn auth_guard(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok());

    match auth_header {
        Some(token) => {
            let clean_token = token.strip_prefix("Bearer ").unwrap_or(token);
            if let Some(claims) = crate::auth_jwt::verify_token(clean_token) {
                // 从数据库校验用户角色，而非信任 JWT 中的 role
                // 判据收敛到 authz::can_access_console（20260920）：角色取值域与
                // 准入规则只在 src/authz.rs 声明一处，别再内联字面量
                let user_db = user::Entity::find_by_id(claims.sub)
                    .one(&state.db)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                match user_db {
                    Some(u) if crate::authz::can_access_console(&u.role) => Ok(next.run(req).await),
                    Some(_) => Err(StatusCode::FORBIDDEN),
                    None => Err(StatusCode::UNAUTHORIZED),
                }
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
