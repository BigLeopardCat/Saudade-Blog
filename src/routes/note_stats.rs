mod periods;
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
#[cfg(test)]
use periods::{last_day_of_month, period_at, Granularity};
pub use periods::{note_period_report, PeriodReportDto, PeriodRow};
use sea_orm::{
    sea_query::{Alias, Condition, Expr, OnConflict, SimpleExpr},
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QuerySelect, Set,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::entity::{note, note_comment, note_like, note_view, user_favorite};
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// Global leaderboards contain at most ten entries per metric.
const TOP_N: usize = 10;

/// Each natural-period report contains at most five ranked articles.
const PERIOD_TOP_N: usize = 5;

// Fix the SQL result type so every view-total query decodes as i64.
fn sum_views() -> SimpleExpr {
    Expr::col(note_view::Column::Cnt)
        .sum()
        .cast_as(Alias::new("BIGINT"))
}

/// 日趋势窗口（含今天，向前共 30 天）。
const TREND_DAYS: i64 = 30;

// 出参

#[derive(Serialize, Default)]
pub struct NoteStatsDto {
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    pub comments: i64,
    /// An absent or invalid identity has no actor-specific liked state.
    pub liked: bool,
}

/// 点赞/取消点赞的回执：只回点赞那半边（阅读量是另一个量，不由这个动作改变，
/// 不在这里顺带回一份可能过期的副本）。
#[derive(Serialize, Default)]
pub struct LikeDto {
    pub likes: i64,
    pub liked: bool,
}

// 读取（公开，无需登录）

/// Metrics share the published-root boundary with public content reads.
async fn visible_note_id<C: ConnectionTrait>(db: &C, id: i32) -> Result<bool, DbErr> {
    note::Entity::find_by_id(id)
        .filter(super::notes::public_condition())
        .select_only()
        .column(note::Column::Id)
        .into_tuple::<i32>()
        .one(db)
        .await
        .map(|row| row.is_some())
}

fn stats_unavailable(error: &DbErr) -> Response {
    tracing::warn!(error=%error, "article statistics unavailable");
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiResponse::<serde_json::Value> {
            code: 503,
            message: "统计暂不可用，请稍后重试".into(),
            data: serde_json::Value::Null,
        }),
    )
        .into_response()
}

/// An empty SUM is NULL, represented as zero only after a successful database read.
async fn views_of<C: ConnectionTrait>(db: &C, note_id: i32) -> Result<i64, DbErr> {
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

/// Favorite totals count rows rather than summing a mutable counter.
async fn favorites_of(db: &DatabaseConnection, note_id: i32) -> Result<i64, DbErr> {
    user_favorite::Entity::find()
        .filter(user_favorite::Column::NoteId.eq(note_id))
        .count(db)
        .await
        .map(|n| n as i64)
}

async fn comments_of(db: &DatabaseConnection, note_id: i32) -> Result<i64, DbErr> {
    note_comment::Entity::find()
        .filter(note_comment::Column::NoteId.eq(note_id))
        .filter(note_comment::Column::Approved.eq(1))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .count(db)
        .await
        .map(|n| n as i64)
}

/// 匿名访客标识的请求头名。**读取端只此一处**（要改名就改这里 + 前端 `visitorKey.ts`）。
const VISITOR_HEADER: &str = "x-visitor-key";
/// 标识长度下限。太短的 key（两三个字符）会被不同的人/脚本轻易撞上，等于没有去重；
/// 前端生成的是 UUID（36 字符），这个下限只是拦明显不认真的调用方。
const VISITOR_MIN: usize = 8;
/// 访客标识上限与 note_like.visitor_key 列宽一致。
const VISITOR_MAX: usize = 64;

/// 从请求头取匿名访客标识（**尽力而为**：缺失/格式不对一律当"没有"）。
///
/// 为什么敢用一个客户端自报的值当去重键：**它不是身份凭据**。伪造它最多让同一个人
/// 多点几个赞，换不来任何权限（能拿到的东西与"没登录的访客"完全一样）。
/// 字符集只收 `[A-Za-z0-9_-]`——白名单比"转义黑名单"少一整类将来才会发现的洞。
fn visitor_key(headers: &HeaderMap) -> Option<String> {
    let k = headers.get(VISITOR_HEADER)?.to_str().ok()?.trim();
    if k.len() < VISITOR_MIN || k.len() > VISITOR_MAX {
        return None;
    }
    if !k
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some(k.to_string())
}

pub(super) enum Who {
    User {
        uid: i32,
        key: Option<String>,
    },
    /// 匿名访客：只有浏览器自报的标识。
    Visitor(String),
}

impl Who {
    /// 日志里的身份标签。**不打印完整的 `visitor_key`**：它对排障没用（认不出人是谁），
    /// 却会被抄进长期留存的日志文件——前 8 位足够把"同一台浏览器的几次请求"对上号。
    /// （标识是纯 ASCII，切片不会切到多字节字符中间。）
    pub(super) fn tag(&self) -> String {
        match self {
            Who::User { uid, .. } => format!("uid={}", uid),
            Who::Visitor(k) => format!("visitor={}…", &k[..k.len().min(8)]),
        }
    }

    /// 登录用户的 uid（匿名访客为 `None`）。给需要"这条评论是不是他发的"这类
    /// 与访客无关的判据用——**别拿它当"有没有身份"**：匿名访客也有身份。
    pub(super) fn uid(&self) -> Option<i32> {
        match self {
            Who::User { uid, .. } => Some(*uid),
            Who::Visitor(_) => None,
        }
    }

    pub(super) fn cond_on<UC, VC>(&self, user_col: UC, visitor_col: VC) -> Condition
    where
        UC: ColumnTrait + Copy,
        VC: ColumnTrait + Copy,
    {
        match self {
            Who::User { uid, key } => {
                let own = Condition::any().add(user_col.eq(*uid));
                match key {
                    Some(k) => own.add(
                        Condition::all()
                            .add(user_col.is_null())
                            .add(visitor_col.eq(k.clone())),
                    ),
                    None => own,
                }
            }
            Who::Visitor(k) => {
                // `user_id IS NULL` 是白写的（登录行一律 visitor_key=NULL，见插入处），
                // 但把它写上等于把这条不变量钉在查询里，不必让读者去别处求证。
                Condition::all()
                    .add(user_col.is_null())
                    .add(visitor_col.eq(k.clone()))
            }
        }
    }

    /// 这个身份在 `note_like` 里对应的过滤条件。
    fn cond(&self) -> Condition {
        self.cond_on(note_like::Column::UserId, note_like::Column::VisitorKey)
    }
}

/// 区分有效身份、未提供身份和身份校验失败；带无效凭据的写请求不降级为匿名。
pub(super) async fn identify(
    db: &DatabaseConnection,
    headers: &HeaderMap,
) -> Result<Option<Who>, crate::auth_jwt::AuthError> {
    match crate::auth_jwt::auth_uid(db, headers).await {
        Ok(uid) => Ok(Some(Who::User {
            uid,
            key: visitor_key(headers),
        })),
        Err(crate::auth_jwt::AuthError::Missing) => Ok(visitor_key(headers).map(Who::Visitor)),
        Err(e) => Err(e),
    }
}

/// 这个人点过没有。`None`（未登录且无访客标识）= 没点过。
async fn liked_by(db: &DatabaseConnection, note_id: i32, who: Option<&Who>) -> bool {
    let Some(who) = who else { return false };
    note_like::Entity::find()
        .filter(note_like::Column::NoteId.eq(note_id))
        .filter(who.cond())
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
pub(super) async fn optional_who(db: &DatabaseConnection, headers: &HeaderMap) -> Option<Who> {
    identify(db, headers).await.ok().flatten()
}

/// 组装单篇读数（`POST view` 与 `GET stats` 共用一份，保证两条路的形状一致）。
async fn read_stats(
    db: &DatabaseConnection,
    note_id: i32,
    who: Option<&Who>,
) -> Result<NoteStatsDto, DbErr> {
    Ok(NoteStatsDto {
        views: views_of(db, note_id).await?,
        likes: likes_of(db, note_id).await?,
        favorites: favorites_of(db, note_id).await?,
        comments: comments_of(db, note_id).await?,
        liked: liked_by(db, note_id, who).await,
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
    match visible_note_id(&state.db, id).await {
        Ok(true) => {}
        Ok(false) => return note_gone(),
        Err(error) => return stats_unavailable(&error),
    }
    let who = optional_who(&state.db, &headers).await;
    match read_stats(&state.db, id, who.as_ref()).await {
        Ok(dto) => Json(ApiResponse::success(dto)).into_response(),
        Err(error) => stats_unavailable(&error),
    }
}

/// POST /api/public/notes/:id/view —— 记一次阅读（**同一访客同一天只该调用一次**，
/// 去重在前端；这里不做访客级去重，因为服务端没有"访客"这个身份）。
///
/// Return the resulting counters after the view mutation.
pub async fn report_view(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    match visible_note_id(&state.db, id).await {
        Ok(true) => {}
        Ok(false) => return note_gone(),
        Err(error) => return stats_unavailable(&error),
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
                    // Qualify the accumulated value to distinguish it from EXCLUDED.
                    Expr::col((note_view::Entity, note_view::Column::Cnt))
                        .add(1)
                        .into(),
                )])
                .to_owned(),
        )
        .exec_without_returning(&state.db)
        .await
    {
        // 统计失败不影响文章阅读。
        tracing::warn!("[note_stats] 阅读上报失败 note={}: {}", id, e);
    }
    let who = optional_who(&state.db, &headers).await;
    match read_stats(&state.db, id, who.as_ref()).await {
        Ok(dto) => Json(ApiResponse::success(dto)).into_response(),
        Err(e) => {
            tracing::error!("[note_stats] 上报后回读失败 note={}: {}", id, e);
            Json(ApiResponse::<NoteStatsDto>::error(
                "统计查询失败，请稍后再试",
            ))
            .into_response()
        }
    }
}

/// 点赞与取消点赞共用的一段：先认身份，再确认文章可见。
/// 返回 `Err(响应)` 表示已经可以原样返回给前端了。
async fn like_prelude(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    id: i32,
) -> Result<Who, Response> {
    let who = match identify(&state.db, headers).await {
        Ok(Some(who)) => who,
        // 令牌在、但已经不能用（过期/收回/冻结）：如实回原因，**不降级成匿名**
        Err(e) => return Err(Json(ApiResponse::<LikeDto>::error(e.message())).into_response()),
        // 既没登录也没带访客标识（正常前端永远带）——只有直接 curl 的用户见得到
        Ok(None) => return Err(Json(ApiResponse::<LikeDto>::error("未登录")).into_response()),
    };
    match visible_note_id(&state.db, id).await {
        Ok(true) => {}
        Ok(false) => {
            return Err(Json(ApiResponse::<LikeDto>::error("这篇文章不存在")).into_response())
        }
        Err(error) => return Err(stats_unavailable(&error)),
    }
    Ok(who)
}

/// 登录点赞前清除同一浏览器的匿名点赞，避免重复计数。
async fn insert_like(db: &DatabaseConnection, note_id: i32, who: &Who) -> Result<(), DbErr> {
    if let Who::User { key: Some(k), .. } = who {
        note_like::Entity::delete_many()
            .filter(note_like::Column::NoteId.eq(note_id))
            .filter(note_like::Column::UserId.is_null())
            .filter(note_like::Column::VisitorKey.eq(k.clone()))
            .exec(db)
            .await?;
    }
    let (user_id, visitor_key) = match who {
        Who::User { uid, .. } => (Some(*uid), None),
        Who::Visitor(k) => (None, Some(k.clone())),
    };
    let am = note_like::ActiveModel {
        note_id: Set(note_id),
        user_id: Set(user_id),
        visitor_key: Set(visitor_key),
        ..Default::default()
    };
    if let Err(e) = note_like::Entity::insert(am)
        .exec_without_returning(db)
        .await
    {
        // 并发插入失败后回查；确有记录视为成功，不能把任意数据库错误当作唯一键冲突。
        if !liked_by(db, note_id, Some(who)).await {
            return Err(e);
        }
    }
    Ok(())
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
    let who = match like_prelude(&state, &headers, id).await {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if !liked_by(&state.db, id, Some(&who)).await {
        if let Err(e) = insert_like(&state.db, id, &who).await {
            tracing::error!("[note_stats] 点赞失败 note={} who={}: {}", id, who.tag(), e);
            return Json(ApiResponse::<LikeDto>::error("点赞失败，请稍后再试")).into_response();
        }
    }
    like_dto(&state.db, id, true).await.into_response()
}

/// DELETE /api/public/notes/:id/like —— 取消点赞（幂等：没点过也回成功）。
///
/// 登录态下 `who.cond()` 会连"这台浏览器匿名投的那一票"一起匹配上（见 `Who::cond`），
/// 于是登录后按同一颗心取消，两票一起走——与点赞时"登录会把匿名行升格掉"对称。
pub async fn unlike_note(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    let who = match like_prelude(&state, &headers, id).await {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(e) = note_like::Entity::delete_many()
        .filter(note_like::Column::NoteId.eq(id))
        .filter(who.cond())
        .exec(&state.db)
        .await
    {
        tracing::error!(
            "[note_stats] 取消点赞失败 note={} who={}: {}",
            id,
            who.tag(),
            e
        );
        return Json(ApiResponse::<LikeDto>::error("操作失败，请稍后再试")).into_response();
    }
    like_dto(&state.db, id, false).await.into_response()
}

// 批量计数（文章卡片上的三个数：阅读 / 点赞 / 收藏）

#[derive(Clone, Copy, Default)]
pub struct NoteCounts {
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    /// 讨论数。与 `comments_of` **同一个口径**（`approved = 1 AND is_deleted = 0`），
    /// 见那里的注释。
    pub comments: i64,
}

/// `GROUP BY note_id` 的结果收进 `note_id → 合计`。`SUM()`/`COUNT()` 在零行时是 NULL
/// ⇒ 折成 0（**这里折零是对的**：行是 SQL 为空，不是"查不到"）。
fn collect(r: Result<Vec<(i32, Option<i64>)>, DbErr>) -> Result<HashMap<i32, i64>, DbErr> {
    r.map(|v| v.into_iter().map(|(id, n)| (id, n.unwrap_or(0))).collect())
}

/// 一批文章的计数。**每张表一条 `GROUP BY` 查询（共四条）**，不是"每篇文章四条查询"——
/// 列表一页 6–48 篇，逐篇查会把 6 次往返放大成 288 次。
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
    let comments = collect(
        note_comment::Entity::find()
            .select_only()
            .column(note_comment::Column::NoteId)
            .column_as(Expr::col(note_comment::Column::Id).count(), "total")
            .filter(note_comment::Column::NoteId.is_in(ids.clone()))
            .filter(note_comment::Column::Approved.eq(1))
            .filter(note_comment::Column::IsDeleted.eq(0))
            .group_by(note_comment::Column::NoteId)
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
                    comments: comments.get(&id).copied().unwrap_or(0),
                },
            )
        })
        .collect())
}

// 后台报表（protected_routes ⇒ 只有 admin）

#[derive(Serialize, Default)]
pub struct NoteRankRow {
    #[serde(rename = "noteId")]
    pub note_id: i32,
    pub title: String,
    /// 四个数**每一行都带**（哪怕这一行只出现在另一个榜上）：榜是按其中一个数排的，
    /// 但看榜的人（后台与看板娘）下一个问题必然是"那篇的赞/收藏/讨论呢"。
    /// `rank()` 只按 `metric` 排序，**不改这四个数**。
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    pub comments: i64,
}

#[derive(Serialize, Default)]
pub struct DailyRow {
    /// `YYYY-MM-DD`（本地统计日）
    pub date: String,
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    pub comments: i64,
}

mod window;
pub use window::DailyWindow;

#[derive(Serialize, Default)]
pub struct NoteStatsReportDto {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    /// 当前可见文章的阅读量合计，包含未进入排行榜的文章。
    #[serde(rename = "totalViews")]
    pub total_views: i64,
    #[serde(rename = "totalLikes")]
    pub total_likes: i64,
    /// 当前可见文章的收藏量合计（同 `total_views`/`total_likes` 的口径）
    #[serde(rename = "totalFavorites")]
    pub total_favorites: i64,
    /// 当前可见文章的讨论量合计（同上面三条口径：只算可见文章上的、且公开看得见的那些评论）
    #[serde(rename = "totalComments")]
    pub total_comments: i64,
    /// 四个榜：**数组顺序即名次**（第 0 项 = 第 1 名），没有单独的 rank 字段。
    /// 同一个名次在不同榜上可以不是同一篇——消费方（后台面板 / 看板娘报表）
    /// 必须把"哪个榜的第几名"说清楚，别把两个榜的序号串起来用。
    #[serde(rename = "topViewed")]
    pub top_viewed: Vec<NoteRankRow>,
    #[serde(rename = "topLiked")]
    pub top_liked: Vec<NoteRankRow>,
    #[serde(rename = "topFavorited")]
    pub top_favorited: Vec<NoteRankRow>,
    #[serde(rename = "topCommented")]
    pub top_commented: Vec<NoteRankRow>,
    /// 最近 30 天，**定长 30 行、缺日补零**（见下）
    pub daily: Vec<DailyRow>,
    #[serde(rename = "dailyWindow")]
    pub daily_window: DailyWindow,
}

/// 当前可见的文章：`id → title`。**只取两列**，绝不 `SELECT *`
/// （`note.content` 是整篇正文，报表用不到，捞出来只是白白吃内存）。
async fn visible_notes(db: &DatabaseConnection) -> Result<Vec<(i32, String)>, DbErr> {
    note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .column(note::Column::Title)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.is_in(super::notes::public_status_words()))
        .into_tuple::<(i32, String)>()
        .all(db)
        .await
}

/// 把一串"发生时刻"按**日期**累加进日趋势表。
///
/// 点赞与收藏走的是同一条路（都是 `created_at`），共用这一个循环——**两处的分桶口径
/// 必须一致**，不然趋势图里两条线会在不同的日界上切（一个按 UTC、一个按本地这种）。
/// `slot` 指定累加到哪一列（`|r| &mut r.likes` / `|r| &mut r.favorites`）。
fn bucket_by_day(
    daily: &mut HashMap<chrono::NaiveDate, DailyRow>,
    rows: Vec<chrono::NaiveDateTime>,
    slot: fn(&mut DailyRow) -> &mut i64,
) {
    for t in rows {
        if let Some(row) = daily.get_mut(&t.date()) {
            *slot(row) += 1;
        }
    }
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

/// GET /api/protected/stats/notes：公开已发布主文章的统计报表。
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

    // 讨论数：**两条过滤与公开讨论区逐字相同**（`approved = 1 AND is_deleted = 0`，
    // 同 `comments_of`）。不加这两条的话后台会数出"点进去看不到的评论"——
    // 那是最容易被当成"数错了"的一类不一致。
    let comments = match sum_by_note(
        note_comment::Entity::find()
            .select_only()
            .column(note_comment::Column::NoteId)
            .column_as(Expr::col(note_comment::Column::Id).count(), "total")
            .filter(note_comment::Column::Approved.eq(1))
            .filter(note_comment::Column::IsDeleted.eq(0))
            .group_by(note_comment::Column::NoteId)
            .into_tuple::<(i32, Option<i64>)>()
            .all(db)
            .await,
        "note_comment",
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
                comments: comments.get(id).copied().unwrap_or(0),
            })
            .filter(|r| m.get(&r.note_id).copied().unwrap_or(0) > 0)
            .collect()
    };
    let top_viewed = rank(all_rows(&views), &views);
    let top_liked = rank(all_rows(&likes), &likes);
    let top_favorited = rank(all_rows(&favorites), &favorites);
    let top_commented = rank(all_rows(&comments), &comments);

    // 趋势：最近 30 天。**必须补零**——SQL 不会为没流量的日子造行，直接返回会给出
    // 一根根断掉的横轴（周五有数、周六周日整个消失，看起来像数据丢了）。
    let today = chrono::Local::now().date_naive();
    let start = today - chrono::Duration::days(TREND_DAYS - 1);
    let mut daily: HashMap<chrono::NaiveDate, DailyRow> = HashMap::new();
    for i in 0..TREND_DAYS {
        let d = start + chrono::Duration::days(i);
        daily.insert(
            d,
            DailyRow {
                date: d.format("%Y-%m-%d").to_string(),
                views: 0,
                likes: 0,
                favorites: 0,
                comments: 0,
            },
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
            Ok(rows) => bucket_by_day(&mut daily, rows, |r| &mut r.likes),
            Err(e) => {
                tracing::error!("[stats] note_like 日趋势失败: {e}");
                return Json(ApiResponse::error("统计查询失败，请稍后再试"));
            }
        }
        // 收藏的日趋势：与点赞同一条路（`user_favorite.created_at` 的日期分桶）
        match user_favorite::Entity::find()
            .select_only()
            .column(user_favorite::Column::CreatedAt)
            .filter(user_favorite::Column::NoteId.is_in(ids.clone()))
            .filter(user_favorite::Column::CreatedAt.gte(cutoff))
            .into_tuple::<chrono::NaiveDateTime>()
            .all(db)
            .await
        {
            Ok(rows) => bucket_by_day(&mut daily, rows, |r| &mut r.favorites),
            Err(e) => {
                tracing::error!("[stats] user_favorite 日趋势失败: {e}");
                return Json(ApiResponse::error("统计查询失败，请稍后再试"));
            }
        }
        // 讨论的日趋势：与点赞/收藏同一条路，只是**多了两条过滤**（公开可见的那些才
        // 算讨论量）。不加过滤线会跳一下——一条待审评论被通过的那一刻才出现在趋势上，
        // 而它一直躺在库里。
        match note_comment::Entity::find()
            .select_only()
            .column(note_comment::Column::CreatedAt)
            .filter(note_comment::Column::NoteId.is_in(ids.clone()))
            .filter(note_comment::Column::CreatedAt.gte(cutoff))
            .filter(note_comment::Column::Approved.eq(1))
            .filter(note_comment::Column::IsDeleted.eq(0))
            .into_tuple::<chrono::NaiveDateTime>()
            .all(db)
            .await
        {
            Ok(rows) => bucket_by_day(&mut daily, rows, |r| &mut r.comments),
            Err(e) => {
                tracing::error!("[stats] note_comment 日趋势失败: {e}");
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
    let total_comments: i64 = comments
        .iter()
        .filter(|(id, _)| visible_ids.contains(id))
        .map(|(_, v)| *v)
        .sum();

    let daily_window = window::summarize(&daily, start, today);
    let mut daily: Vec<DailyRow> = daily.into_values().collect();
    daily.sort_by(|a, b| a.date.cmp(&b.date));

    Json(ApiResponse::success(NoteStatsReportDto {
        generated_at: crate::routes::stats::format_ts(chrono::Local::now().naive_local()),
        total_views,
        total_likes,
        total_favorites,
        total_comments,
        top_viewed,
        top_liked,
        top_favorited,
        top_commented,
        daily,
        daily_window,
    }))
}

/// 期粒度。**白名单**：`kind` 是查询参数，认不出的一律报错，不做"猜一个最像的"。
#[cfg(test)]
mod tests;
