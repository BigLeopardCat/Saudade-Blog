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
//!      · 写（`POST/DELETE like`）失败走**信封错误**（HTTP 200 + code=500 + 中文原因），
//!        与 `/api/protected/quota`、`profile.rs` 那一族完全一致。20261001 起写也
//!        **不再要求登录**（用户第 2 条「点赞改为非登录用户也可以点赞」）：身份 = 登录
//!        账号，或浏览器自报的访客标识（`X-Visitor-Key`）；**两者都没有才回「未登录」**。
//!        匿名点赞把"点赞数"拉到了与阅读量同一档可信度（key 是客户端自己生成、能刷）
//!        ——代价与取舍写在 `scripts/migration/note_like_anon_20261001.sql` 头注
//!        与 `docs/security-boundary.md`，改这一族之前先读那两处。
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
    sea_query::{Alias, Condition, Expr, OnConflict, SimpleExpr},
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect,
    Set,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::entity::{note, note_comment, note_like, note_view, user_favorite};
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// 排行榜长度（阅读榜、点赞榜、收藏榜各取前 N；**Python 侧 `reports._RANK_TOP` 是同一个
/// 数**，报表里那句"下列前 N 名"按它写，改一侧必须同步另一侧）。
const TOP_N: usize = 10;

/// 周报/月报/年报里每期带几篇（**不是** `TOP_N`：那是全局榜的长度，一页十行是榜单该有的
/// 样子；期报里这块是折叠面板展开后的内容，5 行能一屏看完，再多就该去全局榜看）。
const PERIOD_TOP_N: usize = 5;

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
    /// 讨论数（20261003）。**口径必须与公开讨论区逐字相同**：`approved = 1 AND
    /// is_deleted = 0`（同 `comment_counts` 的注释）——否则详情页胶囊上的数会比点进去
    /// 看到的条数多，那是最容易被当成"数错了"的一类不一致。
    pub comments: i64,
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

/// 讨论数（20261003）。**两个 filter 缺一不可，且必须与公开列表同源**：
/// `approved = 1`（待审/驳回的不算，读者根本看不到）`AND is_deleted = 0`（软删的不算）
/// —— `routes/comments.rs::list_comments` 读的正是这两条。数多一条会让详情页胶囊
/// 与点进去的条数对不上（"数错了"是这类计数最容易被报上来的一种）。
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
/// 长度上限 = `note_like.visitor_key` 的列宽（超了会被 MySQL 截断/报错，不如提前拒）。
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
    if !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    Some(k.to_string())
}

/// 这次请求**是谁**（20261001 起有两种身份）。
///
/// `pub(super)`：`comment_votes.rs`（评论点赞/踩，20261003）与这里共用同一套身份解析
/// ——**它必须是同一份**。登录态要顺带认下"同一台浏览器此前匿名投的那一行"，
/// 这条规则抄成第二份就迟早会分叉（两处对"我是谁"的回答不一样）。
pub(super) enum Who {
    /// 登录用户。`key` 是同一请求里带的访客标识——登录态下它**不参与"我是谁"**，
    /// 只用于把"这台浏览器此前匿名投的那一票"一并认下来（见 `like_note` 的说明）。
    User { uid: i32, key: Option<String> },
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

    /// 这个身份在**一张"两种身份并排"的表**上的过滤条件（读与删共用一份，
    /// 免得两处写歪）。
    ///
    /// 列由调用方传进来，因为每张表有自己的 `Column` 枚举（`note_like` 的与
    /// `note_comment_vote` 的不是同一个类型），但**语义只有这一份**：登录态要顺带
    /// 认下"同一台浏览器此前匿名投的那一行"——不认的话，先匿名投、再登录，
    /// 高亮会当场变空，而计数里明明有那一票。
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

/// 解析这次请求的身份。三种结果**必须分开**，别用 `.ok()` 一把梭：
///   · `Ok(Some(who))` —— 认出来了（登录优先，其次访客标识）；
///   · `Ok(None)`      —— 既没登录也没带访客标识（读接口照常返回、`liked` 恒 false）；
///   · `Err(e)`        —— **带着令牌来的，但令牌不能用**（过期/已收回/账号被冻结）。
///     这一支**绝不降级成匿名**：账号被冻结的人不该因为"换个身份"就照常点赞。
///     （他能清掉 localStorage 再来——那是匿名点赞固有的口子，见迁移头注语义 ①——
///      但我们不主动替他换。）读接口按模块头注第 1 条把它当"没认出来"处理。
pub(super) async fn identify(
    db: &DatabaseConnection,
    headers: &HeaderMap,
) -> Result<Option<Who>, crate::auth_jwt::AuthError> {
    match crate::auth_jwt::auth_uid(db, headers).await {
        Ok(uid) => Ok(Some(Who::User { uid, key: visitor_key(headers) })),
        Err(crate::auth_jwt::AuthError::Missing) => {
            Ok(visitor_key(headers).map(Who::Visitor))
        }
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
    if !visible_note_id(&state.db, id).await {
        return note_gone();
    }
    let who = optional_who(&state.db, &headers).await;
    match read_stats(&state.db, id, who.as_ref()).await {
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
    let who = optional_who(&state.db, &headers).await;
    match read_stats(&state.db, id, who.as_ref()).await {
        Ok(dto) => Json(ApiResponse::success(dto)).into_response(),
        Err(e) => {
            tracing::error!("[note_stats] 上报后回读失败 note={}: {}", id, e);
            Json(ApiResponse::<NoteStatsDto>::error("统计查询失败，请稍后再试")).into_response()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 点赞 / 取消点赞（20261001 起**匿名也可以**；失败走信封错误，**不是 401**）
//
// 身份按"登录优先、其次浏览器自报的访客标识"解析（`identify`）。两者都没有时
// 回「未登录」的信封错误——**这是唯一还需要拦的一档**，而不是从前那种"必须登录"。
// 匿名点赞为什么可以接受（以及它的代价），写在迁移文件头注的语义 ① 与
// `docs/security-boundary.md` 的"可被匿名刷"一节里，改这里之前先读那两处。
// ─────────────────────────────────────────────────────────────────────────────

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
        Ok(None) => {
            return Err(Json(ApiResponse::<LikeDto>::error("未登录")).into_response())
        }
    };
    if !visible_note_id(&state.db, id).await {
        return Err(Json(ApiResponse::<LikeDto>::error("这篇文章不存在")).into_response());
    }
    Ok(who)
}

/// 写入一行点赞。两种身份落到两种行（见 `entity/note_like.rs` 头注）。
///
/// **登录态会先清掉同一 `visitor_key` 的匿名行**：那行的主人就是这台浏览器，
/// 不清的话"先匿名点一下、再登录点一下"= 同一台机器投出两票，而报表上分不出来。
/// 这个动作对"从没匿名点过"的绝大多数请求就是一条零行的 DELETE（走
/// `uq_like_note_visitor` 的最左列，代价可忽略）。
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
    if let Err(e) = note_like::Entity::insert(am).exec_without_returning(db).await {
        // 并发下两个请求同时走到这里 → 对应的那条唯一键拦下第二个
        // （登录行撞 `uq_like_note_user`、匿名行撞 `uq_like_note_visitor`）。
        // **不能只看错误类型断言"是撞唯一键"**（同 `profile.rs::add_favorite` 的取舍）：
        // 回查一次，现在真有一行就算成功，否则才是真失败。
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
        tracing::error!("[note_stats] 取消点赞失败 note={} who={}: {}", id, who.tag(), e);
        return Json(ApiResponse::<LikeDto>::error("操作失败，请稍后再试")).into_response();
    }
    like_dto(&state.db, id, false).await.into_response()
}

// ─────────────────────────────────────────────────────────────────────────────
// 批量计数（文章卡片上的三个数：阅读 / 点赞 / 收藏）
// ─────────────────────────────────────────────────────────────────────────────

/// 一篇文章的公共计数。四个数**不同源**：阅读来自 `note_view`、点赞来自 `note_like`、
/// 收藏来自 `user_favorite`（20260922 收藏功能）、讨论来自 `note_comment`（20261003）
/// ——但对卡片来说它们是一排四个数，所以一次取齐、不拆成四个接口。
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
    // 讨论数（20261003）。两条 filter 与 `comments_of` 逐字相同——卡片的数必须等于
    // 点进去看到的条数，否则读者第一眼就发现对不上。
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

// ─────────────────────────────────────────────────────────────────────────────
// 后台报表（protected_routes ⇒ 只有 admin）
// ─────────────────────────────────────────────────────────────────────────────

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
    /// 讨论数（20261003 补）。**口径 = 公开讨论区看得见的那些**
    /// （`approved = 1 AND is_deleted = 0`，同 `comments_of`）——与文章卡片/详情页上
    /// 那个数逐字同源，后台看到的数一定等于点进去数出来的条数。
    pub comments: i64,
}

#[derive(Serialize, Default)]
pub struct DailyRow {
    /// `YYYY-MM-DD`（本地统计日）
    pub date: String,
    pub views: i64,
    pub likes: i64,
    /// 与 `likes` 同一条路（`user_favorite.created_at` 的日期分桶）。20261001 补：
    /// 汇总卡与排行榜都三个数了，趋势图只有两条线，读的人第一眼就会问"收藏呢"。
    pub favorites: i64,
    /// 讨论量的日趋势（20261003 补，`note_comment.created_at` 的日期分桶）。
    /// 同一条"补零"纪律：没有讨论的日子是 0，不是缺席。
    pub comments: i64,
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

/// 把一串"发生时刻"按**日期**累加进日趋势表。
///
/// 点赞与收藏走的是同一条路（都是 `created_at`），原本各写一份逐字相同的循环；
/// `favorites` 进来之后就该抽出来了——**两处的分桶口径必须一致**，
/// 不然趋势图里两条线会在不同的日界上切（一个按 UTC、一个按本地这种）。
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
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 周报 / 月报 / 年报（20261001）
// ─────────────────────────────────────────────────────────────────────────────

/// 期粒度。**白名单**：`kind` 是查询参数，认不出的一律报错，不做"猜一个最像的"。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Granularity {
    Week,
    Month,
    Year,
}

impl Granularity {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "week" => Some(Self::Week),
            "month" => Some(Self::Month),
            "year" => Some(Self::Year),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
        }
    }

    /// 默认期数。**一周一期看一年、一月一期看一年、一年一期看五年**——
    /// 都是"列表一屏能扫完"的量级。上限同理（`limit` 是外部入参，不设上限
    /// 等于让人一次拉十年）。
    fn default_limit(self) -> usize {
        match self {
            Self::Week => 12,
            Self::Month => 12,
            Self::Year => 5,
        }
    }

    fn max_limit(self) -> usize {
        match self {
            Self::Week => 26,
            Self::Month => 24,
            Self::Year => 10,
        }
    }
}

/// 一期的边界（闭区间，都是本地日期）。
struct Period {
    key: String,
    label: String,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
}

/// 往回数第 `back` 期的边界。
///
/// 期界一律在 Rust 里算（ISO 周、自然月、自然年），**不用 SQL 的日期函数**：
/// 那是方言相关的表达式（`YEARWEEK` / `DATE_FORMAT`），而本仓的 api_tests 走
/// MockDatabase——写错了本机全绿、一部署就现形（`SUM` 那个 DECIMAL 的坑同族）。
/// 取回原始日期列在本地分桶，与本模块其余部分保持同一种做法。
fn period_at(g: Granularity, today: chrono::NaiveDate, back: usize) -> Period {
    use chrono::Datelike;
    let back = back as i64;
    match g {
        Granularity::Week => {
            // ISO 周：周一是第一天（`num_days_from_monday`）。
            let start = today
                - chrono::Duration::days(today.weekday().num_days_from_monday() as i64)
                - chrono::Duration::days(7 * back);
            let end = start + chrono::Duration::days(6);
            let iso = start.iso_week();
            Period {
                key: format!("{}-W{:02}", iso.year(), iso.week()),
                label: format!("{} 年第 {} 周", iso.year(), iso.week()),
                start,
                end,
            }
        }
        Granularity::Month => {
            // 先把"今天"退到本月的 1 号，再往回退 back 个月（手动进退位，
            // 不引 chrono 的 Months——那要处理 NaiveDate 溢出的 Option）。
            let mut y = today.year();
            let mut m = today.month() as i64;
            m -= back;
            while m <= 0 {
                m += 12;
                y -= 1;
            }
            let start = chrono::NaiveDate::from_ymd_opt(y, m as u32, 1).unwrap_or(today);
            let end = last_day_of_month(y, m as u32);
            Period {
                key: format!("{y}-{m:02}"),
                label: format!("{y} 年 {m} 月"),
                start,
                end,
            }
        }
        Granularity::Year => {
            let y = today.year() - back as i32;
            Period {
                key: format!("{y}"),
                label: format!("{y} 年"),
                start: chrono::NaiveDate::from_ymd_opt(y, 1, 1).unwrap_or(today),
                end: chrono::NaiveDate::from_ymd_opt(y, 12, 31).unwrap_or(today),
            }
        }
    }
}

/// 某年某月的最后一天：下个月 1 号往前退一天。闰年由 chrono 自己算，
/// **不要写 `[31,28,31,…]` 那张表**（2 月会常年差一天）。
fn last_day_of_month(y: i32, m: u32) -> chrono::NaiveDate {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    chrono::NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .unwrap_or_else(|| chrono::NaiveDate::from_ymd_opt(y, 12, 31).unwrap_or_default())
}

#[derive(Serialize, Default)]
pub struct PeriodRow {
    /// `2026-W40` / `2026-10` / `2026`（前端做 React key 用，也是人眼可读的编号）
    pub key: String,
    pub label: String,
    /// 期界，`YYYY-MM-DD`（闭区间）
    pub start: String,
    pub end: String,
    /// **本期不是整期统计**：起始日早于 `since`（统计功能上线那天）。
    /// 前端据此把数字标成"部分"，否则"上线那一周只有两天数据"会被读成
    /// "那周流量掉了"——这正是本模块反复强调的"缺数 ≠ 零"。
    pub partial: bool,
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    /// 本期讨论量（20261003 补）。口径同全局：只算**公开可见**的评论
    /// （`approved = 1 AND is_deleted = 0`），且只算当前可见文章上的。
    pub comments: i64,
    /// 本期**阅读量**前 5（名次口径是本期内，与全局榜无关）。
    /// 每行四个数都带——看榜的人下一个问题必然是"那篇的赞/收藏/讨论呢"。
    #[serde(rename = "topNotes")]
    pub top_notes: Vec<NoteRankRow>,
}

#[derive(Serialize, Default)]
pub struct PeriodReportDto {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    /// 回显粒度（前端切了档之后要能对得上）
    pub kind: String,
    /// 最早有统计记录的一天；`None` = 一行记录都还没有
    pub since: Option<String>,
    /// 期列表，**倒序**（最新在前）；期界早于 `since` 的整期已被剔除
    pub periods: Vec<PeriodRow>,
}

/// GET /api/protected/stats/notes/periods?kind=week|month|year&limit=N
pub async fn note_period_report(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
) -> Json<ApiResponse<PeriodReportDto>> {
    let db = &state.db;

    let g = match Granularity::parse(q.get("kind").map(String::as_str).unwrap_or("week")) {
        Some(g) => g,
        None => return Json(ApiResponse::error("报表粒度只支持 week / month / year")),
    };
    // `limit` 认不出就当没给（默认值），**不是**报错：它是分页参数，
    // 拼错一个 `limit=` 不该让整个报表打不开。
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| g.default_limit())
        .min(g.max_limit());

    let notes = match visible_notes(db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[stats] note 可见性查询失败: {e}");
            return Json(ApiResponse::error("统计查询失败，请稍后再试"));
        }
    };
    let titles: HashMap<i32, String> = notes.iter().cloned().collect();
    let ids: Vec<i32> = notes.iter().map(|(id, _)| *id).collect();

    let today = chrono::Local::now().date_naive();
    let wanted: Vec<Period> = (0..limit).map(|i| period_at(g, today, i)).collect();
    let oldest_start = wanted.last().map(|p| p.start).unwrap_or(today);

    let dto = |periods: Vec<PeriodRow>, since: Option<String>| PeriodReportDto {
        generated_at: crate::routes::stats::format_ts(chrono::Local::now().naive_local()),
        kind: g.as_str().to_string(),
        since,
        periods,
    };

    // 统计的起点 = `note_view` 最早那一行。**这是"这几期到底统没统计过"的唯一判据**：
    // 期界落在它之前的那些期，数字恒为 0，但那个 0 的意思是"功能还没上线"，
    // 不是"那几天没人看"。所以整期剔除、跨界的标 partial。
    let since: Option<chrono::NaiveDate> = match note_view::Entity::find()
        .select_only()
        .column_as(Expr::col(note_view::Column::ViewDate).min(), "d")
        .into_tuple::<Option<chrono::NaiveDate>>()
        .one(db)
        .await
    {
        Ok(v) => v.flatten(),
        Err(e) => {
            tracing::error!("[stats] note_view 起点查询失败: {e}");
            return Json(ApiResponse::error("统计查询失败，请稍后再试"));
        }
    };
    let Some(since) = since else {
        // 一行记录都没有：如实回空列表，不回一堆 0 期
        return Json(ApiResponse::success(dto(Vec::new(), None)));
    };

    let kept: Vec<Period> = wanted.into_iter().filter(|p| p.end >= since).collect();
    if kept.is_empty() {
        return Json(ApiResponse::success(dto(
            Vec::new(),
            Some(since.format("%Y-%m-%d").to_string()),
        )));
    }

    // 一篇文章在某一期里的四个数：`(期 key, note_id) → [views, likes, favorites, comments]`
    // ⚠️ 下标是**位置**约定的（0 阅读 / 1 点赞 / 2 收藏 / 3 讨论），下面累加处的
    // `[0]` / `[1usize]` / `[2usize]` / `[3usize]` 与 `or_insert([0; 4])` 必须一起看。
    type Acc = HashMap<(String, i32), [i64; 4]>;
    let mut acc: Acc = HashMap::new();
    // 期 key 的归属：日期 → 期。kept 是倒序的，构建顺序无所谓（期界互不重叠）
    let period_of = |d: chrono::NaiveDate| -> Option<String> {
        kept.iter().find(|p| d >= p.start && d <= p.end).map(|p| p.key.clone())
    };

    if !ids.is_empty() {
        // 阅读量：一篇文章一天一行，直接把 cnt 累进所属期
        match note_view::Entity::find()
            .select_only()
            .column(note_view::Column::NoteId)
            .column(note_view::Column::ViewDate)
            .column(note_view::Column::Cnt)
            .filter(note_view::Column::NoteId.is_in(ids.clone()))
            .filter(note_view::Column::ViewDate.gte(oldest_start))
            .into_tuple::<(i32, chrono::NaiveDate, i32)>()
            .all(db)
            .await
        {
            Ok(rows) => {
                for (id, d, c) in rows {
                    if let Some(k) = period_of(d) {
                        acc.entry((k, id)).or_insert([0; 4])[0] += c as i64;
                    }
                }
            }
            Err(e) => {
                tracing::error!("[stats] note_view 分期失败: {e}");
                return Json(ApiResponse::error("统计查询失败，请稍后再试"));
            }
        }

        let from = oldest_start.and_hms_opt(0, 0, 0).unwrap_or_default();
        // 点赞与收藏：同一条路（`created_at` 取日期），逐行累加
        let likes: Result<Vec<(i32, chrono::NaiveDateTime)>, DbErr> = note_like::Entity::find()
            .select_only()
            .column(note_like::Column::NoteId)
            .column(note_like::Column::CreatedAt)
            .filter(note_like::Column::NoteId.is_in(ids.clone()))
            .filter(note_like::Column::CreatedAt.gte(from))
            .into_tuple::<(i32, chrono::NaiveDateTime)>()
            .all(db)
            .await;
        let favs: Result<Vec<(i32, chrono::NaiveDateTime)>, DbErr> = user_favorite::Entity::find()
            .select_only()
            .column(user_favorite::Column::NoteId)
            .column(user_favorite::Column::CreatedAt)
            .filter(user_favorite::Column::NoteId.is_in(ids.clone()))
            .filter(user_favorite::Column::CreatedAt.gte(from))
            .into_tuple::<(i32, chrono::NaiveDateTime)>()
            .all(db)
            .await;
        // 讨论：与点赞/收藏同一条路（`created_at` 取日期），但**多两条过滤**
        // （公开可见的那些才算——与全局报表的 totalComments 同一口径）。
        let cmts: Result<Vec<(i32, chrono::NaiveDateTime)>, DbErr> = note_comment::Entity::find()
            .select_only()
            .column(note_comment::Column::NoteId)
            .column(note_comment::Column::CreatedAt)
            .filter(note_comment::Column::NoteId.is_in(ids.clone()))
            .filter(note_comment::Column::CreatedAt.gte(from))
            .filter(note_comment::Column::Approved.eq(1))
            .filter(note_comment::Column::IsDeleted.eq(0))
            .into_tuple::<(i32, chrono::NaiveDateTime)>()
            .all(db)
            .await;
        for (rows, slot) in [(likes, 1usize), (favs, 2usize), (cmts, 3usize)] {
            match rows {
                Ok(rows) => {
                    for (id, t) in rows {
                        if let Some(k) = period_of(t.date()) {
                            acc.entry((k, id)).or_insert([0; 4])[slot] += 1;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("[stats] 分期点赞/收藏/讨论失败: {e}");
                    return Json(ApiResponse::error("统计查询失败，请稍后再试"));
                }
            }
        }
    }

    // 定稿：逐期算总量与榜。
    // ⚠️ 总量**不是** `top_notes` 的和——榜截断到 5 条，那一和只等于前 5 篇。
    // 总量从 `acc` 全量累加（口径与全局报表的 totalViews 一致：当前可见文章）。
    let mut periods: Vec<PeriodRow> = Vec::with_capacity(kept.len());
    for p in &kept {
        let mut rows: Vec<NoteRankRow> = Vec::new();
        let (mut tv, mut tl, mut tf, mut tc) = (0i64, 0i64, 0i64, 0i64);
        for (id, title) in titles.iter() {
            let Some(v) = acc.get(&(p.key.clone(), *id)) else { continue };
            // 「本期一行没有」= **四个数**全是 0。判据必须随下标表一起加长：
            // 只判前三个的话，"这期只被讨论、没被阅读"的文章会进榜、且在榜上显示一串 0。
            if v == &[0, 0, 0, 0] {
                continue;
            }
            tv += v[0];
            tl += v[1];
            tf += v[2];
            tc += v[3];
            rows.push(NoteRankRow {
                note_id: *id,
                title: title.clone(),
                views: v[0],
                likes: v[1],
                favorites: v[2],
                comments: v[3],
            });
        }
        // 名次口径 = **本期阅读量**（与全局榜同一把尺子，只是范围收到这一期）；
        // 截断 5 条——展开一块能一屏看完，再多就该去全局榜看
        rows.sort_by(|a, b| b.views.cmp(&a.views).then(a.note_id.cmp(&b.note_id)));
        rows.truncate(PERIOD_TOP_N);
        periods.push(PeriodRow {
            key: p.key.clone(),
            label: p.label.clone(),
            start: p.start.format("%Y-%m-%d").to_string(),
            end: p.end.format("%Y-%m-%d").to_string(),
            partial: p.start < since,
            views: tv,
            likes: tl,
            favorites: tf,
            comments: tc,
            top_notes: rows,
        });
    }

    Json(ApiResponse::success(dto(
        periods,
        Some(since.format("%Y-%m-%d").to_string()),
    )))
}
