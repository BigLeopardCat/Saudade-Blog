use axum::{Json, extract::{State, Path}, http::HeaderMap};
use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, QuerySelect, ColumnTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{talk, user};
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// 从请求头提取用户 id（无 token / 令牌无效 / **账号被冻结或令牌已收回** → None）。
///
/// 20260926 起**改走 `auth_jwt::auth_uid`（签名 + 查库）**，不再只验签：这里此前是
/// 一处"自己解 token"的旁路——冻结一个账号之后，它照旧能放河灯、能看"我的河灯"。
/// 河灯是访客内容，正是冻结该停掉的东西。判据回到唯一出口上，这个函数只剩"取个
/// `Option` 方便 let-else"的形。
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
    let uid = current_uid(&state.db, &headers).await;
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
    let Some(uid) = current_uid(&state.db, &headers).await else {
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
    // 20260926：AI 的说明对所有裁决都留痕（ai_reason）——存疑那一支此前把说明丢掉了，
    // 而后台「评论管理」显示的"驳回理由：未填写"绝大多数就是这一支来的（13/18 实测）。
    let (approved, ai_result, ai_reason, reject_reason) = if src == "board" {
        board_approved(state, uid, content).await
    } else {
        (1, None, None, None)
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
        ai_reason: Set(ai_reason),
        reject_reason: Set(reject_reason),
        created_at: Set(chrono::Local::now().naive_local()),
        updated_at: Set(chrono::Local::now().naive_local()),
        ..Default::default()
    };
    let inserted = talk::Entity::insert(t).exec(&state.db).await.unwrap();
    // 审核结果通知（20260923，20260926 补待审那条）。
    //
    // 发的判据分两半，**合起来 = "这行留言的审核状态值得告诉作者"**：
    // ① `approved == 0`（待审）**无条件发**——待审不是"没有结果"，它就是这条留言当下的
    //    状态；一进待审就静默，作者那一侧与"没提交成功"完全同形（20260926 用户报的困惑
    //    正是这个：分不清哪条在等人工、哪条已经放行）。src=talk 的说说恒为 1，走不到这儿。
    // ② 终态（1 通过 / 2 未通过）仍然**只有审核真的跑过才算数**（ai_judged）——两个开关
    //    都关时 approved=1 只是"默认放行"，那不是审核通过，发通知就是假消息。
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

/// 河灯留言入库审核判定（20260905 上线，issue9 起带 AI 留痕，20260923 起带驳回理由，
/// 20260926 起带 AI 说明）：
/// 返回 (approved, ai_result, ai_reason, reject_reason)——approved：1 直接展示 / 0 进待审 /
/// 2 直接驳回；
/// ai_result：Some("pass")=AI 通过 / Some("reject")=AI 驳回 / Some("flag")=AI 存疑转人工 /
///            None=未走 AI（AI 关、人工全审模式、或审核服务不可用转人工——**不可用不等于 AI
///            判过**，不留 pass 假证）；
/// ai_reason：**AI 那一次给的说明**，与裁决无关（pass/flag/reject 都带出来，截 200 字）；
///            None = 没走 AI 或 AI 没给说明。**它是留痕，不是驳回理由**。
/// reject_reason：**只有 AI 判 reject 时才有值**（就是同一段说明），其余一律 None——
///            它是"驳回理由"这一语义的落点，与 ai_reason 是两个出口、同一个来源。
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
pub(crate) fn clip_reject_reason(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(200).collect::<String>())
}

/// 驳回时**两列都没有理由**（存量行 / AI 判驳回但没给 reason 且管理员手填留空）——
/// 通知总得说点什么，就用这句固定文案（**只写进通知正文，不落库**：库里 NULL 代表
/// "没人写过理由"，是事实，不编）。
///
/// 20260926 改文案（用户原话：「『不符合留言板的留言规范』不足以让用户知道问题具体
/// 是什么」）：旧句是循环定义的——它既没说清问题，也没给出路，读起来像一句套话。
/// 新句只做两件**真的做得到**的事：① 如实说"没有人写下具体理由"（不糊弄成"你违规了
/// 但我不告诉你"）② 告诉他去哪儿能看自己的原文（「我的河灯」，`link` 也指向那里）。
/// **不许**在这里编造违规类型——库里没有的东西，通知里不能有。
const REJECT_FALLBACK_REASON: &str = "管理员复核后未通过，但没有留下具体理由；\
你可以在「我的河灯」看到这条留言的原文";

/// 留言摘要（通知里引用访客原话的片段）：换行折成空格 + 截 30 字。
/// 访客留言可以是多行，原样拼进通知正文会把面板行高撑开。
fn talk_brief(content: &str) -> String {
    // 折行与**连续空白**一律拍成一个空格（20260926 改）：留言里 `\r\n` 与空行都很常见，
    // 逐字符换行符会让正文冒出双空格——通知只有一行、面板又压着 `line-clamp: 4`，
    // 看上去像排版坏了。`split_whitespace` 顺带把制表符与全角空格也收掉。
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = flat.as_str();
    if t.chars().count() <= 30 {
        t.to_string()
    } else {
        t.chars().take(30).collect::<String>() + "…"
    }
}

/// 审核结果通知的**文案映射**（纯函数，无 IO——20260926 抽出来加回归锁）。
///
/// 三个结局各一句，返回 `None` 表示"这个值不该发通知"（调用方据此跳过）。
/// 抽出来的理由：这段文案此前埋在 `push_notice` 调用的前一屏，**没有任何测试**，
/// 而它恰好是作者唯一能看到的那句话（20260926 用户报「通知说的是不是假的」那一轮，
/// 三句话逐字对账全靠人工读库）。
///
/// 20261002 参数化出 `_for`（评论也要发通知，见 `decide_review` 那一批改动）：
/// 文案里的对象名词（留言/评论）与去处（留言板/文章评论区）各多一处，**留一个壳**
/// 给留言板，`review_notice_text` 的老签名与三句话**一字不改**（既有单测零改动）。
pub fn review_notice_text_for(
    noun: &str,
    venue: &str,
    approved: i8,
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
            // 单行拼：理由接在同一句里，不另起一行。面板 `.ucBodyText` 其实是
            // `white-space: pre-wrap`（换行留得住，20260923 复核更正——此前这里写的是
            // "没有 pre-line"，写错了），但同一个块还压着 `-webkit-line-clamp: 4`：
            // 留言一长，另起一行的理由恰好是最先被截掉的那段，而它正是收件人唯一要看的。
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
    approved: i8,
    brief: &str,
    reject_reason: Option<&str>,
) -> Option<(String, String)> {
    review_notice_text_for("留言", "留言板", approved, brief, reject_reason)
}

/// 审核**结果**发一条站内通知（20260923，用户要求；20260926 补待审那一条）。
///
/// 发哪三条：**待审（0）、通过（1）、未通过（2）各一条**；不认识的 approved 值不发。
///
/// 20260926 推翻 20260923「进待审不打扰」那条取舍（用户报「存疑待审的河灯，通知却说
/// 已通过审核」那一轮）：当时的顾虑是"双闸全开时每条都先进待审，改了再发一次，用户会
/// 收到两条自相矛盾的通知"。**那个顾虑在今天这一版里不成立**——待审 →（未通过|已通过）
/// 是**同一方向**的两条（"在等人工"→"人工裁完了"），互相不打脸；而"一条通知都不发"
/// 与"留言没提交成功"在作者那一侧**同形**，这正是那次困惑的机械成因：他分不清自己哪条
/// 留言在等人工、哪条已经放行。人工改判（audit_board）仍然每次裁决都发。
async fn notify_review_result(
    state: &Arc<AppState>,
    uid: i32,
    talk_id: i32,
    content: &str,
    approved: i8,
    reject_reason: Option<&str>,
) {
    let brief = talk_brief(content);
    let Some((title, body)) = review_notice_text(approved, &brief, reject_reason) else {
        return;
    };
    // `link` 定位到那盏灯（`/guestbook?lid=<id>`，20260923 用户拍板）；灯若是待审/驳回态、
    // 公开池里没有，河灯页会去「我的河灯」里找（见前端 RiverBoard 的定位逻辑）。
    // 通知失败**绝不影响留言落库**：push_notice 内部吞错只记日志。
    super::notice::push_notice(
        &state.db,
        uid,
        &title,
        Some(body),
        Some(format!("/guestbook?lid={talk_id}")),
    )
    .await;
}

/// AI 审核（20260925 审计 A5）：调 agent 时**带上服务间身份断言**。
///
/// 此前这一发只有 `{content}`，agent 侧 `/review` 因此没有任何身份可核——它是不是
/// "匿名可调用"完全押在"8010 只听回环"这一个部署事实上。现在与 `/chat` 同款签一条
/// 短时效断言（aud=agent，60s）。
///
/// **部署顺序是硬要求**：agent 的 .env 里 `AGENT_REQUIRE_ASSERTION` **已经是 1**
/// （不是"以后再打开"）⇒ 这一半必须先上线，agent 侧才允许把 `/review` 接上
/// `_resolve_principal`；顺序反了留言审核会成片 401，每一条都转人工待审。
/// `uid` 同时进 body：agent 用它核对断言、并在审核日志里留痕。
/// **公共裁决**：给定两个开关，算出这条内容该以什么状态入库
/// —— `(approved, ai_result, ai_reason, reject_reason)`。
///
/// 20261002 从 `board_approved` 里**逐字节搬**出来（评论要复用同一条闸，见
/// `src/routes/comments.rs`），搬移时只做两件事：把 `review_switches` 那一行提到调用方、
/// 把两个布尔收成参数。**判定逻辑、四路回落、话术一字未改**。
///
/// `tag` 只进日志（`[board]` / `[comment]`）：四路回落的告警是排查"为什么这条转人工了"
/// 的第一落点，两种内容共用一个实现之后，日志里分不出是谁在失败就等于白记。
///
/// 为什么值得单独抽：这是全仓最敏感的一条链路——宁可多一次人工复核，
/// 也绝不放行一条未经审核的公开内容。它的兜底有四路（AI 说 pass/reject/存疑、
/// 超时、非 2xx、响应解析失败），**每一路都倒向"转人工"**；抽成可复用函数是为了让
/// 评论**用同一份实现**，而不是照抄一份——照抄的那份将来必然只改一处。
///
/// 调用方负责先读开关（留言板用 `web_info::review_switches`，评论用
/// `web_info::review_switches_of(COMMENT_REVIEW_KEYS)`）。
///
/// 不收 `state`：这条链路**不碰库也不碰 `AppState`**——agent 端点从 `AGENT_URL`
/// 环境变量取（见下），断言现签。所以评论那条路复用它的成本是零依赖。
pub(crate) async fn decide_review(
    tag: &str,
    uid: i32,
    content: &str,
    ai_on: bool,
    manual_on: bool,
) -> (i8, Option<String>, Option<String>, Option<String>) {
    if !ai_on {
        if manual_on {
            return (0, None, None, None);
        }
        return (1, None, None, None);
    }
    // 仅 AI 闸：同步调 agent（模型裁决上限 25s，这里网络超时 20s 先兜住）
    let url = std::env::var("AGENT_URL")
        .map(|u| u.trim_end_matches('/').trim_end_matches("/chat").to_string() + "/review")
        .unwrap_or_else(|_| "http://127.0.0.1:8010/review".to_string());
    let result = review_http()
        .post(&url)
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
                    // 20260926 更正一处**自相矛盾的注释**（它让后来人以为"AI 说明已经有人展示了"）：
                    // 此前这里写着"flag 的说明是给管理员的存疑注记、后台另有 ai_result 段展示它"
                    // ——后半句是假的：`ai_result` 那一列存的是**裁决词**（pass/flag/reject 三个
                    // 字面量），从来没有一列展示过说明；说明全文只活在这一个 HTTP 响应里，
                    // 响应一关就没了。现在它落 `ai_reason`，后台「评论管理」页展示它。
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

/// 留言板的裁决入口（`decide_review` 的薄包装，20261002 抽出）：读留言板的两个审核开关
/// —— `aiReviewEnabled` / `manualReviewEnabled`（见 `web_info::BOARD_REVIEW_KEYS`）。
async fn board_approved(state: &Arc<AppState>, uid: i32, content: &str)
    -> (i8, Option<String>, Option<String>, Option<String>) {
    let (ai_on, manual_on) = super::web_info::review_switches(&state.db).await;
    decide_review("board", uid, content, ai_on, manual_on).await
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
    let Some(_uid) = current_uid(&state.db, &headers).await else {
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
    /// AI 审核说明（20260926）：**与裁决无关**（pass/flag/reject 都可能有），null =
    /// 没走 AI、AI 没给说明、或本次上线前的存量行。后台「评论管理」展示它、驳回弹窗
    /// 可一键采用它——管理员先看得到 AI 的判断，才写得出具体理由。
    /// **只给后台**：公开河灯列表与「我的河灯」共用的 `TalkDto` 不带这个字段
    /// （AI 的内部注记不该发给全体访客）。
    #[serde(rename = "aiReason")]
    pub ai_reason: Option<String>,
}

/// GET /api/protect/board：留言管理列表（全部河灯留言 + 发布用户信息，倒序）
pub async fn list_board_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<BoardAdminDto>>> {
    let Some(_uid) = current_uid(&state.db, &headers).await else {
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
            ai_reason: t.ai_reason,
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
    let Some(_uid) = current_uid(&state.db, &headers).await else {
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
/// 20260923 起驳回可带 reason：手填的 > 已存的 AI 理由（insert_talk 落的 reject_reason）
/// > AI 存疑说明（ai_reason，20260926 补的第三级）；三级都没有就保持 NULL，**不往库里
/// 塞编好的话**——通知层的固定文案在通知那一层兜（那里是"怎么说"，这里只管"记什么"）。
/// 通过时清空 `reject_reason`（不留"已通过却带驳回理由"的矛盾行），**`ai_reason` 不动**
/// ——它是 AI 判定那一侧的留痕，与 `ai_result` 同一纪律（AI 的判定不回溯）。
pub async fn audit_board(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<AuditBody>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = current_uid(&state.db, &headers).await else {
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
    // 已存的两份 AI 材料（人工没填理由时**按优先级回落**，见下方 final_reason）
    let saved_reason = t.reject_reason.clone();
    let saved_ai_reason = t.ai_reason.clone();
    let mut active_model: talk::ActiveModel = t.into();
    active_model.approved = Set(if reject { 2 } else { 1 });
    // 理由的回落链（20260926 补齐第三级）：**人工手填 > reject_reason（AI 判 reject 的
    // 说明）> ai_reason（AI 存疑说明）**。第三级是这次补的——存疑占实测的 13/18，此前
    // 这一支的说明在 board_approved 就被丢了 ⇒ 人工直接点「驳回」时理由落 NULL ⇒
    // 后台显示"未填写"、通知只能说那句套话。**优先级仍是人工第一**：管理员写下的字
    // 永远盖过 AI 的推断。
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
    talk::Entity::update(active_model).exec(&state.db).await.unwrap();
    // 人工裁决的每一步都是终态（通过 / 驳回 / 改判），发通知——用户拍板「改判再发」。
    // 20260926 注释更正：此前这里写着"与 insert_talk 的『只在 AI 终态发』不冲突"，那句话
    // 已经不成立——insert_talk 现在入库时就发一条「等待人工复核」，人工裁完**必然**再发一条。
    // 两条同向（"在等人工" → "人工裁完了"），不是自相矛盾；真要避免的只是"人工手滑点两下
    // 收两条一样的"，那条由下面的 `was_approved != new_approved` 挡着。
    //
    // 但**状态真变了才发**：后台重复点同一个按钮（双击/刷新后手滑）不该又收一条
    // 一模一样的通知——"改判"的语义是 1↔2 的翻转，同态重复不叫改判。
    let new_approved = if reject { 2 } else { 1 };
    if was_approved != new_approved {
        notify_review_result(&state, owner, id, &brief_src, new_approved, final_reason.as_deref()).await;
    }
    Json(ApiResponse::success("Audited".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 三个结局各一句；**待审这条是 20260926 新加的**（此前 approved=0 直接 return，
    /// 作者的留言进了待审却什么都收不到、与"没提交成功"同形）。
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
