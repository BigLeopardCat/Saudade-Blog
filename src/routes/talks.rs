use axum::{Json, extract::{State, Path, Query}, http::HeaderMap};
use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, QuerySelect, ColumnTrait,
               Condition, JoinType, PaginatorTrait, RelationTrait, Select};
use sea_orm::sea_query::extension::postgres::PgExpr;
use super::moderation::{ReviewStatus, AiDecision, page_window};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{talk, user};
use crate::routes::AppState;
use crate::search_core::like_escape;
use crate::utils::{ApiResponse, ApiResponsePage};

pub(crate) async fn current_uid(db: &sea_orm::DatabaseConnection, headers: &HeaderMap) -> Option<i32> {
    crate::auth_jwt::auth_uid(db, headers).await.ok()
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
    /// 发布者**展示名**（昵称优先，空昵称退账号；账号已销退 `用户#<id>`）。
    /// **只有说说（src=talk）填充**：河灯留言的公开行走自由留名 `author`，不把账号
    /// 身份发出去（`_board_text_keys` 那条 "留名不是账号" 的边界，见 list_by_src 取舍）。
    pub nickname: Option<String>,
    /// 发布者头像（站内路径或外链）。同样**只有说说填充**。
    pub avatar: Option<String>,
    /// 是否当前登录用户所放（"我的河灯"分组用）
    pub mine: bool,
    /// 审核状态：1=通过（公开列表可见）/ 0=待审 / 2=未通过（驳回）。
    /// 公开列表已过滤 approved=1 恒 1；我的河灯接口返回本人全部状态
    pub approved: i16,
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
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
    let uid = current_uid(&state.db, &headers).await;
    let mut query = talk::Entity::find();
    if src != "all" {
        query = query.filter(talk::Column::Src.eq(src));
    }
    query = query.filter(talk::Column::Approved.eq(1));
    // created_at 是秒级精度，同秒多行时排序不稳定（加索引后返回顺序可能变）；
    // 补 id 兜底让结果确定 —— 前端灯影集本来就用 id 做次级比较，语义一致
    let talks = match query
        .order_by_desc(talk::Column::CreatedAt)
        .order_by_desc(talk::Column::Id)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        // 不再 unwrap_or(vec![])：那会把「数据库出错」伪装成「留言板没有留言」（200 + 空数组），
        // 排障时只看到一条 200，症状却是"灯全没了"。返回 code=500 但 data 仍是空数组
        //（ApiResponse::error 的 data 是 T::default），前端的 Array.isArray 分支照常走演示灯
        Err(e) => {
            tracing::error!("[board] list_by_src(src={}) 查询失败: {}", src, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let peers = if src == "talk" {
        let mut uids: Vec<i32> = talks.iter().map(|t| t.user_id).collect();
        uids.sort_unstable();
        uids.dedup();
        super::profile::peer_map(&state.db, &uids).await
    } else {
        std::collections::HashMap::new()
    };
    let dtos = talks.into_iter().map(|t| {
        let peer = peers.get(&t.user_id);
        TalkDto {
            id: t.id,
            title: t.title.unwrap_or_default(),
            content: t.content,
            cat: t.cat,
            v: t.v as i32,
            author: t.author,
            nickname: peer.map(|p| p.name.clone()),
            avatar: peer.and_then(|p| p.avatar.clone()),
            mine: uid.map(|u| t.user_id == u).unwrap_or(false),
            approved: t.approved, // 公开列表已过滤 approved=1，恒 1
            reject_reason: t.reject_reason, // approved=1 恒 NULL（改判通过时清空）
            created_at: t.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
            updated_at: t.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }).collect();
    Json(ApiResponse::success(dtos))
}

pub async fn list_my_boards(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<TalkDto>>> {
    let Some(uid) = current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let talks = match talk::Entity::find()
        .filter(talk::Column::Src.eq("board"))
        .filter(talk::Column::UserId.eq(uid))
        .order_by_desc(talk::Column::CreatedAt)
        .order_by_desc(talk::Column::Id) // 同秒多行排序确定（同 list_by_src）
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[board] list_my_boards(uid={}) 查询失败: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let dtos = talks.into_iter().map(|t| TalkDto {
        id: t.id,
        title: t.title.unwrap_or_default(),
        content: t.content,
        cat: t.cat,
        v: t.v as i32,
        author: t.author,
        // 「我的河灯」是留言板那一侧：自己的身份自己知道，不在这里重复发一遍
        // （只有说说填充发布者信息，见 `list_by_src`）。
        nickname: None,
        avatar: None,
        mine: true,
        approved: t.approved,
        // 「我的河灯」是驳回理由的主要出口：灯影集在这里显示「未通过 · 理由」
        reject_reason: t.reject_reason,
        created_at: t.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: t.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }).collect();
    Json(ApiResponse::success(dtos))
}

fn reclaim_refusal(row: Option<(&str, i32)>, uid: i32) -> Option<&'static str> {
    match row {
        Some((src, owner)) if src == "board" && owner == uid => None,
        _ => Some("河灯不存在"),
    }
}

pub async fn delete_my_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(uid) = current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match talk::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => return super::db_error("读取河灯", &e),
    };
    // 准入与删除**分开**：判定只看上面那个纯函数，删除按 id 走（不需要那一行本身）
    if let Some(msg) = reclaim_refusal(row.as_ref().map(|t| (t.src.as_str(), t.user_id)), uid) {
        return Json(ApiResponse::error(msg));
    }
    if let Err(e) = talk::Entity::delete_by_id(id).exec(&state.db).await {
        return super::db_error("收回河灯", &e);
    }
    Json(ApiResponse::success("Deleted".to_string()))
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
    v: i16,
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
    let Some(uid) = current_uid(&state.db, &headers).await else {
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
    let title = if src == "talk" {
        let t = payload.title.trim();
        // 上限 100 字：DB 列是 varchar(255)，留足余量；换行/控制字符不在这里处理，
        // 前端渲染走 markdown 管线的安全分支（同 comments.rs 的 XSS 边界说明）。
        if t.chars().count() > 100 {
            t.chars().take(100).collect::<String>()
        } else {
            t.to_string()
        }
    } else {
        cat.clone()
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
    let mut forced = false;
    if src == "board" {
        let cfg = crate::risk::load_config(&state.db).await;
        match crate::risk::screen(state, uid, &cfg).await {
            // 同 comments.rs：叫 `risk_verdict`，与下面 agent 回的裁决词（`"verdict"` 那个 JSON 键）
            // 区分开——这两个"裁决"在同一个函数里只隔几十行。
            Ok(risk_verdict) => forced = crate::risk::apply_verdict(state, uid, &cfg, risk_verdict).await,
            Err(reject) => return Json(ApiResponse::error(&reject.message())),
        }
    }
    let (approved, ai_result, ai_reason, reject_reason) = if src == "board" {
        match board_approved(state, uid, content).await {
            Ok(result) => result,
            Err(e) => return super::db_error("读取留言审核设置", &e),
        }
    } else {
        (1, None, None, None)
    };
    // 风控档位只在"本来会直接公开"时改判成待审：**只把 1 压成 0，绝不把 2 松成 0**
    // ——AI 已经判过驳回的内容，不该因为"这个人发得太快"就退回到"没人裁过"。
    let approved = if forced && approved == 1 { 0 } else { approved };
    // 通知要用，先各留一份（下面 Set(...) 会把它们 move 走）
    let ai_judged = ai_result.is_some();
    let reason_for_notice = reject_reason.clone();
    let t = talk::ActiveModel {
        title: Set(Some(title)),
        content: Set(content.to_string()),
        cat: Set(cat),
        v: Set(v),
        author: Set(author),
        user_id: Set(uid),
        src: Set(src.to_string()),
        approved: Set(approved),
        ai_result: Set(ai_result),
        ai_reason: Set(ai_reason),
        reject_reason: Set(reject_reason),
        created_at: Set(chrono::Local::now().naive_local()),
        updated_at: Set(chrono::Local::now().naive_local()),
        ..Default::default()
    };
    let inserted = match talk::Entity::insert(t).exec(&state.db).await {
        Ok(r) => r,
        Err(e) => return super::db_error("发布留言", &e),
    };
    if approved == 0 || (ai_judged && (approved == 1 || approved == 2)) {
        notify_review_result(
            state,
            uid,
            inserted.last_insert_id as i32,
            content,
            approved,
            reason_for_notice.as_deref(),
        )
        .await;
    }
    // 审核拦下（approved=0）时 data="Pending"，供前台区分提示（灯已入河 → 待审核）
    if approved == 0 {
        Json(ApiResponse::success("Pending".to_string()))
    } else {
        Json(ApiResponse::success("Created".to_string()))
    }
}

fn review_http() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder().build().unwrap_or_else(|e| {
            tracing::warn!("[board] 审核用 HTTP 客户端构建失败，退回默认: {e}");
            reqwest::Client::new()
        })
    })
}

/// 归一一段驳回理由：去空白 → 截 200 字（DB 列宽）→ 空串归 None。
///
/// 按**字符**截而不是字节：列是 varchar(200)（MySQL 计字符），中文理由按字节切会
/// 在半个汉字上截断、落库报错。
pub(crate) fn clip_reject_reason(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(200).collect::<String>())
}

const REJECT_FALLBACK_REASON: &str = "管理员复核后未通过，但没有留下具体理由；\
你可以在「我的河灯」看到这条留言的原文";

pub(crate) fn talk_brief(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = flat.as_str();
    if t.chars().count() <= 30 {
        t.to_string()
    } else {
        t.chars().take(30).collect::<String>() + "…"
    }
}

pub fn review_notice_text_for(
    noun: &str,
    venue: &str,
    approved: i16,
    brief: &str,
    reject_reason: Option<&str>,
) -> Option<(String, String)> {
    match approved {
        0 => Some((
            format!("{noun}已收到，等待人工复核"),
            format!("你的{noun}「{brief}」已提交，正在等待人工复核；结果出来我再通知你。"),
        )),
        1 => Some((
            format!("{noun}已通过审核"),
            format!("你的{noun}「{brief}」已通过审核，现在可以在{venue}看到了。"),
        )),
        2 => {
            let reason = reject_reason
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or(REJECT_FALLBACK_REASON);
            Some((
                format!("{noun}未通过审核"),
                format!("你的{noun}「{brief}」未通过审核，理由：{reason}"),
            ))
        }
        _ => None,
    }
}

/// 留言板的审核通知文案（`review_notice_text_for` 的薄包装）。
pub fn review_notice_text(
    approved: i16,
    brief: &str,
    reject_reason: Option<&str>,
) -> Option<(String, String)> {
    review_notice_text_for("留言", "留言板", approved, brief, reject_reason)
}

async fn notify_review_result(
    state: &Arc<AppState>,
    uid: i32,
    talk_id: i32,
    content: &str,
    approved: i16,
    reject_reason: Option<&str>,
) {
    let brief = talk_brief(content);
    let Some((title, body)) = review_notice_text(approved, &brief, reject_reason) else {
        return;
    };
    super::notice::push_notice(
        &state.db,
        uid,
        &title,
        Some(body),
        Some(format!("/guestbook?lid={talk_id}")),
    )
    .await;
}

/// AI 不可用时进入人工待审；博客负责审核开关、状态和通知。
pub(crate) async fn decide_review(
    tag: &str,
    uid: i32,
    content: &str,
    ai_on: bool,
    manual_on: bool,
) -> (i16, Option<String>, Option<String>, Option<String>) {
    let endpoint = crate::ai_services::review_endpoint();
    decide_review_at(tag, uid, content, ai_on, manual_on, endpoint.as_deref()).await
}

async fn decide_review_at(
    tag: &str,
    uid: i32,
    content: &str,
    ai_on: bool,
    manual_on: bool,
    endpoint: Option<&str>,
) -> (i16, Option<String>, Option<String>, Option<String>) {
    if !ai_on {
        if manual_on {
            return (0, None, None, None);
        }
        return (1, None, None, None);
    }
    let Some(url) = endpoint else {
        tracing::info!("[{tag}] AI 审核未配置，进入人工复核");
        return (0, None, None, None);
    };
    let result = review_http()
        .post(url)
        .header(
            "X-Agent-Assertion",
            crate::auth_jwt::create_agent_assertion(uid, None),
        )
        .json(&serde_json::json!({ "content": content, "uid": uid }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    match result {
        Ok(r) if r.status().is_success() => {
            match r.json::<serde_json::Value>().await {
                Ok(v) => {
                    let verdict = v.get("verdict").and_then(|x| x.as_str()).unwrap_or("");
                    let ai_reason = clip_reject_reason(v.get("reason").and_then(|x| x.as_str()).unwrap_or(""));
                    match verdict {
                        "pass" if manual_on => (0, Some("pass".to_string()), ai_reason, None),
                        "pass" => (1, Some("pass".to_string()), ai_reason, None),
                        // 两个都开时 AI 驳回也只入队待人工——但**理由先留着**：人工若也驳回，
                        // 手填为空就回落到它（见 audit_board）
                        "reject" => {
                            let approved = if manual_on { 0 } else { 2 };
                            (approved, Some("reject".to_string()), ai_reason.clone(), ai_reason)
                        }
                        _ => {
                            tracing::info!("[{tag}] AI 审核判定存疑，进人工复核");
                            (0, Some("flag".to_string()), ai_reason, None)
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("[{tag}] AI 审核响应解析失败，进入人工复核: {e}");
                    (0, None, None, None)
                }
            }
        }
        Ok(r) => {
            tracing::warn!("[{tag}] AI 审核端点异常(HTTP {}），进入人工复核", r.status());
            (0, None, None, None)
        }
        Err(e) => {
            tracing::warn!("[{tag}] AI 审核不可用，进入人工复核: {e}");
            (0, None, None, None)
        }
    }
}

async fn board_approved(state: &Arc<AppState>, uid: i32, content: &str)
    -> Result<(i16, Option<String>, Option<String>, Option<String>), sea_orm::DbErr> {
    let (ai_on, manual_on) = super::web_info::review_switches(&state.db).await?;
    Ok(decide_review("board", uid, content, ai_on, manual_on).await)
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
    let Some(_uid) = current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    if let Err(e) = talk::Entity::delete_by_id(id).exec(&state.db).await {
        return super::db_error("删除说说", &e);
    }
    Json(ApiResponse::success("Deleted".to_string()))
}

pub async fn update_talk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<UpsertTalk>,
) -> Json<ApiResponse<String>> {
    // 编辑说说：须登录
    let Some(_uid) = current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let talk_model = match talk::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => return super::db_error("读取说说", &e),
    };

    if let Some(t) = talk_model {
        let mut active_model: talk::ActiveModel = t.into();
        active_model.title = Set(Some(payload.title));
        active_model.content = Set(payload.content);
        active_model.updated_at = Set(chrono::Local::now().naive_local());

        if let Err(e) = talk::Entity::update(active_model).exec(&state.db).await {
            return super::db_error("更新说说", &e);
        }
        Json(ApiResponse::success("Updated".to_string()))
    } else {
        Json(ApiResponse { code: 404, message: "Talk not found".to_string(), data: String::default() })
    }
}

/// 后台留言管理：一条河灯留言的管理视图（精确到发布用户，供溯源/维护）。
/// issue9 双段状态：approved（人工侧 0 待审/1 通过/2 未通过）+ ai_result（AI 侧）
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
    pub approved: i16,
    pub ai_result: Option<String>,
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
    #[serde(rename = "aiReason")]
    pub ai_reason: Option<String>,
}

/// Backend board filters; pagination is opt-in for existing consumers.
#[derive(Deserialize)]
pub struct BoardAdminQuery {
    pub id: Option<i32>,
    pub status: Option<ReviewStatus>,
    pub ai_result: Option<AiDecision>,
    pub cat: Option<String>,
    pub q: Option<String>,
    pub order: Option<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

/// Listing and total counts share the same filters and stable ordering.
pub(super) fn board_admin_filter(q: &BoardAdminQuery) -> Select<talk::Entity> {
    let mut finder = talk::Entity::find()
        .join(JoinType::LeftJoin, talk::Relation::User.def())
        .filter(talk::Column::Src.eq("board"));
    if let Some(id) = q.id { finder = finder.filter(talk::Column::Id.eq(id)); }
    if let Some(status) = q.status { finder = finder.filter(talk::Column::Approved.eq(status.approved())); }
    if let Some(ai) = q.ai_result { finder = match ai.value() {
        Some(value) => finder.filter(talk::Column::AiResult.eq(value)),
        None => finder.filter(talk::Column::AiResult.is_null()),
    }; }
    if let Some(cat) = q.cat.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        finder = finder.filter(talk::Column::Cat.eq(cat));
    }
    if let Some(kw) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // Escape wildcard characters; PostgreSQL ILIKE preserves case-insensitive search.
        let pat = format!("%{}%", like_escape(kw));
        finder = finder.filter(
            Condition::any()
                .add(talk::Column::Content.into_expr().ilike(&pat))
                .add(talk::Column::Author.into_expr().ilike(&pat))
                .add(user::Column::Username.into_expr().ilike(&pat))
                .add(user::Column::Nickname.into_expr().ilike(&pat)),
        );
    }
    // 排序与前端原来那三条断言逐条对齐：created_at 为主、id 为同秒内的次序。
    // **id 那一层不能省**：created_at 精度到秒，同秒多行没有确定次序 ⇒ 翻页会重复/漏行
    // （同 `list_by_src` 的那两行 order_by）。
    if q.order.as_deref().map(|o| o.eq_ignore_ascii_case("asc")).unwrap_or(false) {
        finder
            .order_by_asc(talk::Column::CreatedAt)
            .order_by_asc(talk::Column::Id)
    } else {
        finder
            .order_by_desc(talk::Column::CreatedAt)
            .order_by_desc(talk::Column::Id)
    }
}

pub async fn list_board_admin(
    State(state): State<Arc<AppState>>,
    Query(q): Query<BoardAdminQuery>,
    headers: HeaderMap,
) -> Json<ApiResponsePage<Vec<BoardAdminDto>>> {
    let Some(_uid) = current_uid(&state.db, &headers).await else {
        return Json(ApiResponsePage::error("请先登录"));
    };
    // `page_size=0` 会让 `(page-1)*size` 与 sea-orm 的分页断言都出问题，夹到 ≥1
    let window = match page_window(q.page, q.page_size) {
        Ok(value) => value, Err(message) => return Json(ApiResponsePage::error(message)),
    };
    // 计数只在分页时做（不分页时它算出来的数没有地方用，白一次 COUNT）
    let total = match window {
        Some(_) => match board_admin_filter(&q).count(&state.db).await {
            Ok(n) => Some(n as i64),
            Err(e) => {
                tracing::error!("[board] list_board_admin 计数失败: {e}");
                return Json(ApiResponsePage::error("查询失败，请稍后再试"));
            }
        },
        None => None,
    };
    let mut finder = board_admin_filter(&q);
    if let Some((size, offset)) = window {
        finder = finder.limit(size).offset(offset);
    }
    let talks = match finder.all(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[board] list_board_admin 查询失败: {e}");
            return Json(ApiResponsePage::error("查询失败，请稍后再试"));
        }
    };
    // 去重后再 is_in：同一用户放多盏灯时原来会生成 IN (1,1,1,5,5,...)（19 行 → 19 个占位符，
    // 去重后 1 个）。sort+dedup 保持首次出现顺序（SQL 可读、执行计划稳定）
    let mut user_ids: Vec<i32> = talks.iter().map(|t| t.user_id).collect();
    user_ids.sort_unstable();
    user_ids.dedup();
    // sea-orm 0.12 无 find_by_ids，用 is_in 批量过滤；空表不发 IN (NULL) 白查询。
    // 只取用到的三列（find() 是 SELECT *，会把 password 哈希一起捞出来），
    // 用 into_tuple 避免为三列再定义一个 FromQueryResult 结构体
    let users: Vec<(i32, String, String)> = if user_ids.is_empty() {
        vec![]
    } else {
        user::Entity::find()
            .select_only()
            .column(user::Column::Id)
            .column(user::Column::Username)
            .column(user::Column::Nickname)
            .filter(user::Column::Id.is_in(user_ids))
            .into_tuple::<(i32, String, String)>()
            .all(&state.db)
            .await
            .unwrap_or_default()
    };
    let umap: std::collections::HashMap<i32, (String, String)> = users
        .into_iter()
        .map(|(id, username, nickname)| (id, (username, nickname)))
        .collect();
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
            username: u.map(|x| x.0.clone()).unwrap_or_default(),
            nickname: u.map(|x| x.1.clone()).unwrap_or_default(),
            approved: t.approved,
            ai_result: t.ai_result,
            reject_reason: t.reject_reason,
            ai_reason: t.ai_reason,
        }
    }).collect();
    Json(ApiResponsePage::success(dtos, total))
}

/// DELETE /api/protect/board/:id：留言管理删除河灯（须登录）
pub async fn delete_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    if let Err(e) = talk::Entity::delete_by_id(id).exec(&state.db).await {
        return super::db_error("删除河灯", &e);
    }
    Json(ApiResponse::success("Deleted".to_string()))
}

#[derive(Deserialize)]
pub struct AuditBody {
    approved: i16,
    #[serde(default)]
    reason: Option<String>,
}

pub async fn audit_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<AuditBody>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let found = match talk::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => return super::db_error("读取河灯", &e),
    };
    let Some(t) = found else {
        return Json(ApiResponse { code: 404, message: "Talk not found".to_string(), data: String::default() });
    };
    // 审核只作用于河灯留言（说说 src=talk 不走审核流程，拒绝误审）
    if t.src != "board" {
        return Json(ApiResponse::error("仅河灯留言支持人工复核"));
    }
    let reject = payload.approved == 0;
    // 通知要用，转 ActiveModel 之前先取出（t 随后被 move）
    let owner = t.user_id;
    let was_approved = t.approved;
    let brief_src = t.content.clone();
    // 已存的两份 AI 材料（人工没填理由时**按优先级回落**，见下方 final_reason）
    let saved_reason = t.reject_reason.clone();
    let saved_ai_reason = t.ai_reason.clone();
    let mut active_model: talk::ActiveModel = t.into();
    active_model.approved = Set(if reject { 2 } else { 1 });
    let final_reason = if reject {
        payload.reason.as_deref().and_then(clip_reject_reason)
            .or(saved_reason)
            .or(saved_ai_reason)
    } else {
        // 改判回通过 ⇒ 清掉理由，不留"已通过却带驳回理由"的矛盾行
        None
    };
    active_model.reject_reason = Set(final_reason.clone());
    active_model.updated_at = Set(chrono::Local::now().naive_local());
    if let Err(e) = talk::Entity::update(active_model).exec(&state.db).await {
        return super::db_error("保存人工复核结果", &e);
    }
    let new_approved = if reject { 2 } else { 1 };
    if was_approved != new_approved {
        notify_review_result(&state, owner, id, &brief_src, new_approved, final_reason.as_deref()).await;
    }
    Json(ApiResponse::success("Audited".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 收回河灯：三种拒绝**逐字同一句话**（防枚举），只有"本人的河灯"才放行。
    ///
    /// 反控在最后两条：把口径改回"区分开"（比如给非本人那支单独一句话）⇒ 当场红。
    #[test]
    fn 收回河灯的三种拒绝共用同一句话() {
        let mine = Some(("board", 7));
        let someone_else = Some(("board", 8));
        let not_a_lamp = Some(("talk", 7)); // 说说：id 空间同一张表
        assert_eq!(reclaim_refusal(None, 7), Some("河灯不存在"));
        assert_eq!(reclaim_refusal(someone_else, 7), Some("河灯不存在"));
        assert_eq!(reclaim_refusal(not_a_lamp, 7), Some("河灯不存在"));
        assert_eq!(reclaim_refusal(mine, 7), None, "本人的河灯必须放行");
        // 三句话逐字相同（改回"只能收回自己放的河灯"这类区分口径就红）
        assert_eq!(reclaim_refusal(None, 7), reclaim_refusal(someone_else, 7));
        assert_eq!(reclaim_refusal(None, 7), reclaim_refusal(not_a_lamp, 7));
    }

    /// 长留言压成一行 30 字（通知正文里的 `{brief}`）——通知与留言板的截断口径不同，
    /// 通知那边只有一行、且会被面板的 `-webkit-line-clamp: 4` 继续裁，所以更短。
    #[test]
    fn 留言摘要压成一行且不超三十字() {
        assert_eq!(talk_brief("  河灯很好看  "), "河灯很好看");
        // 换行/回车是留言里最常见的"排版"，正文里必须拍平成空格，否则面板只显示第一行；
        // `\r\n` 与空行**只能留一个空格**（连续空白收成一个，不然正文里出现双空格）
        assert_eq!(talk_brief("第一行\n第二行\r\n第三行"), "第一行 第二行 第三行");
        assert_eq!(talk_brief("上一段\n\n\n下一段"), "上一段 下一段");
        assert_eq!(talk_brief("制表\t分隔"), "制表 分隔");
        let long = "啊".repeat(50);
        let brief = talk_brief(&long);
        assert_eq!(brief.chars().count(), 31); // 30 字 + 省略号
        assert!(brief.ends_with('…'));
    }

    #[test]
    fn 待审也有一条通知且不替人下结论() {
        let (title, body) = review_notice_text(0, "河灯很好看", None).unwrap();
        assert_eq!(title, "留言已收到，等待人工复核");
        assert!(body.contains("河灯很好看"));
        assert!(body.contains("等待人工复核"));
        // 理由还没经人裁过 ⇒ 待审那条**不许**把 AI 的初判说法印进去（否则等于替人下结论）
        let (_, body_with_reason) =
            review_notice_text(0, "河灯很好看", Some("带有负面情绪")).unwrap();
        assert!(!body_with_reason.contains("带有负面情绪"));
    }

    #[test]
    fn 通过与未通过的文案各一句() {
        let (title, body) = review_notice_text(1, "河灯很好看", None).unwrap();
        assert_eq!(title, "留言已通过审核");
        assert!(body.contains("已通过审核"));

        let (title, body) = review_notice_text(2, "河灯很好看", Some("  带有负面情绪 ")).unwrap();
        assert_eq!(title, "留言未通过审核");
        assert!(body.contains("理由：带有负面情绪")); // 两侧空白先 trim
    }

    /// 驳回而没人填理由时，正文必须给一句**可行动**的兜底（作者至少知道去哪儿找原文），
    /// 不能落到空字符串或裸的「理由：」。
    #[test]
    fn 驳回无理由时回落到兜底文案() {
        for reason in [None, Some(""), Some("   ")] {
            let (_, body) = review_notice_text(2, "河灯很好看", reason).unwrap();
            assert!(body.contains(REJECT_FALLBACK_REASON), "reason={reason:?}");
            assert!(!body.ends_with("理由："));
        }
    }

    /// 不认识的 approved 值不发（旧行/脏值的防线：宁可静默，也不给作者发一条编出来的结果）。
    #[test]
    fn 未知裁决值不发通知() {
        assert!(review_notice_text(3, "河灯很好看", None).is_none());
        assert!(review_notice_text(-1, "河灯很好看", None).is_none());
    }
}

#[cfg(test)]
mod optional_review_tests {
    use super::decide_review_at;

    #[tokio::test]
    async fn no_ai_service_keeps_content_in_manual_review() {
        for manual_on in [false, true] {
            assert_eq!(decide_review_at("test", 1, "content", true, manual_on, None).await,
                (0, None, None, None));
        }
        assert_eq!(decide_review_at("test", 1, "content", false, true, None).await,
            (0, None, None, None));
        assert_eq!(decide_review_at("test", 1, "content", false, false, None).await,
            (1, None, None, None));
    }
}
