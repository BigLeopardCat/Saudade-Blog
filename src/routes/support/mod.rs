//! Private customer consultations and the administrator support desk.
mod store;
use crate::{auth_jwt::auth_uid, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use sea_orm::DbErr;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use store::{Case, Details, Page};

#[derive(Clone, Copy)]
pub(super) enum Desk {
    Customer,
    Staff,
}

impl Desk {
    fn staff(self) -> bool {
        matches!(self, Self::Staff)
    }
    fn sender(self) -> &'static str {
        if self.staff() {
            "staff"
        } else {
            "customer"
        }
    }
}

pub(super) struct Failure(StatusCode, &'static str);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let body = ApiResponse {
            code: i32::from(self.0.as_u16()),
            message: self.1.into(),
            data: (),
        };
        (self.0, Json(body)).into_response()
    }
}
impl From<DbErr> for Failure {
    fn from(err: DbErr) -> Self {
        tracing::error!(error = %err, "support database operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "客服服务暂时不可用")
    }
}
type Result<T> = std::result::Result<T, Failure>;

fn limit_write(uid: i32) -> Result<()> {
    use crate::rate_limiter::LoginRateLimiter;
    use std::sync::LazyLock;
    static WRITES: LazyLock<LoginRateLimiter> = LazyLock::new(|| LoginRateLimiter::new(30, 60, 60));
    WRITES
        .hit("support", &uid.to_string())
        .map_err(|_| Failure(StatusCode::TOO_MANY_REQUESTS, "操作过于频繁，请稍后再试"))
}

fn missing() -> Failure {
    Failure(StatusCode::NOT_FOUND, "未找到这条客服记录")
}
fn conflict() -> Failure {
    Failure(StatusCode::CONFLICT, "记录已变化，请刷新后再试")
}
fn bad(message: &'static str) -> Failure {
    Failure(StatusCode::BAD_REQUEST, message)
}

async fn user(state: &AppState, headers: &HeaderMap) -> Result<i32> {
    auth_uid(&state.db, headers)
        .await
        .map_err(|e| Failure(StatusCode::UNAUTHORIZED, e.message()))
}

#[derive(Deserialize, Default)]
pub(super) struct Window {
    before: Option<i32>,
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Opening {
    kind: String,
    subject: String,
    body: String,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Change {
    action: String,
    #[serde(default)]
    body: String,
    version: i32,
    request_id: String,
}

fn key(raw: &str) -> Result<String> {
    uuid::Uuid::parse_str(raw)
        .map(|id| id.to_string())
        .map_err(|_| bad("缺少有效的请求编号"))
}

fn bounded(raw: &str, max: usize, message: &'static str) -> Result<String> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(bad(message));
    }
    Ok(value.to_owned())
}

async fn private_headers(mut res: Response) -> Response {
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    res
}

fn cases(desk: Desk) -> Router<Arc<AppState>> {
    let list_route = if desk.staff() {
        get(list)
    } else {
        get(list).post(open)
    };
    Router::new()
        .route("/cases", list_route)
        .route("/cases/{id}", get(detail))
        .route("/cases/{id}/events", post(change))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(Extension(desk))
        .layer(middleware::map_response(private_headers))
}

pub fn customer_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/public/support/topics", get(topics))
        .nest("/api/protected/support", cases(Desk::Customer))
}

pub fn staff_routes() -> Router<Arc<AppState>> {
    Router::new().nest("/api/protected/admin/support", cases(Desk::Staff))
}

#[derive(Serialize)]
struct Topic {
    id: &'static str,
    question: &'static str,
    answer: &'static str,
    href: &'static str,
    keywords: &'static [&'static str],
}
const TOPICS: &[Topic] = &[
    Topic {
        id: "find-article", question: "怎样找到以前读过的文章？",
        answer: "进入归档按时间浏览，记得标题或关键词时也可以使用顶部的搜索。", href: "/times",
        keywords: &["文章", "以前", "归档", "搜索", "找回", "archive", "article", "search"],
    },
    Topic {
        id: "guestbook", question: "留言和私下联系客服有什么区别？",
        answer: "留言板用于公开交流。需要私下反馈时，用看板娘的「问题反馈」提交咨询。", href: "/guestbook",
        keywords: &["留言", "私下", "公开", "私密", "guestbook", "private", "public"],
    },
    Topic {
        id: "follow-ticket", question: "提交的问题在哪里看回复？",
        answer: "用提交时的账号登录，从「我的咨询与工单」打开原记录。你可以继续补充，也可以选择「转人工」。", href: "/support",
        keywords: &["工单", "进度", "看回复", "查询", "ticket", "status", "replies"],
    },
];
async fn topics() -> Json<ApiResponse<&'static [Topic]>> {
    Json(ApiResponse::success(TOPICS))
}

async fn list(
    State(s): State<Arc<AppState>>,
    Extension(desk): Extension<Desk>,
    h: HeaderMap,
    Query(w): Query<Window>,
) -> Result<Json<ApiResponse<Page<Case>>>> {
    let uid = user(&s, &h).await?;
    if w.status
        .as_deref()
        .is_some_and(|v| !matches!(v, "waiting_staff" | "waiting_user" | "resolved"))
    {
        return Err(bad("客服状态无效"));
    }
    Ok(Json(ApiResponse::success(
        store::list(&s.db, uid, desk, w).await?,
    )))
}

async fn detail(
    State(s): State<Arc<AppState>>,
    Extension(desk): Extension<Desk>,
    h: HeaderMap,
    Path(id): Path<i32>,
    Query(w): Query<Window>,
) -> Result<Json<ApiResponse<Details>>> {
    let uid = user(&s, &h).await?;
    Ok(Json(ApiResponse::success(
        store::detail(&s.db, uid, desk, id, w.before).await?,
    )))
}

async fn open(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(mut p): Json<Opening>,
) -> Result<Json<ApiResponse<Case>>> {
    let uid = user(&s, &h).await?;
    limit_write(uid)?;
    if !matches!(p.kind.as_str(), "question" | "ticket") {
        return Err(bad("请选择咨询或工单"));
    }
    p.subject = bounded(&p.subject, 120, "主题须为 1 至 120 字")?;
    p.body = bounded(&p.body, 4000, "问题描述须为 1 至 4000 字")?;
    p.request_id = key(&p.request_id)?;
    Ok(Json(ApiResponse::success(
        store::open(&s.db, uid, p).await?,
    )))
}

async fn change(
    State(s): State<Arc<AppState>>,
    Extension(desk): Extension<Desk>,
    h: HeaderMap,
    Path(id): Path<i32>,
    Json(mut p): Json<Change>,
) -> Result<Json<ApiResponse<Case>>> {
    let uid = user(&s, &h).await?;
    limit_write(uid)?;
    p.request_id = key(&p.request_id)?;
    if p.version < 1 {
        return Err(bad("缺少记录版本"));
    }
    match p.action.as_str() {
        "reply" => p.body = bounded(&p.body, 4000, "回复须为 1 至 4000 字")?,
        "escalate" | "resolve" | "reopen" if p.body.is_empty() => {}
        _ => return Err(bad("客服操作无效")),
    }
    Ok(Json(ApiResponse::success(
        store::change(&s.db, uid, desk, id, p).await?,
    )))
}
