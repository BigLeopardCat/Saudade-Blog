//! 文章阅读量 / 点赞量 / 收藏量（20260930）。
//!
//! ## ★ 阅读量**绝不能**记在 `get_note_detail` 里（新模块头一条纪律）
//!
//! 那个端点被 agent 的 `get_article_detail` 工具**频繁读取**——把它接上计数，等于
//! 看板娘每"看"一次文章就给自己刷一次阅读量，报表立刻变成"agent 的调用次数分布"。
//! 正确做法就是本模块：**独立端点 + 前端在确认文章真的存在之后上报**
//! （见 `ReadArticle` 的 `loadArticle` 成功分支）。将来若有人想"顺手合并回详情端点"，
//! 请先读完这段。
//!
//! ## 三条既有约定（这三条与模块一起看才成立）
//!
//! 1. **公开端点绝不返回 HTTP 401**。`frontend/src/apis/axios.tsx` 的响应拦截器对
//!    **任何** 401 都会清 token 并跳 `/login`——按阅读量的访客会被一脚踢去登录页。
//!    所以：
//!      · 读（`GET stats` / `POST view`）**不需要登录**：拿得到身份就填 `liked`，
//!        拿不到就 `liked: false`——这是**正常成功**，不是降级、不是错误；
//!      · 写（`POST/DELETE like`）需要登录，失败走**信封错误**（HTTP 200 + code=500 +
//!        中文原因），与 `/api/protected/quota`、`profile.rs` 那一族完全一致。
//! 2. **写端点挂 `public_routes` + handler 内自己鉴权**（`crate::auth_jwt::auth_uid`）。
//!    挂进 `protected_routes` 会被 `auth_guard` 按 `authz::can_access_console` 把
//!    普通用户全部 403 掉——那是后台守卫，不是"登录守卫"。
//! 3. **文章可见性判据与 `notes.rs::get_note_detail` 逐字同源**（`is_public = true`
//!    且 `status <> 'draft'`）。阅读量只记在"读者真的能打开的文章"上：前端只在详情页
//!    加载成功后上报，而这里再做一次同样的判定，幻觉 id（`/article/17`）因此连行都建不出来。
//!    注意这是**查询级**判据（NULL status 会被 SQL 的 `<>` 滤掉），与 `profile.rs`
//!    那个模型级 `visible_note`（NULL 视为可见）**不是同一个东西**，别互相替换。
//!
//! ## 报表口径
//!
//! `GET /api/protected/stats/notes` 挂在 `protected_routes` 下 ⇒ 自动只有 admin 进得来
//! （与 `stats.rs::user_stats` 同一条纪律；agent 以发起人身份代调）。
//! 总量、排行榜、日趋势**三者同一口径：只算当前可见的文章**——否则报表自己跟自己打架
//! （总量把已转草稿的文章算进去、排行榜却列不出它）。
//! 注意"可见"是**当下**的可见性，与迁移头注的语义 ② 呼应：文章转草稿不会让 `note_view`
//! 的行消失，但会立刻从报表里消失。

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    sea_query::{Alias, Expr, OnConflict, SimpleExpr},
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect,
    Set,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::entity::{note, note_like, note_view, user_favorite};
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// 排行榜长度（阅读榜、点赞榜、收藏榜各取前 N；**Python 侧 `reports._RANK_TOP` 是同一个
/// 数**，报表里那句"下列前 N 名"按它写，改一侧必须同步另一侧）。
const TOP_N: usize = 10;

/// 阅读总量的求和表达式——**所有 `SUM(cnt)` 都必须从这里出去**。
///
/// 为什么需要 `CAST(... AS SIGNED)`：**MySQL 的 `SUM(<整数列>)` 返回的是 `DECIMAL`
/// 而不是 `BIGINT`**，于是 sea-orm 按 `Option<i64>` 解码时当场报
/// `mismatched types; Rust type Option<i64> (as SQL type BIGINT) is not compatible
/// with SQL type DECIMAL`。这不是编译期能发现的（`cargo check`/`cargo test` 全绿，
/// 仓里的 api_tests 走 MockDatabase 不经过真解码），20260930 一部署就现形：
/// 列表卡片三个数一个都不显示、`GET .../stats` 直接 500。
/// 丢给 `COUNT(*)` 没有这个问题（它本来就是 BIGINT）——**只有求和要过这一手**。
fn sum_views() -> SimpleExpr {
    Expr::col(note_view::Column::Cnt).sum().cast_as(Alias::new("SIGNED"))
}

/// 日趋势窗口（含今天，向前共 30 天）。
const TREND_DAYS: i64 = 30;

// ─────────────────────────────────────────────────────────────────────────────
// 出参
// ─────────────────────────────────────────────────────────────────────────────

/// 单篇文章的读数。`views`/`likes`/`favorites` 是**计数**，`liked` 是**"当前这位访客
/// 点过没有"**。
///
/// `favorites`（20260930 补）与卡片上那一排是同一个数（`counts_for` 的第三张表）：
/// 卡片（列表）早就有它了，单篇读数此前只有两个数——**看板娘读文章详情时因此答不出
/// "这篇有多少人收藏"**，而列表帧里同一个数又是有的（自相矛盾的两份事实）。
/// 它是**计数**、不是"我收藏了没有"（那个状态在 `user_favorite` 里按 uid 存，
/// 此处刻意不做成 `favorited: bool`：读接口拿不到身份时按 `liked` 的成例会恒 false，
/// 那是个假事实）。
#[derive(Serialize, Default)]
pub struct NoteStatsDto {
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    /// 未登录 / 令牌已收回 / 账号被冻结 ⇒ false。**这不表示"请求失败"**（见模块头注 1）。
    pub liked: bool,
}

/// 点赞/取消点赞的回执：只回点赞那半边（阅读量是另一个量，不由这个动作改变，
/// 不在这里顺带回一份可能过期的副本）。
#[derive(Serialize, Default)]
pub struct LikeDto {
    pub likes: i64,
    pub liked: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// 读取（公开，无需登录）
// ─────────────────────────────────────────────────────────────────────────────

/// 文章是否"读者能打开"。与 `notes.rs::get_note_detail` 的两行 filter 同源——
/// **改这里必须同时改那里**（两边不一致会让"能打开的文章读不到数"或反之）。
async fn visible_note_id(db: &DatabaseConnection, id: i32) -> bool {
    note::Entity::find_by_id(id)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .select_only()
        .column(note::Column::Id)
        .into_tuple::<i32>()
        .one(db)
        .await
        .unwrap_or(None)
        .is_some()
}

/// 单篇阅读总量。没有任何行时 `SUM()` 是 NULL ⇒ 归零。
/// 用 `Option<i64>` 接住是**必须**的：直接 `into_tuple::<i64>()` 在零行时会解码失败。
async fn views_of(db: &DatabaseConnection, note_id: i32) -> Result<i64, DbErr> {
    note_view::Entity::find()
        .select_only()
        .column_as(sum_views(), "total")
        .filter(note_view::Column::NoteId.eq(note_id))
        .into_tuple::<Option<i64>>()
        .one(db)
        .await
        .map(|v| v.flatten().unwrap_or(0))
}

async fn likes_of(db: &DatabaseConnection, note_id: i32) -> Result<i64, DbErr> {
    note_like::Entity::find()
        .filter(note_like::Column::NoteId.eq(note_id))
        .count(db)
        .await
        .map(|n| n as i64)
}

/// 收藏数。`COUNT(*)`（BIGINT）而非 `SUM`——**没有 `sum_views` 那个 DECIMAL 陷阱**
/// （见 `sum_views` 的注释：只有求和要过 `CAST`）。
async fn favorites_of(db: &DatabaseConnection, note_id: i32) -> Result<i64, DbErr> {
    user_favorite::Entity::find()
        .filter(user_favorite::Column::NoteId.eq(note_id))
        .count(db)
        .await
        .map(|n| n as i64)
}

/// 这个人点过没有。`None`（未登录/令牌作废）= 没点过。
async fn liked_by(db: &DatabaseConnection, note_id: i32, uid: Option<i32>) -> bool {
    let Some(uid) = uid else { return false };
    note_like::Entity::find()
        .filter(note_like::Column::NoteId.eq(note_id))
        .filter(note_like::Column::UserId.eq(uid))
        .select_only()
        .column(note_like::Column::Id)
        .into_tuple::<i32>()
        .one(db)
        .await
        .unwrap_or(None)
        .is_some()
}

/// 尽力而为的身份：**失败一律当未登录**，不向上传播错误。
/// 这正是模块头注第 1 条的落地——读接口不能因为"令牌过期"就整条请求失败。
async fn optional_uid(db: &DatabaseConnection, headers: &HeaderMap) -> Option<i32> {
    crate::auth_jwt::auth_uid(db, headers).await.ok()
}

/// 组装单篇读数（`POST view` 与 `GET stats` 共用一份，保证两条路的形状一致）。
async fn read_stats(
    db: &DatabaseConnection,
    note_id: i32,
    uid: Option<i32>,
) -> Result<NoteStatsDto, DbErr> {
    Ok(NoteStatsDto {
        views: views_of(db, note_id).await?,
        likes: likes_of(db, note_id).await?,
        favorites: favorites_of(db, note_id).await?,
        liked: liked_by(db, note_id, uid).await,
    })
}

/// 文章不存在 / 不可见：**404**（与 `notes.rs::get_note_detail` 同一形状）。
/// 前端只在详情页加载成功后才调用本模块，所以正常流程永远走不到这里。
fn note_gone() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ApiResponse {
            code: 404,
            message: "文章不存在".to_string(),
            data: Option::<NoteStatsDto>::None,
        }),
    )
        .into_response()
}

/// GET /api/public/notes/:id/stats
pub async fn note_stats(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    if !visible_note_id(&state.db, id).await {
        return note_gone();
    }
    let uid = optional_uid(&state.db, &headers).await;
    match read_stats(&state.db, id, uid).await {
        Ok(dto) => Json(ApiResponse::success(dto)).into_response(),
        Err(e) => {
            tracing::error!("[note_stats] 读取读数失败 note={}: {}", id, e);
            Json(ApiResponse::<NoteStatsDto>::error("统计查询失败，请稍后再试")).into_response()
        }
    }
}

/// POST /api/public/notes/:id/view —— 记一次阅读（**同一访客同一天只该调用一次**，
/// 去重在前端；这里不做访客级去重，因为服务端没有"访客"这个身份）。
///
/// 顺手把读数一并回给前端（省一次往返：上报与取数是同一个时刻的事实）。
pub async fn report_view(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    if !visible_note_id(&state.db, id).await {
        return note_gone();
    }
    // 一篇文章一天一行；撞唯一键就 `cnt = cnt + 1`。
    // **不在 Rust 侧算 "上次 + 1"**——那需要先读后写，两个并发请求会互相覆盖。
    let today = chrono::Local::now().date_naive();
    let am = note_view::ActiveModel {
        note_id: Set(id),
        view_date: Set(today),
        cnt: Set(1),
        ..Default::default()
    };
    if let Err(e) = note_view::Entity::insert(am)
        .on_conflict(
            OnConflict::columns([note_view::Column::NoteId, note_view::Column::ViewDate])
                .values([(
                    note_view::Column::Cnt,
                    Expr::col(note_view::Column::Cnt).add(1).into(),
                )])
                .to_owned(),
        )
        .exec_without_returning(&state.db)
        .await
    {
        // 记不上就记不上：读者的正文照常显示，**不能因为统计失败让整页报错**
        // （前端也只是把它当"这次没数"，不弹提示）。
        tracing::warn!("[note_stats] 阅读上报失败 note={}: {}", id, e);
    }
    let uid = optional_uid(&state.db, &headers).await;
    match read_stats(&state.db, id, uid).await {
        Ok(dto) => Json(ApiResponse::success(dto)).into_response(),
        Err(e) => {
            tracing::error!("[note_stats] 上报后回读失败 note={}: {}", id, e);
            Json(ApiResponse::<NoteStatsDto>::error("统计查询失败，请稍后再试")).into_response()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 点赞 / 取消点赞（需要登录；失败走信封错误，**不是 401**）
// ─────────────────────────────────────────────────────────────────────────────

/// 点赞与取消点赞共用的一段：先鉴权，再确认文章可见。
/// 返回 `Err(响应)` 表示已经可以原样返回给前端了。
async fn like_prelude(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    id: i32,
) -> Result<i32, Response> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, headers).await {
        Ok(uid) => uid,
        Err(e) => {
            return Err(Json(ApiResponse::<LikeDto>::error(e.message())).into_response())
        }
    };
    if !visible_note_id(&state.db, id).await {
        return Err(Json(ApiResponse::<LikeDto>::error("这篇文章不存在")).into_response());
    }
    Ok(uid)
}

/// 点赞后的回执（顺带回读一次总数，不在 Rust 侧自增）。
async fn like_dto(db: &DatabaseConnection, id: i32, liked: bool) -> Json<ApiResponse<LikeDto>> {
    match likes_of(db, id).await {
        Ok(likes) => Json(ApiResponse::success(LikeDto { likes, liked })),
        Err(e) => {
            tracing::error!("[note_stats] 点赞后回读失败 note={}: {}", id, e);
            Json(ApiResponse::error("统计查询失败，请稍后再试"))
        }
    }
}

/// POST /api/public/notes/:id/like —— 幂等（重复点赞照样回成功，与收藏一致）。
pub async fn like_note(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    let uid = match like_prelude(&state, &headers, id).await {
        Ok(uid) => uid,
        Err(resp) => return resp,
    };
    let existed = liked_by(&state.db, id, Some(uid)).await;
    if !existed {
        let am = note_like::ActiveModel {
            note_id: Set(id),
            user_id: Set(uid),
            ..Default::default()
        };
        if let Err(e) = note_like::Entity::insert(am).exec_without_returning(&state.db).await {
            // 并发下两个请求同时走到这里 → `uq_like_note_user` 拦下第二个。
            // **不能只看错误类型断言"是撞唯一键"**（同 `profile.rs::add_favorite` 的取舍）：
            // 回查一次，现在真有一行就算成功，否则才是真失败。
            if !liked_by(&state.db, id, Some(uid)).await {
                tracing::error!("[note_stats] 点赞失败 uid={} note={}: {}", uid, id, e);
                return Json(ApiResponse::<LikeDto>::error("点赞失败，请稍后再试")).into_response();
            }
        }
    }
    like_dto(&state.db, id, true).await.into_response()
}

/// DELETE /api/public/notes/:id/like —— 取消点赞（幂等：没点过也回成功）。
pub async fn unlike_note(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    let uid = match like_prelude(&state, &headers, id).await {
        Ok(uid) => uid,
        Err(resp) => return resp,
    };
    if let Err(e) = note_like::Entity::delete_many()
        .filter(note_like::Column::NoteId.eq(id))
        .filter(note_like::Column::UserId.eq(uid))
        .exec(&state.db)
        .await
    {
        tracing::error!("[note_stats] 取消点赞失败 uid={} note={}: {}", uid, id, e);
        return Json(ApiResponse::<LikeDto>::error("操作失败，请稍后再试")).into_response();
    }
    like_dto(&state.db, id, false).await.into_response()
}

// ─────────────────────────────────────────────────────────────────────────────
// 批量计数（文章卡片上的三个数：阅读 / 点赞 / 收藏）
// ─────────────────────────────────────────────────────────────────────────────

/// 一篇文章的公共计数。三个数**不同源**：阅读来自 `note_view`、点赞来自 `note_like`、
/// 收藏来自 `user_favorite`（20260922 收藏功能）——但对卡片来说它们是一排三个数，
/// 所以一次取齐、不拆成三个接口。
#[derive(Clone, Copy, Default)]
pub struct NoteCounts {
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
}

/// `GROUP BY note_id` 的结果收进 `note_id → 合计`。`SUM()`/`COUNT()` 在零行时是 NULL
/// ⇒ 折成 0（**这里折零是对的**：行是 SQL 为空，不是"查不到"）。
fn collect(r: Result<Vec<(i32, Option<i64>)>, DbErr>) -> Result<HashMap<i32, i64>, DbErr> {
    r.map(|v| v.into_iter().map(|(id, n)| (id, n.unwrap_or(0))).collect())
}

/// 一批文章的计数。**每张表一条 `GROUP BY` 查询（共三条）**，不是"每篇文章三条查询"——
/// 列表一页 6–48 篇，逐篇查会把 6 次往返放大成 144 次。
///
/// 只算传进来的 id：调用方给的是本页真正要渲染的那些行，不会顺手把全站算一遍。
/// 空列表必须短路——`IN ()` 是 SQL 语法错误（同上面报表里那处）。
pub async fn counts_for(
    db: &DatabaseConnection,
    ids: &[i32],
) -> Result<HashMap<i32, NoteCounts>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids = ids.to_vec();

    let views = collect(
        note_view::Entity::find()
            .select_only()
            .column(note_view::Column::NoteId)
            .column_as(sum_views(), "total")
            .filter(note_view::Column::NoteId.is_in(ids.clone()))
            .group_by(note_view::Column::NoteId)
            .into_tuple::<(i32, Option<i64>)>()
            .all(db)
            .await,
    )?;
    let likes = collect(
        note_like::Entity::find()
            .select_only()
            .column(note_like::Column::NoteId)
            .column_as(Expr::col(note_like::Column::Id).count(), "total")
            .filter(note_like::Column::NoteId.is_in(ids.clone()))
            .group_by(note_like::Column::NoteId)
            .into_tuple::<(i32, Option<i64>)>()
            .all(db)
            .await,
    )?;
    let favorites = collect(
        user_favorite::Entity::find()
            .select_only()
            .column(user_favorite::Column::NoteId)
            .column_as(Expr::col(user_favorite::Column::Id).count(), "total")
            .filter(user_favorite::Column::NoteId.is_in(ids.clone()))
            .group_by(user_favorite::Column::NoteId)
            .into_tuple::<(i32, Option<i64>)>()
            .all(db)
            .await,
    )?;

    // **SQL 不会为"没人读过"的文章造行**，所以这里按传入的 id 逐个补零。对"列表里真实
    // 存在的文章"来说 0 是**事实**（它存在，只是还没人读过），与"根本取不到数"要分开表达：
    // 调用方的 DTO 用 `Some(0)` / `None` 区分这两件事，卡片只在 `Some` 时渲染那一排。
    Ok(ids
        .into_iter()
        .map(|id| {
            (
                id,
                NoteCounts {
                    views: views.get(&id).copied().unwrap_or(0),
                    likes: likes.get(&id).copied().unwrap_or(0),
                    favorites: favorites.get(&id).copied().unwrap_or(0),
                },
            )
        })
        .collect())
}

// ─────────────────────────────────────────────────────────────────────────────
// 后台报表（protected_routes ⇒ 只有 admin）
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
pub struct NoteRankRow {
    #[serde(rename = "noteId")]
    pub note_id: i32,
    pub title: String,
    /// 三个数**每一行都带**（哪怕这一行只出现在另一个榜上）：榜是按其中一个数排的，
    /// 但看榜的人（后台与看板娘）下一个问题必然是"那篇的赞/收藏呢"。
    /// `rank()` 只按 `metric` 排序，**不改这三个数**。
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
}

#[derive(Serialize, Default)]
pub struct DailyRow {
    /// `YYYY-MM-DD`（本地统计日）
    pub date: String,
    pub views: i64,
    pub likes: i64,
}

#[derive(Serialize, Default)]
pub struct NoteStatsReportDto {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    /// 当前可见文章的阅读量合计（含未进榜的文章）——与排行榜同一口径，见模块头注
    #[serde(rename = "totalViews")]
    pub total_views: i64,
    #[serde(rename = "totalLikes")]
    pub total_likes: i64,
    /// 当前可见文章的收藏量合计（同 `total_views`/`total_likes` 的口径）
    #[serde(rename = "totalFavorites")]
    pub total_favorites: i64,
    /// 三个榜：**数组顺序即名次**（第 0 项 = 第 1 名），没有单独的 rank 字段。
    /// 同一个名次在不同榜上可以不是同一篇——消费方（后台面板 / 看板娘报表）
    /// 必须把"哪个榜的第几名"说清楚，别把两个榜的序号串起来用。
    #[serde(rename = "topViewed")]
    pub top_viewed: Vec<NoteRankRow>,
    #[serde(rename = "topLiked")]
    pub top_liked: Vec<NoteRankRow>,
    #[serde(rename = "topFavorited")]
    pub top_favorited: Vec<NoteRankRow>,
    /// 最近 30 天，**定长 30 行、缺日补零**（见下）
    pub daily: Vec<DailyRow>,
}

/// 当前可见的文章：`id → title`。**只取两列**，绝不 `SELECT *`
/// （`note.content` 是整篇正文，报表用不到，捞出来只是白白吃内存）。
async fn visible_notes(db: &DatabaseConnection) -> Result<Vec<(i32, String)>, DbErr> {
    note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .column(note::Column::Title)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .into_tuple::<(i32, String)>()
        .all(db)
        .await
}

/// 排行榜排序 + 截断：数值倒序 → id 升序（全并列时顺序确定，两次报表可比对，
/// 同 `stats.rs` 的取舍）。按 `metric` 指定的那张表排——`rows` 里两列都带着，
/// 榜上同时看得到阅读量与点赞量。
fn rank(mut rows: Vec<NoteRankRow>, metric: &HashMap<i32, i64>) -> Vec<NoteRankRow> {
    rows.sort_by(|a, b| {
        let ka = metric.get(&a.note_id).copied().unwrap_or(0);
        let kb = metric.get(&b.note_id).copied().unwrap_or(0);
        kb.cmp(&ka).then(a.note_id.cmp(&b.note_id))
    });
    rows.truncate(TOP_N);
    rows
}

/// `GROUP BY note_id` 的求和，回一张 `note_id → 合计` 的表。
async fn sum_by_note(
    r: Result<Vec<(i32, Option<i64>)>, DbErr>,
    what: &str,
) -> Result<HashMap<i32, i64>, String> {
    match r {
        Ok(v) => Ok(v.into_iter().map(|(id, s)| (id, s.unwrap_or(0))).collect()),
        Err(e) => {
            tracing::error!("[stats] {what} 聚合失败: {e}");
            Err("统计查询失败，请稍后再试".to_string())
        }
    }
}

/// GET /api/protected/stats/notes —— 见模块头注的"报表口径"。
pub async fn note_report(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<NoteStatsReportDto>> {
    let db = &state.db;

    let notes = match visible_notes(db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[stats] note 可见性查询失败: {e}");
            return Json(ApiResponse::error("统计查询失败，请稍后再试"));
        }
    };
    let titles: HashMap<i32, String> = notes.iter().cloned().collect();
    let ids: Vec<i32> = notes.iter().map(|(id, _)| *id).collect();

    let views = match sum_by_note(
        note_view::Entity::find()
            .select_only()
            .column(note_view::Column::NoteId)
            .column_as(sum_views(), "total")
            .group_by(note_view::Column::NoteId)
            .into_tuple::<(i32, Option<i64>)>()
            .all(db)
            .await,
        "note_view",
    )
    .await
    {
        Ok(m) => m,
        Err(e) => return Json(ApiResponse::error(&e)),
    };
    let likes = match sum_by_note(
        note_like::Entity::find()
            .select_only()
            .column(note_like::Column::NoteId)
            .column_as(Expr::col(note_like::Column::Id).count(), "total")
            .group_by(note_like::Column::NoteId)
            .into_tuple::<(i32, Option<i64>)>()
            .all(db)
            .await,
        "note_like",
    )
    .await
    {
        Ok(m) => m,
        Err(e) => return Json(ApiResponse::error(&e)),
    };

    let favorites = match sum_by_note(
        user_favorite::Entity::find()
            .select_only()
            .column(user_favorite::Column::NoteId)
            .column_as(Expr::col(user_favorite::Column::Id).count(), "total")
            .group_by(user_favorite::Column::NoteId)
            .into_tuple::<(i32, Option<i64>)>()
            .all(db)
            .await,
        "user_favorite",
    )
    .await
    {
        Ok(m) => m,
        Err(e) => return Json(ApiResponse::error(&e)),
    };

    let all_rows = |m: &HashMap<i32, i64>| -> Vec<NoteRankRow> {
        titles
            .iter()
            .map(|(id, title)| NoteRankRow {
                note_id: *id,
                title: title.clone(),
                views: views.get(id).copied().unwrap_or(0),
                likes: likes.get(id).copied().unwrap_or(0),
                favorites: favorites.get(id).copied().unwrap_or(0),
            })
            .filter(|r| m.get(&r.note_id).copied().unwrap_or(0) > 0)
            .collect()
    };
    let top_viewed = rank(all_rows(&views), &views);
    let top_liked = rank(all_rows(&likes), &likes);
    let top_favorited = rank(all_rows(&favorites), &favorites);

    // 趋势：最近 30 天。**必须补零**——SQL 不会为没流量的日子造行，直接返回会给出
    // 一根根断掉的横轴（周五有数、周六周日整个消失，看起来像数据丢了）。
    let today = chrono::Local::now().date_naive();
    let start = today - chrono::Duration::days(TREND_DAYS - 1);
    let mut daily: HashMap<chrono::NaiveDate, DailyRow> = HashMap::new();
    for i in 0..TREND_DAYS {
        let d = start + chrono::Duration::days(i);
        daily.insert(
            d,
            DailyRow { date: d.format("%Y-%m-%d").to_string(), views: 0, likes: 0 },
        );
    }
    // 空 id 列表会让 `IN ()` 成为语法错误 ⇒ 先短路（库里一篇文章都没有的情况）
    if !ids.is_empty() {
        match note_view::Entity::find()
            .select_only()
            .column(note_view::Column::ViewDate)
            .column_as(sum_views(), "total")
            .filter(note_view::Column::NoteId.is_in(ids.clone()))
            .filter(note_view::Column::ViewDate.gte(start))
            .group_by(note_view::Column::ViewDate)
            .into_tuple::<(chrono::NaiveDate, Option<i64>)>()
            .all(db)
            .await
        {
            Ok(rows) => {
                for (d, s) in rows {
                    if let Some(row) = daily.get_mut(&d) {
                        row.views = s.unwrap_or(0);
                    }
                }
            }
            Err(e) => {
                tracing::error!("[stats] note_view 日趋势失败: {e}");
                return Json(ApiResponse::error("统计查询失败，请稍后再试"));
            }
        }
        // 点赞的日趋势按 `created_at` 的**日期**分桶。不用 SQL 的 DATE() 转换：
        // 那条路要拼方言相关的表达式，而 30 天内的点赞行数很少，取回本地分桶更直白
        // （只取一列，不会 SELECT *）。
        let cutoff = (today - chrono::Duration::days(TREND_DAYS - 1))
            .and_hms_opt(0, 0, 0)
            .unwrap_or_default();
        match note_like::Entity::find()
            .select_only()
            .column(note_like::Column::CreatedAt)
            .filter(note_like::Column::NoteId.is_in(ids.clone()))
            .filter(note_like::Column::CreatedAt.gte(cutoff))
            .into_tuple::<chrono::NaiveDateTime>()
            .all(db)
            .await
        {
            Ok(rows) => {
                for t in rows {
                    if let Some(row) = daily.get_mut(&t.date()) {
                        row.likes += 1;
                    }
                }
            }
            Err(e) => {
                tracing::error!("[stats] note_like 日趋势失败: {e}");
                return Json(ApiResponse::error("统计查询失败，请稍后再试"));
            }
        }
    }

    let visible_ids: HashSet<i32> = ids.iter().copied().collect();
    let total_views: i64 = views
        .iter()
        .filter(|(id, _)| visible_ids.contains(id))
        .map(|(_, v)| *v)
        .sum();
    let total_likes: i64 = likes
        .iter()
        .filter(|(id, _)| visible_ids.contains(id))
        .map(|(_, v)| *v)
        .sum();
    let total_favorites: i64 = favorites
        .iter()
        .filter(|(id, _)| visible_ids.contains(id))
        .map(|(_, v)| *v)
        .sum();

    let mut daily: Vec<DailyRow> = daily.into_values().collect();
    daily.sort_by(|a, b| a.date.cmp(&b.date));

    Json(ApiResponse::success(NoteStatsReportDto {
        generated_at: crate::routes::stats::format_ts(chrono::Local::now().naive_local()),
        total_views,
        total_likes,
        total_favorites,
        top_viewed,
        top_liked,
        top_favorited,
        daily,
    }))
}
