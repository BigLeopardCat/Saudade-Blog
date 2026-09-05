use axum::{Json, extract::{State, Path}, http::HeaderMap};
use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, ColumnTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{talk, user};
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// 从请求头提取 Bearer 中的用户 id（无 token / 无效则 None；公开接口可选鉴权）
fn current_uid(headers: &HeaderMap) -> Option<i32> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| crate::auth_jwt::verify_token(token))
        .map(|claims| claims.sub)
}

#[derive(Serialize)]
pub struct TalkDto {
    #[serde(rename = "talkKey")]
    pub id: i32,
    #[serde(rename = "talkTitle")]
    pub title: String,
    pub content: String,
    pub cat: String,
    pub v: i32,
    pub author: String,
    /// 是否当前登录用户所放（"我的河灯"分组用）
    pub mine: bool,
    #[serde(rename = "createTime")]
    pub created_at: String,
    #[serde(rename = "updateTime")]
    pub updated_at: String,
}

/// 按来源列列表：src="talk" 说说 / "board" 河灯留言 / "all" 全部（仅统计用）
async fn list_by_src(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    src: &str,
) -> Json<ApiResponse<Vec<TalkDto>>> {
    let uid = current_uid(headers);
    let mut query = talk::Entity::find();
    if src != "all" {
        query = query.filter(talk::Column::Src.eq(src));
    }
    // 20260905：公开列表只放行 approved=1 的留言（审核开关开启后拦下的 0 不展示；
    // 存量行全为 1，对现状零影响。管理视图 list_board_admin 不受此过滤）
    query = query.filter(talk::Column::Approved.eq(1));
    let talks = query.order_by_desc(talk::Column::CreatedAt).all(&state.db).await.unwrap_or(vec![]);
    let dtos = talks.into_iter().map(|t| TalkDto {
        id: t.id,
        title: t.title.unwrap_or_default(),
        content: t.content,
        cat: t.cat,
        v: t.v as i32,
        author: t.author,
        mine: uid.map(|u| t.user_id == u).unwrap_or(false),
        created_at: t.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: t.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }).collect();
    Json(ApiResponse::success(dtos))
}

/// GET /api/public/talk：前台"说说"页（仅后台发布的说说，与留言板各自独立）
pub async fn list_talks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<TalkDto>>> {
    list_by_src(&state, &headers, "talk").await
}

/// GET /api/public/board：河灯留言板（仅留言板所放河灯，与说说各自独立）
pub async fn list_boards(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<TalkDto>>> {
    list_by_src(&state, &headers, "board").await
}

/// GET /api/talk：全部内容（兼容旧调用/统计口径，公开接口）
pub async fn list_all_talks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<TalkDto>>> {
    list_by_src(&state, &headers, "all").await
}

#[derive(Deserialize)]
pub struct UpsertTalk {
    #[serde(rename = "talkTitle")]
    title: String,
    content: String,
    // 河灯留言：印章类型（愿/寄/忆/诉）与灯型（0 莲花 / 1 八角 / 2 圆笼）
    #[serde(default)]
    cat: String,
    #[serde(default)]
    v: i8,
    // 留名（灯影集"按账户"分组用，可空）
    #[serde(default)]
    author: String,
}

/// 内部落库：校验 + 鉴权后按来源插入（src 决定是说说还是河灯留言）
async fn insert_talk(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    payload: UpsertTalk,
    src: &str,
) -> Json<ApiResponse<String>> {
    // 发布必须登录（昵称/匿名都会在 user_id 留存，供溯源与维护）
    let Some(uid) = current_uid(headers) else {
        return Json(ApiResponse::error("请先登录后再发布"));
    };
    // 基础校验防滥用（长度封顶 + 印章/灯型白名单）
    let content = payload.content.trim();
    let cat = match payload.cat.as_str() {
        "愿" | "寄" | "忆" | "诉" => payload.cat,
        _ => "愿".to_string(),
    };
    let v = match payload.v {
        0..=2 => payload.v,
        _ => 0,
    };
    if content.is_empty() {
        return Json(ApiResponse::error("留言不能为空"));
    }
    if content.chars().count() > 500 {
        return Json(ApiResponse::error("留言过长（最多 500 字）"));
    }
    let author = payload.author.trim();
    let author = if author.chars().count() > 20 {
        author.chars().take(20).collect::<String>()
    } else {
        author.to_string()
    };
    // 20260905 留言审核：河灯留言（src=board）按 web_info 开关组合定 approved
    // （说说 src=talk 恒 1 直接展示，不纳入审核——审核只针对公开访客留言）
    let approved = if src == "board" {
        board_approved(state, content).await
    } else {
        1
    };
    let t = talk::ActiveModel {
        title: Set(Some(cat.clone())),
        content: Set(content.to_string()),
        cat: Set(cat),
        v: Set(v),
        author: Set(author),
        user_id: Set(uid),
        src: Set(src.to_string()),
        approved: Set(approved),
        created_at: Set(chrono::Local::now().naive_local()),
        updated_at: Set(chrono::Local::now().naive_local()),
        ..Default::default()
    };
    talk::Entity::insert(t).exec(&state.db).await.unwrap();
    // 审核拦下（approved=0）时 data="Pending"，供前台区分提示（灯已入河 → 待审核）
    if approved == 0 {
        Json(ApiResponse::success("Pending".to_string()))
    } else {
        Json(ApiResponse::success("Created".to_string()))
    }
}

/// 河灯留言入库审核判定（20260905）：返回 approved 值——1 直接展示 / 0 进待审。
/// 开关组合（两闸可叠加、可单独作用，用户拍板）：
///   · 人工复核开 → 一律 0 待审（人工同意才放行；AI 若同开仅作入队前过滤）
///   · 仅 AI 开    → 同步调 agent /review：flag → 0 待审；pass → 1
///   · 都关        → 1（维持 20260905 前全通过的现状）
/// agent 不可用/超时/解析失败 → 降级放行不拦正常留言（兑底，日志留痕）。
async fn board_approved(state: &Arc<AppState>, content: &str) -> i8 {
    let (ai_on, manual_on) = super::web_info::review_switches(&state.db).await;
    if manual_on {
        return 0;
    }
    if !ai_on {
        return 1;
    }
    // 仅 AI 闸：同步调 agent（模型裁决上限 25s，这里网络超时 20s 先兜住）
    let url = std::env::var("AGENT_URL")
        .map(|u| u.trim_end_matches('/').trim_end_matches("/chat").to_string() + "/review")
        .unwrap_or_else(|_| "http://127.0.0.1:8010/review".to_string());
    let result = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "content": content }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    match result {
        Ok(r) if r.status().is_success() => {
            match r.json::<serde_json::Value>().await {
                Ok(v) if v.get("verdict").and_then(|x| x.as_str()) == Some("flag") => {
                    tracing::info!("[board] AI 审核拦下一条留言，进待审");
                    0
                }
                Ok(_) => 1, // verdict=pass 或缺省 → 放行
                Err(e) => {
                    tracing::warn!("[board] AI 审核响应解析失败，降级放行: {e}");
                    1
                }
            }
        }
        Ok(r) => {
            tracing::warn!("[board] AI 审核端点异常(HTTP {}），降级放行", r.status());
            1
        }
        Err(e) => {
            tracing::warn!("[board] AI 审核不可用，降级放行: {e}");
            1
        }
    }
}

/// POST /api/public/board：河灯留言板放灯（强制登录）
pub async fn create_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<UpsertTalk>,
) -> Json<ApiResponse<String>> {
    insert_talk(&state, &headers, payload, "board").await
}

/// POST /api/protect/talk：后台发布说说（强制登录）
pub async fn create_talk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<UpsertTalk>,
) -> Json<ApiResponse<String>> {
    insert_talk(&state, &headers, payload, "talk").await
}

pub async fn delete_talk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    // 删除说说：须登录（后台说说管理入口）
    let Some(_uid) = current_uid(&headers) else {
        return Json(ApiResponse::error("请先登录"));
    };
    talk::Entity::delete_by_id(id).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Deleted".to_string()))
}

pub async fn update_talk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<UpsertTalk>,
) -> Json<ApiResponse<String>> {
    // 编辑说说：须登录
    let Some(_uid) = current_uid(&headers) else {
        return Json(ApiResponse::error("请先登录"));
    };
    let talk_model = talk::Entity::find_by_id(id)
        .one(&state.db)
        .await
        .unwrap();

    if let Some(t) = talk_model {
        let mut active_model: talk::ActiveModel = t.into();
        active_model.title = Set(Some(payload.title));
        active_model.content = Set(payload.content);
        active_model.updated_at = Set(chrono::Local::now().naive_local());

        talk::Entity::update(active_model).exec(&state.db).await.unwrap();
        Json(ApiResponse::success("Updated".to_string()))
    } else {
        Json(ApiResponse { code: 404, message: "Talk not found".to_string(), data: String::default() })
    }
}

/// 后台留言管理：一条河灯留言的管理视图（精确到发布用户，供溯源/维护）
#[derive(Serialize)]
pub struct BoardAdminDto {
    #[serde(rename = "talkKey")]
    pub id: i32,
    pub content: String,
    pub cat: String,
    pub v: i32,
    pub author: String,
    #[serde(rename = "createTime")]
    pub created_at: String,
    #[serde(rename = "userId")]
    pub user_id: i32,
    pub username: String,
    pub nickname: String,
    pub approved: i8,
}

/// GET /api/protect/board：留言管理列表（全部河灯留言 + 发布用户信息，倒序）
pub async fn list_board_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<BoardAdminDto>>> {
    let Some(_uid) = current_uid(&headers) else {
        return Json(ApiResponse::error("请先登录"));
    };
    let talks = talk::Entity::find()
        .filter(talk::Column::Src.eq("board"))
        .order_by_desc(talk::Column::CreatedAt)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);
    let user_ids: Vec<i32> = talks.iter().map(|t| t.user_id).collect();
    // sea-orm 0.12 无 find_by_ids，用 is_in 批量过滤
    let users = user::Entity::find()
        .filter(user::Column::Id.is_in(user_ids))
        .all(&state.db)
        .await
        .unwrap_or(vec![]);
    let umap: std::collections::HashMap<i32, user::Model> = users.into_iter().map(|u| (u.id, u)).collect();
    let dtos = talks.into_iter().map(|t| {
        let u = umap.get(&t.user_id);
        BoardAdminDto {
            id: t.id,
            content: t.content,
            cat: t.cat,
            v: t.v as i32,
            author: t.author,
            created_at: t.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
            user_id: t.user_id,
            username: u.map(|x| x.username.clone()).unwrap_or_default(),
            nickname: u.map(|x| x.nickname.clone()).unwrap_or_default(),
            approved: t.approved,
        }
    }).collect();
    Json(ApiResponse::success(dtos))
}

/// DELETE /api/protect/board/:id：留言管理删除河灯（须登录）
pub async fn delete_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = current_uid(&headers) else {
        return Json(ApiResponse::error("请先登录"));
    };
    talk::Entity::delete_by_id(id).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Deleted".to_string()))
}

#[derive(Deserialize)]
pub struct AuditBody {
    /// 0=驳回（隐藏） 1=通过
    approved: i8,
}

/// PUT /api/protect/board/:id/audit：留言人工复核（20260905 启用——面板开关
/// manualReviewEnabled 开启后新留言一律 approved=0 待审，管理端本接口 通过(1)/
/// 驳回(0) 放行/隐藏；AI 拦截进待审的留言同样走这里人工裁决）
pub async fn audit_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<AuditBody>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = current_uid(&headers) else {
        return Json(ApiResponse::error("请先登录"));
    };
    let Some(t) = talk::Entity::find_by_id(id).one(&state.db).await.unwrap() else {
        return Json(ApiResponse { code: 404, message: "Talk not found".to_string(), data: String::default() });
    };
    // 审核只作用于河灯留言（说说 src=talk 不走审核流程，拒绝误审）
    if t.src != "board" {
        return Json(ApiResponse::error("仅河灯留言支持人工复核"));
    }
    let mut active_model: talk::ActiveModel = t.into();
    active_model.approved = Set(if payload.approved == 0 { 0 } else { 1 });
    active_model.updated_at = Set(chrono::Local::now().naive_local());
    talk::Entity::update(active_model).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Audited".to_string()))
}
