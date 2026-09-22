use axum::{Json, extract::{State, Path}, http::HeaderMap};
use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, QuerySelect, ColumnTrait};
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
    /// 审核状态：1=通过（公开列表可见）/ 0=待审 / 2=未通过（驳回）。
    /// 公开列表已过滤 approved=1 恒 1；我的河灯接口返回本人全部状态
    pub approved: i8,
    /// 驳回理由（20260923）：仅 approved=2 时可能有值（AI 判定说明或管理员手填），
    /// 其余状态恒 null——改判通过时会清空。公开列表里恒 null（那里只有 approved=1）。
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
    let uid = current_uid(headers);
    let mut query = talk::Entity::find();
    if src != "all" {
        query = query.filter(talk::Column::Src.eq(src));
    }
    // 20260905：公开列表只放行 approved=1 的留言（审核开关开启后拦下的 0 不展示；
    // 存量行全为 1，对现状零影响。管理视图 list_board_admin 不受此过滤）
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
    let dtos = talks.into_iter().map(|t| TalkDto {
        id: t.id,
        title: t.title.unwrap_or_default(),
        content: t.content,
        cat: t.cat,
        v: t.v as i32,
        author: t.author,
        mine: uid.map(|u| t.user_id == u).unwrap_or(false),
        approved: t.approved, // 公开列表已过滤 approved=1，恒 1
        reject_reason: t.reject_reason, // approved=1 恒 NULL（改判通过时清空）
        created_at: t.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: t.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }).collect();
    Json(ApiResponse::success(dtos))
}

/// GET /api/protect/board/mine：我的河灯（当前登录用户所放全部，含待审/未通过）。
/// 灯影集「我的河灯」页签数据源——公开列表只放行 approved=1，本人待审(0)/
/// 未通过(2)的河灯需要本接口才能查看状态与收回（20260905 issue8）
pub async fn list_my_boards(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<TalkDto>>> {
    let Some(uid) = current_uid(&headers) else {
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
        mine: true,
        approved: t.approved,
        // 「我的河灯」是驳回理由的主要出口：灯影集在这里显示「未通过 · 理由」
        reject_reason: t.reject_reason,
        created_at: t.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: t.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }).collect();
    Json(ApiResponse::success(dtos))
}

/// DELETE /api/protect/board/mine/:id：收回自己的河灯（归属校验——只能删自己
/// 放的灯；管理端全量删除走 delete_board）。20260905 issue8
pub async fn delete_my_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(uid) = current_uid(&headers) else {
        return Json(ApiResponse::error("请先登录"));
    };
    let Some(t) = talk::Entity::find_by_id(id).one(&state.db).await.unwrap() else {
        return Json(ApiResponse { code: 404, message: "Talk not found".to_string(), data: String::default() });
    };
    if t.src != "board" || t.user_id != uid {
        return Json(ApiResponse::error("只能收回自己放的河灯"));
    }
    talk::Entity::delete_by_id(id).exec(&state.db).await.unwrap();
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
    // （说说 src=talk 恒 1 直接展示，不纳入审核——审核只针对公开访客留言）。
    // issue9：AI 判定同步落库 ai_result——后台按「AI 审核 + 人工审核」两段展示，
    // 判定是 pass/flag 即时生效后不回溯，留痕供管理端溯源。
    // 20260923：同时接住 AI 给的驳回理由（reject_reason），供审核结果通知与后台展示
    let (approved, ai_result, reject_reason) = if src == "board" {
        board_approved(state, content).await
    } else {
        (1, None, None)
    };
    // 通知要用，先各留一份（下面 Set(...) 会把它们 move 走）
    let ai_judged = ai_result.is_some();
    let reason_for_notice = reject_reason.clone();
    let t = talk::ActiveModel {
        title: Set(Some(cat.clone())),
        content: Set(content.to_string()),
        cat: Set(cat),
        v: Set(v),
        author: Set(author),
        user_id: Set(uid),
        src: Set(src.to_string()),
        approved: Set(approved),
        ai_result: Set(ai_result),
        reject_reason: Set(reject_reason),
        created_at: Set(chrono::Local::now().naive_local()),
        updated_at: Set(chrono::Local::now().naive_local()),
        ..Default::default()
    };
    let inserted = talk::Entity::insert(t).exec(&state.db).await.unwrap();
    // 审核结果通知（20260923）：**只有审核真的跑过才算数**（ai_judged）——
    // 两个开关都关时 approved=1 只是"默认放行"，那不是审核通过，发通知就是假消息；
    // 人工复核开（此时 approved=0 待审）、AI 存疑 flag、审核服务不可用转人工，都不发。
    if ai_judged && (approved == 1 || approved == 2) {
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

/// 河灯留言入库审核判定（20260905 上线，issue9 起带 AI 留痕，20260923 起带驳回理由）：
/// 返回 (approved, ai_result, reject_reason)——approved：1 直接展示 / 0 进待审 / 2 直接驳回；
/// ai_result：Some("pass")=AI 通过 / Some("reject")=AI 驳回 / Some("flag")=AI 存疑转人工 /
///            None=未走 AI（AI 关、人工全审模式、或审核服务不可用转人工——**不可用不等于 AI
///            判过**，不留 pass 假证）；
/// reject_reason：**只有 AI 判 reject 时才有值**（就是它给出的说明，截 200 字），其余一律 None。
/// 开关组合（两闸可叠加、可单独作用，用户拍板）：
///   · 人工复核开 → 一律 0 待审（人工同意才放行；AI 若同开仅作入队前过滤）
///   · 仅 AI 开    → 同步调 agent /review：flag → (0,"flag")；pass → (1,"pass")；reject → (2,"reject")
///   · 都关        → (1, None)（维持 20260905 前全通过的现状）
/// agent 不可用/超时/解析失败 → **(0, None) 转人工待审**（兜底方向 = 宁可多一次人工，
/// 绝不放行未审内容）。⚠️ 此处此前写的是"降级放行"，与代码相反——b3c4d83 就已经改成了
/// 转人工（那一版把改动裹在"找回密码"的提交里，注释没同步），20260923 一并更正。
/// 审核用 HTTP 客户端（进程内单例）：原来每条留言都 `reqwest::Client::new()`，
/// 等于每次重建连接池、放弃 keep-alive；连接池闲置 90s 由 reqwest 自行回收。
/// 注意 .timeout 仍留在每请求上（挪进 builder 会变成全局默认值，语义不同）。
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
fn clip_reject_reason(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(200).collect::<String>())
}

/// 驳回时库里的理由列也可能是 NULL（AI 判驳回但没给 reason、管理员手填留空）——
/// 通知总得说点什么，就用这句固定文案（**只写进通知正文，不落库**：库里 NULL 代表
/// "没人写过理由"，是事实，不编）。
const REJECT_FALLBACK_REASON: &str = "不符合留言板的留言规范";

/// 留言摘要（通知里引用访客原话的片段）：换行折成空格 + 截 30 字。
/// 访客留言可以是多行，原样拼进通知正文会把面板行高撑开。
fn talk_brief(content: &str) -> String {
    let flat: String = content
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let t = flat.trim();
    if t.chars().count() <= 30 {
        t.to_string()
    } else {
        t.chars().take(30).collect::<String>() + "…"
    }
}

/// 审核**终态**发一条站内通知（20260923，用户要求）。
///
/// **只在终态发**（用户拍板）：通过一条、驳回一条；进待审不打扰——待审不是结果，
/// 双闸全开时每条都会先进待审，若那时就发一次，人工改判又要再发一次，用户会收到
/// 两条自相矛盾的通知。人工改判（audit_board）每次裁决都发，那是真终态。
///
/// `link` 定位到那盏灯（`/guestbook?lid=<id>`，20260923 用户拍板）；灯若是驳回态、
/// 公开池里没有，河灯页会去「我的河灯」里找（见前端 RiverBoard 的定位逻辑）。
///
/// 通知失败**绝不影响留言落库**：push_notice 内部吞错只记日志。
async fn notify_review_result(
    state: &Arc<AppState>,
    uid: i32,
    talk_id: i32,
    content: &str,
    approved: i8,
    reject_reason: Option<&str>,
) {
    let brief = talk_brief(content);
    let (title, body) = match approved {
        1 => (
            "留言已通过审核",
            format!("你的留言「{brief}」已通过审核，现在可以在留言板看到了。"),
        ),
        2 => {
            let reason = reject_reason
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or(REJECT_FALLBACK_REASON);
            // 单行拼：理由接在同一句里，不另起一行。面板 `.ucBodyText` 其实是
            // `white-space: pre-wrap`（换行留得住，20260923 复核更正——此前这里写的是
            // "没有 pre-line"，写错了），但同一个块还压着 `-webkit-line-clamp: 4`：
            // 留言一长，另起一行的理由恰好是最先被截掉的那段，而它正是收件人唯一要看的。
            (
                "留言未通过审核",
                format!("你的留言「{brief}」未通过审核，理由：{reason}"),
            )
        }
        // 0 = 待审，不是终态，不发（调用方本已过滤，这里是第二道）
        _ => return,
    };
    super::notice::push_notice(
        &state.db,
        uid,
        title,
        Some(body),
        Some(format!("/guestbook?lid={talk_id}")),
    )
    .await;
}

async fn board_approved(state: &Arc<AppState>, content: &str) -> (i8, Option<String>, Option<String>) {
    let (ai_on, manual_on) = super::web_info::review_switches(&state.db).await;
    if !ai_on {
        if manual_on {
            return (0, None, None);
        }
        return (1, None, None);
    }
    // 仅 AI 闸：同步调 agent（模型裁决上限 25s，这里网络超时 20s 先兜住）
    let url = std::env::var("AGENT_URL")
        .map(|u| u.trim_end_matches('/').trim_end_matches("/chat").to_string() + "/review")
        .unwrap_or_else(|_| "http://127.0.0.1:8010/review".to_string());
    let result = review_http()
        .post(&url)
        .json(&serde_json::json!({ "content": content }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    match result {
        Ok(r) if r.status().is_success() => {
            match r.json::<serde_json::Value>().await {
                Ok(v) => {
                    let verdict = v.get("verdict").and_then(|x| x.as_str()).unwrap_or("");
                    // 理由只有"驳回"这一支有意义：pass 不需要理由，flag 的说明是给管理员的
                    // 存疑注记、不是驳回理由（后台另有 ai_result 段展示它）。
                    let reason = clip_reject_reason(v.get("reason").and_then(|x| x.as_str()).unwrap_or(""));
                    match verdict {
                        "pass" if manual_on => (0, Some("pass".to_string()), None),
                        "pass" => (1, Some("pass".to_string()), None),
                        // 两个都开时 AI 驳回也只入队待人工——但**理由先留着**：人工若也驳回，
                        // 手填为空就回落到它（见 audit_board）
                        "reject" => {
                            let approved = if manual_on { 0 } else { 2 };
                            (approved, Some("reject".to_string()), reason)
                        }
                        _ => {
                            tracing::info!("[board] AI 审核判定存疑，进人工复核");
                            (0, Some("flag".to_string()), None)
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("[board] AI 审核响应解析失败，进入人工复核: {e}");
                    (0, None, None)
                }
            }
        }
        Ok(r) => {
            tracing::warn!("[board] AI 审核端点异常(HTTP {}），进入人工复核", r.status());
            (0, None, None)
        }
        Err(e) => {
            tracing::warn!("[board] AI 审核不可用，进入人工复核: {e}");
            (0, None, None)
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
    pub approved: i8,
    /// AI 审核判定留痕（20260905 issue9）："pass"=AI通过 / "flag"=AI拦截转人工 /
    /// null=未审（AI 关、人工全审、审核服务不可用转人工，或存量历史行）
    pub ai_result: Option<String>,
    /// 驳回理由（20260923）：管理员驳回时至多填 200 字；null = 未驳回或没人写过理由
    /// （把「没人写」和「写了空」都归一成 null，后台列表据此显示「未填写」）
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
}

/// GET /api/protect/board：留言管理列表（全部河灯留言 + 发布用户信息，倒序）
pub async fn list_board_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<BoardAdminDto>>> {
    let Some(_uid) = current_uid(&headers) else {
        return Json(ApiResponse::error("请先登录"));
    };
    let talks = match talk::Entity::find()
        .filter(talk::Column::Src.eq("board"))
        .order_by_desc(talk::Column::CreatedAt)
        .order_by_desc(talk::Column::Id) // 同秒多行排序确定（同 list_by_src）
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[board] list_board_admin 查询失败: {e}");
            return Json(ApiResponse::error("查询失败，请稍后再试"));
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
    /// 1=通过（放行展示）；0=驳回——写 approved=2「未通过」，与待审(0)区分
    /// （20260905 issue8：本人「我的河灯」按 0 显示待审标签、2 显示未通过标签）
    approved: i8,
    /// 驳回理由（20260923 加，可空）：管理员手填，落 `talk.reject_reason`，
    /// 审核结果通知会带上它。**通过时请求里带什么都不生效**（改判即清空该列）。
    /// `serde(default)` 保证老前端（只发 approved）照常工作。
    #[serde(default)]
    reason: Option<String>,
}

/// PUT /api/protect/board/:id/audit：留言人工复核（20260905 启用——面板开关
/// manualReviewEnabled 开启后新留言一律 approved=0 待审，管理端本接口 通过(1)
/// 放行 / 驳回(2) 隐藏；AI 拦截进待审的留言同样走这里人工裁决）。
/// issue9：人工裁决只写 approved，不改写 ai_result——AI 判定作为历史留痕保留，
/// 后台「AI 拦截 → 人工放行/驳回」双段状态由此完整呈现；驳回(2) 可改判回通过(1)。
/// 20260923 起驳回可带 reason：手填的 > 已存的 AI 理由（AI 判 reject 时 insert_talk
/// 落的那个）；都没写就保持 NULL，**不往库里塞编好的话**——通知层的固定文案在通知
/// 那一层兜（那里是"怎么说"，这里只管"记什么"）。通过时清空该列。
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
    let reject = payload.approved == 0;
    // 通知要用，转 ActiveModel 之前先取出（t 随后被 move）
    let owner = t.user_id;
    let was_approved = t.approved;
    let brief_src = t.content.clone();
    // 已存的 AI 理由（人工没填时回落到它）
    let saved_reason = t.reject_reason.clone();
    let mut active_model: talk::ActiveModel = t.into();
    active_model.approved = Set(if reject { 2 } else { 1 });
    let final_reason = if reject {
        payload.reason.as_deref().and_then(clip_reject_reason).or(saved_reason)
    } else {
        // 改判回通过 ⇒ 清掉理由，不留"已通过却带驳回理由"的矛盾行
        None
    };
    active_model.reject_reason = Set(final_reason.clone());
    active_model.updated_at = Set(chrono::Local::now().naive_local());
    talk::Entity::update(active_model).exec(&state.db).await.unwrap();
    // 人工裁决的每一步都是终态（通过 / 驳回 / 改判），发通知——用户拍板「改判再发」。
    // 这与 insert_talk 的"只在 AI 终态发"不冲突：那时双闸全开的留言还在待审，
    // 打扰一次、改判再打扰一次，用户会看到两条自相矛盾的通知。
    //
    // 但**状态真变了才发**：后台重复点同一个按钮（双击/刷新后手滑）不该又收一条
    // 一模一样的通知——"改判"的语义是 1↔2 的翻转，同态重复不叫改判。
    let new_approved = if reject { 2 } else { 1 };
    if was_approved != new_approved {
        notify_review_result(&state, owner, id, &brief_src, new_approved, final_reason.as_deref()).await;
    }
    Json(ApiResponse::success("Audited".to_string()))
}
