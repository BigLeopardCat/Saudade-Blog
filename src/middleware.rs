use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
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

/// `/api/protect/download/` 出图侧的响应头加固（20261006，用户第 2 条）。
///
/// 这条路由把 `<UPLOAD_DIR>` 整个目录**公开、无鉴权**地直出（`ServeDir`），而
/// content-type 是 `ServeDir` **按后缀猜**的 —— 猜错的表现不只是"图打不开"：
/// 一个叫 `x.html` 的文件会在这里、在这个域下被当 HTML 渲染，同源 XSS 就成立了。
/// 上传口那侧已经只收图片（后缀白名单 + 字节头，见 `utils::ALLOWED_IMAGE_EXTS`），
/// 这里是第二道闸，判据共用 `utils::is_image_path`：
///
/// · 非图路径 ⇒ `Content-Type: application/octet-stream` + `Content-Disposition: attachment`
///   （浏览器只会下载、绝不渲染）+ `X-Content-Type-Options: nosniff`；
/// · 图片路径 ⇒ 只补 `nosniff`（后缀与字节已在上传口对齐，这里堵的是"浏览器自作主张
///   嗅成别的类型"）。
///
/// **只动响应头，一个字节的 body 都不碰**：这条路由是出图主力（上行大头都在这里），
/// 任何缓冲/改写都会把内存和延迟一起抬上去。
///
/// 目录列表（`/api/protect/download/` 与 `/api/protect/download/avatars`）落在非图那侧
/// ⇒ 变成下载，不会在浏览器里列目录（`ServeDir` 本来也不列，这一层是顺带兜住）。
pub async fn download_headers(req: Request, next: Next) -> Response {
    let is_image = crate::utils::is_image_path(req.uri().path());
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    if !is_image {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
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
                    Some(u) => {
                        // 令牌有效性（20260926）：账号被冻结或令牌已被收回（改密码 /
                        // 管理员重置 / 冻结时 +1 了 token_version）一律按**未登录**处理。
                        //
                        // 这里回 401 而不是 403 是刻意的：403 的既有语义是"人还在、
                        // 只是不该进后台"（前端对它的处置是提示一句、留在原页），
                        // 而冻结/收回是"人已经不在线了"——401 才会让前端清掉本地令牌
                        // 并跳登录页。两种情况用一个判据点（authz::check_token），
                        // 但走的是各自该走的状态码。
                        if crate::authz::check_token(u.status, u.token_version, claims.ver).is_err() {
                            return Err(StatusCode::UNAUTHORIZED);
                        }
                        if crate::authz::can_access_console(&u.role) {
                            Ok(next.run(req).await)
                        } else {
                            Err(StatusCode::FORBIDDEN)
                        }
                    }
                    None => Err(StatusCode::UNAUTHORIZED),
                }
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
