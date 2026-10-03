//! 评论点赞 / 踩（20261003，用户第 4 条：「讨论区评论增加点赞和踩。」）。
//!
//! ── 形态是**拍板过的**，不是待办 ──────────────────────────────────────────
//! 「访客也能点，不改排序」：投票**不影响列表顺序**（讨论区仍是时间序，见
//! `comments.rs::list_comments`）。按票数排会让一条新评论永远沉底，而这是讨论区
//! 不是内容站的热榜——**别把"排序还没做"当成本次的遗留项**。
//!
//! ── 为什么单独一个模块（而不是并进 `comments.rs`）────────────────────────
//! `comments.rs` 已经 700 余行，而这一族与"评论本身"是两件事：它有自己的表
//! （`note_comment_vote`）、自己的身份口径（**访客可投**，评论是强制登录）、
//! 自己的读写形状（一票一行、读时聚合）。并进去只会让那份文件里"评论"与"票"
//! 两套纪律互相打断。
//!
//! ── 身份：**复用 `note_stats.rs` 那一套，一份实现** ───────────────────────
//! `identify` / `Who` / `Who::cond_on` 与文章点赞（`note_like`）共用同一份解析
//! ——「登录态要顺带认下同一台浏览器此前匿名投的那一行」这条规则写在两处就迟早分叉。
//! 代价（`visitor_key` 是客户端自报、能清能换）见
//! `scripts/migration/note_like_anon_20261001.sql` 头注语义 ①，**这里不重抄**。
//!
//! ── 域与错误形状：与评论那三条**逐字相同** ───────────────────────────────
//! 挂 `public_routes`（挂进 `protected_routes` 会被 `auth_guard` 按管理员判据把
//! 普通用户全部 403——那是后台守卫，不是"登录守卫"），且**绝不返回 HTTP 401**
//! （`frontend/src/apis/axios.tsx` 的拦截器见 401 就清 token 跳登录页）。失败一律
//! 走信封错误：HTTP 200 + `code=500` + 中文原因。
//!
//! ── 计数不落库 ───────────────────────────────────────────────────────────
//! 赞/踩都是从明细**现算**（`vote_counts_for` 一条 GROUP BY）。往 `note_comment`
//! 上加 `up`/`down` 两列看着更省事，但那会让"投一票"变成对同一行的并发写，而
//! 读者每拉一次讨论区都要读它们。取舍写在迁移文件头注里。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use sea_orm::{
    sea_query::{Expr, OnConflict},
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde::{Deserialize, Serialize};

use crate::entity::{note_comment, note_comment_vote};
use crate::utils::ApiResponse;

use super::note_stats::{identify, Who};
use super::AppState;

/// 请求体：`+1` 赞 / `-1` 踩 / `0` 撤回。
///
/// **连线协议有三个值、库里只有两个**：`0` 的含义是"把我那一行删掉"，不是"写一个 0"
/// （`note_comment_vote.value` 是 NOT NULL 且只允许 ±1，见迁移文件头注）。
/// 分层不同不矛盾——线协议要让前端一个函数表达三种动作，存储要让唯一键管住"投过没有"。
#[derive(Deserialize)]
pub struct VoteBody {
    pub value: i8,
}

/// 一条评论的票数 + **我**投的那一票。列表里的每一行与投票回执**共用这一个形状**
/// （前端也共用同一个类型），同一次动作的回执与刷新后看到的那一行必须是同一种东西。
///
/// `my_vote` 恒为 `-1` / `0` / `1`（`0` = 我没投）——**它与 up/down 是两件事**：
/// 前者是"我"，后者是"所有人"。前端按前者点亮按钮，按后者显示数字。
#[derive(Serialize, Default, Clone, Copy)]
pub struct CommentVoteDto {
    pub up: i64,
    pub down: i64,
    #[serde(rename = "myVote")]
    pub my_vote: i8,
}

/// 一批评论的赞/踩计数。**一条 `GROUP BY` 查询**，不是"每条评论两条"——
/// 讨论区一页几十条，逐条查会把 2 次往返放大成上百次（同
/// `note_stats.rs::counts_for` 的取舍）。
///
/// `GROUP BY comment_id, value`（而不是 `SUM(value = 1)`）：MySQL 的 `SUM()` 返回
/// **DECIMAL**，解码成整数要先 `CAST(... AS SIGNED)`（`note_like` 的报表踩过这个坑）；
/// 而 `COUNT()` 本来就是 BIGINT，分两行读回来在 Rust 侧折一下即可，少一层类型换算。
/// 每条评论最多两行（赞一行、踩一行）、没有票的评论没有行 —— 缺行即 0。
///
/// 空列表必须短路：`IN ()` 是 SQL 语法错误。
pub(super) async fn vote_counts_for(
    db: &DatabaseConnection,
    ids: &[i32],
) -> Result<HashMap<i32, (i64, i64)>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = note_comment_vote::Entity::find()
        .select_only()
        .column(note_comment_vote::Column::CommentId)
        .column(note_comment_vote::Column::Value)
        .column_as(Expr::col(note_comment_vote::Column::Id).count(), "total")
        .filter(note_comment_vote::Column::CommentId.is_in(ids.to_vec()))
        .group_by(note_comment_vote::Column::CommentId)
        .group_by(note_comment_vote::Column::Value)
        .into_tuple::<(i32, i8, i64)>()
        .all(db)
        .await?;

    let mut out: HashMap<i32, (i64, i64)> = HashMap::new();
    for (cid, value, n) in rows {
        let slot = out.entry(cid).or_insert((0, 0));
        // `value` 只有 ±1（库里没有别的取值，见迁移头注）；真出现别的值就当它不是票，
        // **不折进任何一边**——计数宁可少一个，不要凭空把这个数算进赞或踩。
        if value > 0 {
            slot.0 += n;
        } else if value < 0 {
            slot.1 += n;
        }
    }
    Ok(out)
}

/// 一批评论里**我**投过的那几票（`comment_id → ±1`）。没投过的评论不在表里。
///
/// 身份为 `None`（既没登录也没带访客标识，只有直接 curl 的用户见得到）⇒ 空表短路，
/// 一条查询都不发。
pub(super) async fn my_votes(
    db: &DatabaseConnection,
    ids: &[i32],
    who: Option<&Who>,
) -> HashMap<i32, i8> {
    let Some(who) = who else { return HashMap::new() };
    if ids.is_empty() {
        return HashMap::new();
    }
    note_comment_vote::Entity::find()
        .select_only()
        .column(note_comment_vote::Column::CommentId)
        .column(note_comment_vote::Column::Value)
        .filter(note_comment_vote::Column::CommentId.is_in(ids.to_vec()))
        .filter(who.cond_on(
            note_comment_vote::Column::UserId,
            note_comment_vote::Column::VisitorKey,
        ))
        // 同一个身份在一条评论上最多一行（唯一键保证），但登录态下
        // `cond_on` 会同时匹配"我的行"与"这台浏览器匿名投的行"——理论上两行都在时
        // 取哪一行都行（清匿名行是写入侧的义务），这里定死按 id 倒序取最新的一行，
        // 免得同一份数据两次请求返回不同的高亮。
        .order_by_desc(note_comment_vote::Column::Id)
        .into_tuple::<(i32, i8)>()
        .all(db)
        .await
        .map(|rows| {
            let mut m: HashMap<i32, i8> = HashMap::new();
            for (cid, v) in rows {
                m.entry(cid).or_insert(v);
            }
            m
        })
        .unwrap_or_default()
}

/// 这个身份在**这一条**评论上投的那一票（`0` = 没投）。
async fn my_vote_of(db: &DatabaseConnection, comment_id: i32, who: &Who) -> Result<i8, DbErr> {
    Ok(note_comment_vote::Entity::find()
        .select_only()
        .column(note_comment_vote::Column::Value)
        .filter(note_comment_vote::Column::CommentId.eq(comment_id))
        .filter(who.cond_on(
            note_comment_vote::Column::UserId,
            note_comment_vote::Column::VisitorKey,
        ))
        .order_by_desc(note_comment_vote::Column::Id)
        .into_tuple::<i8>()
        .one(db)
        .await?
        .unwrap_or(0))
}

/// 评论是否存在且**公开可见**（`approved = 1 AND is_deleted = 0`）。
///
/// 三条否定理由（不存在 / 待审 / 已驳回 / 已删）**合成同一句「评论不存在」**：
/// 投票方按定义看得到这条评论（他刚刚才点了它），所以这句话不会误导正常人，而
/// "这条评论正在等人复核"是不能从公开端口透露出去的（同 `list_comments` 的口径）。
async fn visible_comment(db: &DatabaseConnection, id: i32) -> Option<note_comment::Model> {
    note_comment::Entity::find()
        .filter(note_comment::Column::Id.eq(id))
        .filter(note_comment::Column::Approved.eq(1))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .one(db)
        .await
        .ok()
        .flatten()
}

/// 回读这次投票之后的状态（**不在 Rust 侧自增**——并发下自增必然对不上，
/// 同 `like_dto` 的取舍）。
async fn vote_state(
    db: &DatabaseConnection,
    comment_id: i32,
    who: &Who,
) -> Result<CommentVoteDto, DbErr> {
    let (up, down) = vote_counts_for(db, &[comment_id])
        .await?
        .remove(&comment_id)
        .unwrap_or((0, 0));
    Ok(CommentVoteDto {
        up,
        down,
        my_vote: my_vote_of(db, comment_id, who).await?,
    })
}

/// POST /api/public/comments/:id/vote —— 给一条评论投赞/踩，或撤回。
///
/// 幂等：连着投两次同一个方向，结果与投一次相同（唯一键 + `ON DUPLICATE KEY UPDATE`
/// 保证，不是靠"先查再插"）。
pub async fn vote_comment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
    Json(payload): Json<VoteBody>,
) -> Json<ApiResponse<CommentVoteDto>> {
    // 身份：登录优先，其次浏览器自报的访客标识；两者都没有才回「未登录」
    // （正常前端永远带标识，这一支只有直接 curl 的用户见得到）。
    let who = match identify(&state.db, &headers).await {
        Ok(Some(who)) => who,
        // 令牌在、但已经不能用（过期/收回/冻结）：如实回原因，**不降级成匿名**
        Err(e) => return Json(ApiResponse::error(e.message())),
        Ok(None) => return Json(ApiResponse::error("未登录")),
    };
    // 值域先判：`0` 是合法的"撤回"，别把它当成缺省或错误。
    if !matches!(payload.value, -1 | 0 | 1) {
        return Json(ApiResponse::error("参数不合法"));
    }
    let Some(comment) = visible_comment(&state.db, id).await else {
        return Json(ApiResponse::error("评论不存在"));
    };
    // 所属文章仍要可见：文章转成草稿/私有之后，它的评论在公开侧本就不可达，
    // 不该还能被投上一票（口径与 `create_comment` 的 `note_visible` 一致）。
    if !super::comments::note_visible(&state.db, comment.note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }

    let applied = match payload.value {
        0 => withdraw_vote(&state.db, id, &who).await,
        v => set_vote(&state.db, id, &who, v).await,
    };
    if let Err(e) = applied {
        tracing::error!(
            "[comment_vote] 投票失败 comment={} who={} value={}: {}",
            id,
            who.tag(),
            payload.value,
            e
        );
        return Json(ApiResponse::error("操作失败，请稍后再试"));
    }

    match vote_state(&state.db, id, &who).await {
        Ok(dto) => Json(ApiResponse::success(dto)),
        Err(e) => {
            // 票已经写进去了，只是回读失败——**别说"操作失败"**（那是撒谎，
            // 用户再点一次就会把刚投的票撤掉）。如实说读数没取到。
            tracing::error!("[comment_vote] 投票后回读失败 comment={id}: {e}");
            Json(ApiResponse::error("操作已提交，但结果读取失败，请刷新后确认"))
        }
    }
}

/// 撤回：删掉这个身份在这一条评论上的全部票。
///
/// 登录态下 `who.cond_on(…)` 会连"这台浏览器此前匿名投的那一票"一起匹配上
/// （见 `Who::cond_on`）——与"登录会把匿名票认成自己的"对称：登录后按同一个按钮取消，
/// 两行一起走。
async fn withdraw_vote(db: &DatabaseConnection, comment_id: i32, who: &Who) -> Result<(), DbErr> {
    note_comment_vote::Entity::delete_many()
        .filter(note_comment_vote::Column::CommentId.eq(comment_id))
        .filter(who.cond_on(
            note_comment_vote::Column::UserId,
            note_comment_vote::Column::VisitorKey,
        ))
        .exec(db)
        .await?;
    Ok(())
}

/// 投一票（`v` 只可能是 ±1）。
///
/// 一次 `INSERT … ON DUPLICATE KEY UPDATE value = …` 同时覆盖"第一次投"与"改主意"，
/// 不先查一次再决定插入还是更新——那中间有一个并发窗口，而幂等性本来就该由唯一键
/// （这里是它上面那条 upsert）而不是由代码的顺序保证（同 `insert_like` 的取舍）。
///
/// **匿名行与登录行撞的是两条不同的唯一键**，所以冲突目标要按身份选：匿名行的
/// `user_id` 是 NULL，而 MySQL 的 `ON DUPLICATE KEY` 对 NULL 键**不生效**——
/// 拿 `(comment_id, user_id)` 当冲突目标，匿名票会重复插入然后被唯一键报错。
async fn set_vote(
    db: &DatabaseConnection,
    comment_id: i32,
    who: &Who,
    v: i8,
) -> Result<(), DbErr> {
    // 登录态先清掉同一 `visitor_key` 的匿名行：那行的主人就是这台浏览器，
    // 不清的话"先匿名投一票、再登录投一票"= 同一台机器投出两票（同 `insert_like`）。
    // 对"从没匿名投过"的绝大多数请求，这就是一条零行的 DELETE。
    if let Who::User { key: Some(k), .. } = who {
        note_comment_vote::Entity::delete_many()
            .filter(note_comment_vote::Column::CommentId.eq(comment_id))
            .filter(note_comment_vote::Column::UserId.is_null())
            .filter(note_comment_vote::Column::VisitorKey.eq(k.clone()))
            .exec(db)
            .await?;
    }
    let conflict = match who {
        Who::User { .. } => vec![
            note_comment_vote::Column::CommentId,
            note_comment_vote::Column::UserId,
        ],
        Who::Visitor(_) => vec![
            note_comment_vote::Column::CommentId,
            note_comment_vote::Column::VisitorKey,
        ],
    };
    let (user_id, visitor_key) = match who {
        Who::User { uid, .. } => (Some(*uid), None),
        Who::Visitor(k) => (None, Some(k.clone())),
    };
    let am = note_comment_vote::ActiveModel {
        comment_id: Set(comment_id),
        user_id: Set(user_id),
        visitor_key: Set(visitor_key),
        value: Set(v),
        // created_at / updated_at 交给库的默认值：**不在这里用 `Local::now()` 填一遍**
        // （全库时间列都是 DEFAULT CURRENT_TIMESTAMP，两处各写一遍迟早差出时区）。
        ..Default::default()
    };
    note_comment_vote::Entity::insert(am)
        .on_conflict(
            OnConflict::columns(conflict)
                // 只改 value。`updated_at` 列带 `ON UPDATE CURRENT_TIMESTAMP`，
                // 行真的变了由 MySQL 自己刷新（同迁移文件里那条列注释）。
                .update_columns([note_comment_vote::Column::Value])
                .to_owned(),
        )
        // **不能用 `exec`**：走到冲突分支时 MySQL 并不会为这类 upsert 回一个
        // `LAST_INSERT_ID` 对应的模型，收返回值这条路不通；要 ReadBack 就再查一次
        // （`vote_state` 本来就要回读，那里才是唯一的事实源）。
        .exec_without_returning(db)
        .await
        .map(|_| ())
}
