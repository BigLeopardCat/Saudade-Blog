//! 文章评论（20261002）：文章详情页底部的讨论区。
//!
//! 用户原话：「文章详情页底部增加讨论区，用户可以发布评论或者讨论，提供站内的表情包
//! 使用，注意防止 XSS 攻击，用户之间也可以在评论下面评论，相互回复。」
//!
//! ── 与河灯留言板的**关系**：审核链共用，存储各一张表 ──────────────────────
//! 审核走 `talks::decide_review`——留言板那条闸的**同一份实现**（不是照抄一份）；
//! 开关是**另一对键**（`web_info::COMMENT_REVIEW_KEYS`），两类内容可以分别开关。
//! 存储是 `note_comment` 表：评论挂文章、留言挂留言板，要展示的列完全不同
//! （理由见迁移文件头注）。
//!
//! ── 两层结构：回复的回复不另起一层 ────────────────────────────────────────
//! 请求体**只收 `parentId`**；`root_id` / `reply_to_uid` 全部由服务端从父行派生
//! （见 [`create_comment`]）。这既是"不信任客户端"的一般纪律，也是"回复的回复仍挂在
//! 同一个顶层评论下"的机械保证——客户端想造第三层都没有字段可填。
//!
//! ── 排序：默认**热度**（20261020 改口径）────────────────────────────────────
//! `?sort=hot`（缺省）/ `?sort=new`，只作用在**顶层**；回复恒按时间正序。热度 =
//! Wilson 下界（先验一赞一踩）+ `0.1·log2(1+回复数)`，见 [`hot_score`] 的读数对照表。
//! **这条推翻了 20261003 拍过的"投票不影响排序"**：当时的理由（按票排会让新评论永远
//! 沉底）由先验回答，"讨论区不是热榜"则由「最新」页签回答。代价——匿名票可刷的后果从
//! "数字虚高"升级为"排名可操纵"——写在 `comment_votes.rs` 头注里，本次不做缓解。
//!
//! ── XSS：防线在**渲染侧**，不在这一侧 ─────────────────────────────────────
//! 服务端只校验形状（trim、剥控制字符、限 300 字），**不做 HTML 转义**：转义会把
//! "用户打的字"和"库里存的字"变成两份真相，还会与渲染端的 markdown 管线二次处理。
//! 真正的防线是前端那条完整管线
//! （`frontend/src/utils/chatMarkdown.ts::renderBlogMarkdown` ——
//! remark-parse → gfm/breaks/gemoji/math → remarkStickers → rehype-raw → rehype-sanitize），
//! 评论、文章、看板娘对话框共用它。**任何地方都不许对评论原文直接 innerHTML。**
//!
//! ── 域：公开三条挂 `public_routes` ─────────────────────────────────────────
//! 评论要对全体登录用户（乃至未登录访客）开放，而 `protected_routes` 域内由
//! `auth_guard` 全量要求管理员——挂错了就是普通用户 403。所以公开读写挂
//! `public_routes`、后台管理挂 `protected_routes`，路由见 `routes/mod.rs`。

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set, PaginatorTrait, Select, Condition, QueryTrait};
use serde::{Deserialize, Serialize};

use crate::entity::{user, note, note_comment};
use crate::utils::{ApiResponse, ApiResponsePage};
use super::moderation::{ReviewStatus, page_window};

use super::AppState;

/// 评论正文上限（**字符数**不是字节数）。与留言板的 500 分开定：讨论区是短回复，
/// 300 字足够表达一个观点，也让两层的排版不会一条占满整屏。
const MAX_COMMENT_CHARS: usize = 300;

/// 后台列表一次最多回多少条（与其它后台列表同量级；讨论区量与留言板同级，不分页）。
const ADMIN_PAGE_LIMIT: u64 = 500;

/// 文章是否**公开可见**——与 `notes::list_public_notes` 的 STRICT FILTER 同一口径
/// （`is_public = 1` 且 `status <> 'draft'`）。两条读取路径**必须**同口径：否则会出现
/// "评论读得到、文章打不开"（或反过来）这种自相矛盾的组合。
pub(super) async fn note_visible(db: &sea_orm::DatabaseConnection, note_id: i32) -> bool {
    // 只问"在不在"，那就只 select 主键（20261018）。这个函数在**每一次留言读写**上都会跑，
    // 从前 `SELECT *` 每次都把整篇正文读回来。
    note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .filter(note::Column::Id.eq(note_id))
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.is_in(super::notes::public_status_words()))
        .into_tuple::<i32>()
        .one(db)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// 正文的**形状**归一：剥掉除 `\n` 以外的全部 C0 控制字符，再去掉首尾空白。
///
/// 为什么留 `\n`：渲染管线的 breaks 插件拿它换行，评论里的分段是真实表达。
/// 为什么剥其余控制字符（`\r`、`\t`、退格、NUL…）：它们对读者没有意义，却能把一行
/// 撑得很长、或让后台列表的截断看起来莫名其妙；`\r` 尤其会在"存进去是 `\n`、
/// 显示出来多一个空格"这类问题上骗人（留言板那条 `talk_brief` 就为它专门拍过平）。
///
/// **不转义**：见文件头注「XSS 防线在渲染侧」。
fn clean_content(raw: &str) -> String {
    raw.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

// ── DTO ────────────────────────────────────────────────────────────────────

/// 公开读的一行（**扁平**：顶层与回复同形，由 `rootId` 区分，前端组树）。
///
/// 为什么回扁平数组而不是嵌套结构：讨论区只有一层嵌套，服务端组树的唯一好处是省掉
/// 前端几行 reduce，代价是每加一个字段都要改两处（顶层/回复）。扁平之后整个讨论区
/// 只要 **2 条查询**（顶层一次 + `root_id IN (…)` 一次），前端一次 `groupBy` 收尾。
#[derive(Serialize)]
pub struct CommentDto {
    pub id: i32,
    #[serde(rename = "noteId")]
    pub note_id: i32,
    pub content: String,
    /// 直接父评论 id；null = 顶层
    #[serde(rename = "parentId")]
    pub parent_id: Option<i32>,
    /// 顶层评论 id；**null = 本行就是顶层**（前端据此分组）
    #[serde(rename = "rootId")]
    pub root_id: Option<i32>,
    #[serde(rename = "replyToUid")]
    pub reply_to_uid: Option<i32>,
    /// 被回复者的**展示名**；null = 顶层，或对方账号已销（此时前端显示「已注销用户」）
    #[serde(rename = "replyToNickname")]
    pub reply_to_nickname: Option<String>,
    #[serde(rename = "userId")]
    pub user_id: i32,
    /// 作者的展示名（昵称优先、没设昵称退回账号，见 `profile::peer_map`）
    pub nickname: String,
    pub avatar: Option<String>,
    /// 角色（权限身份徽章用）。**从库里现读**，不是令牌快照
    pub role: String,
    /// 是否当前登录用户所发（删按钮的门控）。未登录恒 false
    pub mine: bool,
    /// 赞 / 踩 / **我投的那一票**（20261003 用户第 4 条）。三个数与投票接口的回执
    /// （`comment_votes::CommentVoteDto`）**同名同义**，前端也共用同一个类型。
    /// `myVote` 恒 -1/0/1（0 = 我没投），它决定按钮点亮，`up`/`down` 决定数字。
    pub up: i64,
    pub down: i64,
    #[serde(rename = "myVote")]
    pub my_vote: i16,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// ── 热度排序（20261020）──────────────────────────────────────────────────────

/// 公开列表的查询参数。
///
/// ⚠️ `sort` **故意是 `Option<String>` 而不是枚举**：`Query` 抽取器遇到反序列化失败会
/// **直接回 HTTP 400 + 纯文本**、**不走 `ApiResponse` 信封**，而前端判的是 `code === 200`
/// ⇒ 一个过期的分享链接（`?sort=xxx`）就能把整段讨论区变成"读取失败，请稍后再试"。
/// 未知值一律回落默认。
#[derive(Deserialize)]
pub struct CommentListQuery {
    /// `hot`（缺省）/ `new`。**只有 `new` 会改变行为**，其余一律当 `hot`。
    pub sort: Option<String>,
}

/// 先验票：每条评论**开局自带一赞一踩**。
///
/// 它不是装饰——没有它，0 票的新评论算出来恒为 0，永远沉在坟底；而"按票排会让新评论
/// 永远沉底"正是 `comment_votes.rs` 头注当初反对按票排序的那条理由。加上之后
/// 0 票 0 回复 ≈ 0.095，**高于**净负票（0 赞 1 踩 ≈ 0.061），新评论落在中下游而不是最底。
///
/// ⚠️ 它**不**保证新评论排得过有点赞的评论——那正是"最热"的定义，「最新」页签才是逃生口。
const HOT_PRIOR_VOTES: f64 = 1.0;

/// Wilson 区间的置信水平（1.96 = 95%）。**取的是下界**：样本少就往低了估，于是
/// "1 赞 0 踩"压不过"20 赞 1 踩"——整套公式存在的理由就是这一条（Reddit 的 best 排序
/// 用的就是它，出处 Evan Miller 2009《How Not To Sort By Average Rating》）。
const HOT_Z: f64 = 1.96;

/// 回复项的权重：`α · log2(1 + 回复数)`。log2 压缩之后**每翻一倍才加一个 α**
/// （1→+0.10 / 3→+0.20 / 7→+0.30 / 15→+0.40 / 31→+0.50）。
/// Wilson 下界的实际取值域约 [0.03, 1.0]，所以 31 条回复 ≈ 8 个赞。**这个量纲是拍的**。
///
/// ⚠️ **它没有上界**：`log2` 只是把增长压得很慢，不是封顶。实测兑换率约
/// **178 条回复 ≈ 30 个赞**（内联单测钉了 100 / 300 两侧），也就是说一个吵到三百楼的帖子
/// 能把 30 赞的评论顶下去。这是"讨论量也算热度"必然的代价，**已知且接受**（同族的取舍
/// 写在 `comment_votes.rs` 头注的"不做的事"里）。
///
/// 真要封顶，正解是换成"回复折进 Wilson 样本"那一版（见 `hot_score` 的备选形态），
/// **不是**在这里给回复项加个 `min()`：加了 min 就等于给吵架帖一个固定天花板，而那个
/// 天花板同样是拍出来的数，只是更难解释——"为什么第 100 条回复还算数、第 101 条不算"。
const HOT_REPLY_WEIGHT: f64 = 0.1;

/// 热度分 = **讨论量 + 赞踩加权**。入参都是计数，恒 ≥ 0。
///
/// ```text
/// up' = up + 1, down' = down + 1          ← 先验（见 HOT_PRIOR_VOTES）
/// p̂   = up' / (up' + down')
/// hot = Wilson下界(p̂, n = up'+down', z = 1.96) + 0.1 · log2(1 + replies)
/// ```
///
/// 读数对照（改常量时按这张表对账，内联单测钉着其中几个点）：
/// `0票0回复 0.095 ｜ 1赞0踩 0.208 ｜ 5赞1踩 0.409 ｜ 0票15回复 0.495 ｜ 20赞1踩 0.732
///  ｜ 0赞5踩 0.026 ｜ 30赞0踩 0.843`
///
/// 备选形态（**本次不做**，写在这里免得下一个人重新发明）：把回复折成伪赞成票塞进
/// Wilson 样本（`up' = up + 1 + replies`）——单一量纲、踩能自动抵消"吵出来的热度"，
/// 代价是断言"一条回复 ≈ 一票赞"，而这对争论帖不成立。
fn hot_score(up: i64, down: i64, replies: i64) -> f64 {
    let (up_f, down_f) = (up as f64 + HOT_PRIOR_VOTES, down as f64 + HOT_PRIOR_VOTES);
    let n = up_f + down_f;
    let p = up_f / n;
    let z2 = HOT_Z * HOT_Z;
    let lower =
        (p + z2 / (2.0 * n) - HOT_Z * (p * (1.0 - p) / n + z2 / (4.0 * n * n)).sqrt()) / (1.0 + z2 / n);
    lower + HOT_REPLY_WEIGHT * (replies as f64 + 1.0).log2()
}

/// 排序键：热度**定点化成微单位整数**，再与 id 组成 `(i64, i32)`。
///
/// **为什么不直接比 `f64`**：`f64` 的比较器在 NaN 上不构成全序（`partial_cmp` 返回 None，
/// 而 `sort_by` 对非全序**不 panic、顺序未定义**）；`i64` 天生 `Ord` ⇒ "排序稳定"由类型
/// 保证，不靠纪律。id 进键 = 同分时按 id 降序，**排序是全序**（同一份数据每次排出同一个
/// 顺序，无头断言与人工排查都能按"第 N 行"对账）。
fn hot_key(score: f64, id: i32) -> (i64, i32) {
    ((score * 1_000_000.0).round() as i64, id)
}

// ── 公开读 ─────────────────────────────────────────────────────────────────

/// GET /api/public/notes/:id/comments —— 某篇文章的公开评论（顶层 + 全部回复）。
///
/// **未登录也能读**（文章详情页本身是公开的，讨论区跟着它）：此时 `mine` 恒 false。
/// 只回 `approved = 1` 且未软删的行——待审/未通过/已删除的评论在公开侧**不存在**，
/// 连"有一条被删了"都不透露。
///
/// **排序（20261020）**：`?sort=hot`（缺省）/ `?sort=new`。热度**只作用在顶层**，回复恒按
/// 时间正序（对话要读得下去）。这一条改掉了 20261003 拍过的口径（"投票不影响排序"），
/// 新口径与代价见 `comment_votes.rs` 头注。
pub async fn list_comments(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
    Query(q): Query<CommentListQuery>,
) -> Json<ApiResponse<Vec<CommentDto>>> {
    // 读路径的身份：令牌过期/收回/冻结一律当**没登录**（模块头注第 1 条），不整条请求失败。
    // 一次解析两个用途——`mine`（这条是不是我发的，只登录用户有）与 `myVote`
    // （我投过没投过，**匿名访客也要有**：他刚点过的那一票必须还亮着）。
    let who = super::note_stats::optional_who(&state.db, &headers).await;
    let uid = who.as_ref().and_then(|w| w.uid());
    if !note_visible(&state.db, note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }
    // 排序口径：缺省与**未知值**都当 `hot`（未知值绝不能 reject，见 `CommentListQuery`）。
    let sort_hot = !matches!(q.sort.as_deref(), Some("new"));
    // 先取顶层，再一次性取它们名下**全部**回复。
    // ⚠️ 这两条 `ORDER BY` 从 20261020 起**不再是列表顺序的契约**，只是"内存排序的确定性
    // 前置"：默认档会在内存里按热度重排顶层（见下方 `hot_key`）。真正要保的顺序只有两条
    // ——顶层热度/时间降序、回复时间升序。
    let tops = note_comment::Entity::find()
        .filter(note_comment::Column::NoteId.eq(note_id))
        .filter(note_comment::Column::RootId.is_null())
        .filter(note_comment::Column::Approved.eq(1))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .order_by_desc(note_comment::Column::CreatedAt)
        .order_by_desc(note_comment::Column::Id) // 同秒多行排序确定
        .all(&state.db)
        .await;
    let tops = match tops {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] list_comments 顶层查询失败 note={note_id}: {e}");
            return Json(ApiResponse::error("读取失败，请稍后再试"));
        }
    };
    let top_ids: Vec<i32> = tops.iter().map(|c| c.id).collect();
    let replies = if top_ids.is_empty() {
        // 空表不发 `IN (NULL)` 白查询（同 list_board_admin）
        vec![]
    } else {
        note_comment::Entity::find()
            .filter(note_comment::Column::RootId.is_in(top_ids))
            .filter(note_comment::Column::Approved.eq(1))
            .filter(note_comment::Column::IsDeleted.eq(0))
            .order_by_asc(note_comment::Column::CreatedAt) // 回复按时间正序读下来才像对话
            .order_by_asc(note_comment::Column::Id)
            .all(&state.db)
            .await
            .unwrap_or_default()
    };
    // 讨论量：按 `root_id` 分组数**整棵子树**（"回复的回复"也挂在同一个顶层下，见文件头注）
    // ——不是直接回复数。**零新查询**：回复已经在内存里；而且它们本来就过滤了
    // `approved = 1 AND is_deleted = 0`，所以数出来的天然只有公开可见的回复，
    // 与列表口径一致（待审/已删的回复不算进热度）。
    let mut reply_counts: std::collections::HashMap<i32, i64> = std::collections::HashMap::new();
    for r in &replies {
        if let Some(root) = r.root_id {
            *reply_counts.entry(root).or_insert(0) += 1;
        }
    }
    // 展示名一次取全：作者与"被回复者"共用同一份 map（回复者可能不是本页任何一条的作者）
    let mut uids: Vec<i32> = tops.iter().map(|c| c.user_id).collect();
    uids.extend(tops.iter().filter_map(|c| c.reply_to_uid));
    uids.extend(replies.iter().map(|c| c.user_id));
    uids.extend(replies.iter().filter_map(|c| c.reply_to_uid));
    uids.sort_unstable();
    uids.dedup();
    let peers = super::profile::peer_map(&state.db, &uids).await;
    // 票数一次取全（**两条查询**，不是每条评论两条，见 `comment_votes` 的取舍）。
    // 取不到就当没有票：讨论区的正文必须照常显示——投票是附属信息，
    // 不该因为它读失败就让整页评论消失（同上面 `replies` 的 `unwrap_or_default`）。
    let ids: Vec<i32> = tops.iter().chain(replies.iter()).map(|c| c.id).collect();
    let counts = super::comment_votes::vote_counts_for(&state.db, &ids)
        .await
        .unwrap_or_default();
    let mine = super::comment_votes::my_votes(&state.db, &ids, who.as_ref()).await;
    // 热度排序：**只排顶层**，回复保持上面那条 `ORDER BY created_at ASC`（对话要读得下去）。
    // 键是 `(定点化热度, id)` 的全序 ⇒ 同一份数据每次排出同一个顺序。
    let mut tops = tops;
    if sort_hot {
        let mut scored: Vec<((i64, i32), note_comment::Model)> = tops
            .into_iter()
            .map(|c| {
                let (up, down) = counts.get(&c.id).copied().unwrap_or((0, 0));
                let replies = reply_counts.get(&c.id).copied().unwrap_or(0);
                (hot_key(hot_score(up, down, replies), c.id), c)
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0)); // 降序：热度高的在前；同分则 id 大的在前
        tops = scored.into_iter().map(|(_, c)| c).collect();
    }
    // 顶层在前、回复随其后：前端只按 rootId 分组，不依赖这个顺序，
    // 但顺序稳定让无头断言与人工排查都能按"第 N 行"对账。
    let mut rows = tops;
    rows.extend(replies);
    let dtos: Vec<CommentDto> = rows
        .into_iter()
        .map(|c| {
            let (up, down) = counts.get(&c.id).copied().unwrap_or((0, 0));
            to_dto(
                &c,
                uid,
                &peers,
                super::comment_votes::CommentVoteDto {
                    up,
                    down,
                    my_vote: mine.get(&c.id).copied().unwrap_or(0),
                },
            )
        })
        .collect();
    Json(ApiResponse::success(dtos))
}

/// 行 → DTO。`me` = 当前登录 uid（None = 未登录）；`vote` = 这一行的票（票数是
/// 调用方**批量**查好的，逐行查会把两次往返放大成上百次，见 `list_comments`）。
fn to_dto(
    c: &note_comment::Model,
    me: Option<i32>,
    peers: &std::collections::HashMap<i32, super::profile::PeerInfo>,
    vote: super::comment_votes::CommentVoteDto,
) -> CommentDto {
    let (nickname, avatar, role) = match peers.get(&c.user_id) {
        Some(p) => (p.name.clone(), p.avatar.clone(), p.role.clone()),
        None => (format!("用户#{}", c.user_id), None, String::new()),
    };
    CommentDto {
        id: c.id,
        note_id: c.note_id,
        content: c.content.clone(),
        parent_id: c.parent_id,
        root_id: c.root_id,
        reply_to_uid: c.reply_to_uid,
        // 取不到人（账号已销）⇒ 回 None 让前端说「已注销用户」，
        // **不在这里编一个名字**（同 peer_map 的纪律）
        reply_to_nickname: c
            .reply_to_uid
            .and_then(|u| peers.get(&u).map(|p| p.name.clone())),
        user_id: c.user_id,
        nickname,
        avatar,
        role,
        mine: me == Some(c.user_id),
        up: vote.up,
        down: vote.down,
        my_vote: vote.my_vote,
        created_at: c.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

// ── 通知 ───────────────────────────────────────────────────────────────────

/// 「有人回复了你的评论」——发给**直接父评论的作者**。
///
/// 三条判据，每条都对应一类噪声或一次"点进去什么都没有"的体验：
///   · **只通知被直接回复的那个人**（`reply_to_uid`），不通知顶层作者。一条热评被三十人
///     回复就是三十条通知，对顶层作者全是噪声——他本来就会在讨论区看到。
///   · **自我回复不发**：自己回自己没有信息量，只会让个人中心多一条。
///   · **只在评论已经公开（`approved = 1`）时发**。待审的回复别人根本看不见，
///     通知他"有人回复了你"、点进去却找不到那一条，比不发更糟。
///     于是有两条路径到达这里——创建即通过（`create_comment`）与人工复核 0→1
///     （`audit_comment`）——**两处调的是这一个函数**，重复通知由"本次是否发生 0→1"挡住。
///
/// 通知失败绝不影响评论落库（`notice::push_notice` 内部吞错只记日志）。
async fn notify_comment_reply(
    db: &sea_orm::DatabaseConnection,
    target_uid: i32,
    note_id: i32,
    comment_id: i32,
    replier_uid: i32,
    content: &str,
) {
    let peers = super::profile::peer_map(db, &[replier_uid]).await;
    // 展示名取不到（账号已销）就说「有人」——**不编一个昵称**（同 `peer_map` 的纪律）
    let who = peers
        .get(&replier_uid)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "有人".to_string());
    let brief = super::talks::talk_brief(content);
    super::notice::push_notice(
        db,
        target_uid,
        "有人回复了你的评论",
        Some(format!("{who} 回复了你：{brief}")),
        // 深链到那一条。**只在已公开时发**（见上），所以这个锚点必然存在：
        // `?cid=<id>` 由前端 CommentSection 读出来，滚到 `#c-<id>` 并高亮
        Some(format!("/article/{note_id}?cid={comment_id}")),
    )
    .await;
}

// ── 公开写 ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateComment {
    pub content: String,
    /// **只收直接父评论 id**。`root_id` / `reply_to_uid` 由服务端从父行派生——
    /// 客户端无从伪造"我的回复挂在哪条顶层下"（见文件头注）。
    /// `default`：顶层评论不带这个字段。
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<i32>,
}

/// 发评论的结果。**`approved` 必须回传**：只给 id 的话前端分不出"已公开"与
/// "还在等人工复核"——两条路的提示语完全不同（一条可以说"发布了"，另一条说"发布了"
/// 就是撒谎，说"没通过"又是替审核下结论），前端只能含糊其辞。
/// 这不是把审核结论"提前告诉"谁：发的人本来就会看到自己的评论是否公开。
/// `Default` 只是 `ApiResponse::error` 的 trait 约束（`utils.rs::ApiResponse`），
/// **没有语义**：错误信封里 `code=500`，前端只看 `message`，`data` 一律不读。
/// 别把 `approved: 0` 的默认值当成"默认待审"——从没有哪条路会用到它。
#[derive(Serialize, Default)]
pub struct CreateCommentResult {
    pub id: i32,
    /// 0=待人工复核（公开侧看不到）/ 1=已公开 / 2=未通过
    pub approved: i16,
}

/// POST /api/public/notes/:id/comments —— 发一条评论/回复（强制登录）。
///
/// 返回 `{id, approved}`：`id` 供前端定位到刚发的那条；`approved` 供前端**据实**
/// 提示（见 `CreateCommentResult`）。待审的评论在公开列表里找不到属正常现象。
pub async fn create_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(note_id): Path<i32>,
    Json(payload): Json<CreateComment>,
) -> Json<ApiResponse<CreateCommentResult>> {
    let Some(uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录后再评论"));
    };
    if !note_visible(&state.db, note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }
    let content = clean_content(&payload.content);
    if content.is_empty() {
        return Json(ApiResponse::error("评论不能为空"));
    }
    if content.chars().count() > MAX_COMMENT_CHARS {
        return Json(ApiResponse::error("评论过长（最多 300 字）"));
    }
    // 内容风控（20261002）：与河灯留言**同一道闸、同一份实现**（`risk::screen`
    // 把评论与留言合起来数——需求原文是"短期内大量留言评论"）。
    // 位置：在形状校验之后、读父行之前——被禁言的人不该靠"回复一条不存在的评论"
    // 绕过这条判据，而形状校验是纯本地的、失败时也不占间隔。
    let cfg = crate::risk::load_config(&state.db).await;
    let forced = match crate::risk::screen(&state, uid, &cfg).await {
        // 变量叫 `risk_verdict` 而不是 `verdict`：这个文件里"裁决"另有其主
        // （`decide_review` 回的 agent 裁决词），而这是风控的三档结论（Pass/RateLimited/Muted），
        // 两件事挨着出现在同一个函数里，同名的代价是下一次有人读错。
        Ok(risk_verdict) => crate::risk::apply_verdict(&state, uid, &cfg, risk_verdict).await,
        Err(reject) => return Json(ApiResponse::error(&reject.message())),
    };
    // 回复关系：**只信 parent_id**，三个列全部由父行派生。
    let (parent_id, root_id, reply_to_uid) = match payload.parent_id {
        None => (None, None, None),
        Some(pid) => {
            let parent = match note_comment::Entity::find_by_id(pid).one(&state.db).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("[comment] 查父评论失败 pid={pid}: {e}");
                    return Json(ApiResponse::error("评论失败，请稍后再试"));
                }
            };
            let Some(p) = parent else {
                return Json(ApiResponse::error("要回复的评论不存在"));
            };
            if p.note_id != note_id {
                return Json(ApiResponse::error("要回复的评论不属于这篇文章"));
            }
            // 不能回复一条**自己都看不见**的评论（待审 / 未通过 / 已删）：否则回复者
            // 会收到一个公开侧永远找不到落点的「回复成功」。
            if p.approved != 1 || p.is_deleted != 0 {
                return Json(ApiResponse::error("这条评论当前不可见，回复不了"));
            }
            (
                Some(p.id),
                // 顶层评论的 root_id 是 NULL ⇒ 回复顶层时，顶层自己就是 root
                Some(p.root_id.unwrap_or(p.id)),
                Some(p.user_id),
            )
        }
    };
    // 审核：与留言板**同一份裁决实现**，开关是评论自己那对键
    let (ai_key, manual_key) = super::web_info::COMMENT_REVIEW_KEYS;
    let (ai_on, manual_on) = match
        super::web_info::review_switches_of(&state.db, ai_key, manual_key).await {
            Ok(switches) => switches,
            Err(e) => return super::db_error("读取评论审核设置", &e),
        };
    let (approved, ai_result, ai_reason, reject_reason) =
        super::talks::decide_review("comment", uid, &content, ai_on, manual_on).await;
    // 风控档位只在"本来会直接公开"时改判成待审：**只把 1 压成 0，绝不把 2 松成 0**
    // ——AI 已经判过驳回的内容，不该因为"这个人发得太快"退回成"没人裁过"。
    // 放在通知判定之前：压成 0 之后 `reply_target` 自然是 None（待审的回复不该惊动被回复者，
    // 否则对方点进去看不见任何东西）。前端拿到 `approved=0` 会据实提示"待人工复核"。
    let approved = if forced && approved == 1 { 0 } else { approved };
    // 回复通知的两个入参要在 `content` 被 move 进 ActiveModel 之前留一手。
    // **只有真要发的时候才克隆**：顶层评论占绝大多数，为它们克隆一份正文是白花。
    // （发不发的判据与 `notify_comment_reply` 头注一一对应：已公开 + 是回复 + 不是回自己）
    let reply_target = match (approved, reply_to_uid) {
        (1, Some(t)) if t != uid => Some(t),
        _ => None,
    };
    let notice_src = reply_target.map(|_| content.clone());
    let now = chrono::Local::now().naive_local();
    let row = note_comment::ActiveModel {
        note_id: Set(note_id),
        user_id: Set(uid),
        content: Set(content),
        root_id: Set(root_id),
        parent_id: Set(parent_id),
        reply_to_uid: Set(reply_to_uid),
        approved: Set(approved),
        ai_result: Set(ai_result),
        ai_reason: Set(ai_reason),
        reject_reason: Set(reject_reason),
        created_at: Set(now),
        updated_at: Set(now),
        // is_deleted 不进模型：交给库里的 DEFAULT 0（新行当然没删）
        ..Default::default()
    };
    match note_comment::Entity::insert(row).exec(&state.db).await {
        Ok(r) => {
            let id = r.last_insert_id as i32;
            if let (Some(target), Some(src)) = (reply_target, notice_src.as_deref()) {
                notify_comment_reply(&state.db, target, note_id, id, uid, src).await;
            }
            Json(ApiResponse::success(CreateCommentResult { id, approved }))
        }
        Err(e) => {
            tracing::error!("[comment] 落库失败 uid={uid} note={note_id}: {e}");
            Json(ApiResponse::error("评论失败，请稍后再试"))
        }
    }
}

/// DELETE /api/public/comments/:id —— 删自己的评论（**软删**）。
///
/// 只能删自己的（判据是库里的 `user_id`，不是请求里的任何东西）。顶层评论被软删后
/// 它名下的回复会一起从公开侧消失（组树时找不到顶层）——这是**想要**的行为：
/// 留着回复会变成一串没有上下文的孤儿。
pub async fn delete_my_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match note_comment::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] 查评论失败 id={id}: {e}");
            return Json(ApiResponse::error("删除失败，请稍后再试"));
        }
    };
    let Some(c) = row else {
        return Json(ApiResponse::error("评论不存在"));
    };
    if c.user_id != uid {
        // 别人的评论一律只说"不存在"，不确认它存在（防枚举别人删过什么）
        return Json(ApiResponse::error("评论不存在"));
    }
    let mut am: note_comment::ActiveModel = c.into();
    am.is_deleted = Set(1);
    am.updated_at = Set(chrono::Local::now().naive_local());
    match note_comment::Entity::update(am).exec(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
        Err(e) => {
            tracing::error!("[comment] 软删失败 id={id}: {e}");
            Json(ApiResponse::error("删除失败，请稍后再试"))
        }
    }
}

// ── 后台 ───────────────────────────────────────────────────────────────────

/// 后台列表的一行：评论本体 + 作者 + **挂在哪篇文章下**（管理员要能点回去看上下文）。
#[derive(Serialize)]
pub struct CommentAdminDto {
    pub id: i32,
    #[serde(rename = "noteId")]
    pub note_id: i32,
    /// 文章标题；查不到（文章已删）为空串，前端显示「（文章已删除）」
    #[serde(rename = "noteTitle")]
    pub note_title: String,
    pub content: String,
    #[serde(rename = "userId")]
    pub user_id: i32,
    pub username: String,
    pub nickname: String,
    /// 被回复者（「回复 @某人」那一行的 admin 侧镜像）；null = 顶层
    #[serde(rename = "replyToNickname")]
    pub reply_to_nickname: Option<String>,
    #[serde(rename = "createTime")]
    pub created_at: String,
    /// 0=待审 / 1=通过 / 2=未通过（与留言板同口径，后台两个现成组件可直接复用）
    pub approved: i16,
    /// AI 判定留痕：pass / flag / reject；null = 没走 AI
    ///
    /// ⚠️ **键名是 `aiResult`，不是 `ai_result`**（20261002 与评论管理页一起定）：
    /// 这个 DTO 其余字段全是 camelCase，而 `ai_result`/`is_deleted` 是顺着实体列名抄
    /// 下来的（留言板那个 `BoardAdminDto` 也是这两处例外——它有已上线的消费者，
    /// 不动它）。评论这个 DTO 只被评论管理页一个消费者读、还没上线，此时统一比
    /// "两页在同一个概念上键名不同"更值——所以这里补上 rename。
    /// **别对照留言板那个 DTO 抄字段名**：`ai_result` 与 `aiResult` 只差一个下划线，
    /// 前端读错时拿到的是 `undefined`（不报错、只是那一列永远显示「未审」）。
    #[serde(rename = "aiResult")]
    pub ai_result: Option<String>,
    /// 驳回理由；null = 未驳回或没人写过理由（后台显示「未填写」）
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
    /// AI 审核说明：**与裁决无关**，pass/flag/reject 都可能有。管理员先看得到 AI 的
    /// 判断才写得出具体理由，所以后台带它、公开侧不带（内部注记不该发给全体访客）
    #[serde(rename = "aiReason")]
    pub ai_reason: Option<String>,
    /// 是否已软删（作者自删或管理员删除）。**这个字段只有后台有**：公开侧按
    /// `is_deleted = 0` 过滤，删掉的评论在那边**不存在**。后台保留这一行是为了溯源
    /// （谁删了什么），并且明确标出来——已删的行**不可再审**（见 `audit_comment`）。
    #[serde(rename = "isDeleted")]
    pub is_deleted: i16,
}

/// Comment review filters; pagination is opt-in and legacy reads retain their cap.
#[derive(Deserialize)]
pub struct CommentAdminQuery {
    pub id: Option<i32>,
    pub status: Option<ReviewStatus>,
    pub q: Option<String>,
    pub note_id: Option<i32>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub(super) fn comment_admin_filter(q: &CommentAdminQuery) -> Select<note_comment::Entity> {
    let mut finder = note_comment::Entity::find();
    if let Some(id) = q.id { finder = finder.filter(note_comment::Column::Id.eq(id)); }
    if let Some(status) = q.status {
        finder = finder.filter(note_comment::Column::Approved.eq(status.approved()));
    }
    if let Some(id) = q.note_id { finder = finder.filter(note_comment::Column::NoteId.eq(id)); }
    if let Some(kw) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let pat = format!("%{}%", crate::search_core::like_escape(kw));
        let authors = user::Entity::find().select_only().column(user::Column::Id)
            .filter(Condition::any().add(user::Column::Username.into_expr().ilike(&pat))
                .add(user::Column::Nickname.into_expr().ilike(&pat))).into_query();
        finder = finder.filter(Condition::any()
            .add(note_comment::Column::Content.into_expr().ilike(&pat))
            .add(note_comment::Column::UserId.in_subquery(authors)));
    }
    finder.order_by_desc(note_comment::Column::CreatedAt).order_by_desc(note_comment::Column::Id)
}

/// GET /api/protect/comments —— 评论管理列表（倒序；可按状态 / 关键词收窄）。
///
/// ⚠️ **筛选项收窄的是"看到哪些"，不是"哪些能被审"**：`audit_comment` 按主键认行，
/// 与这里传了什么筛选无关。所以 `status=pending` 只是给"待审队列"用的一个视图，
/// 它不是权限边界。
pub async fn list_comments_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<CommentAdminQuery>,
) -> Json<ApiResponsePage<Vec<CommentAdminDto>>> {
    let Some(_uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponsePage::error("请先登录"));
    };
    let window = match page_window(q.page, q.page_size) {
        Ok(value) => value, Err(message) => return Json(ApiResponsePage::error(message)),
    };
    let total = if window.is_some() {
        match comment_admin_filter(&q).count(&state.db).await {
            Ok(n) => Some(n as i64),
            Err(error) => {
                tracing::error!("[comment] count failed: {error}");
                return Json(ApiResponsePage::error("查询失败，请稍后再试"));
            }
        }
    } else { None };
    let mut finder = comment_admin_filter(&q);
    if let Some((size, offset)) = window { finder = finder.limit(size).offset(offset); }
    else { finder = finder.limit(ADMIN_PAGE_LIMIT); }
    let rows = match finder
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] list_comments_admin 查询失败: {e}");
            return Json(ApiResponsePage::error("查询失败，请稍后再试"));
        }
    };
    // 作者与"被回复者"共用一份（去重后 is_in，同 list_board_admin 的做法）
    let mut uids: Vec<i32> = rows.iter().map(|c| c.user_id).collect();
    uids.extend(rows.iter().filter_map(|c| c.reply_to_uid));
    uids.sort_unstable();
    uids.dedup();
    let peers = super::profile::peer_map(&state.db, &uids).await;
    // 文章标题：只取用到的两列（find() 是 SELECT *，会把正文一起捞出来）
    let mut note_ids: Vec<i32> = rows.iter().map(|c| c.note_id).collect();
    note_ids.sort_unstable();
    note_ids.dedup();
    let titles: std::collections::HashMap<i32, String> = if note_ids.is_empty() {
        std::collections::HashMap::new()
    } else {
        note::Entity::find()
            .select_only()
            .column(note::Column::Id)
            .column(note::Column::Title)
            .filter(note::Column::Id.is_in(note_ids))
            .into_tuple::<(i32, String)>()
            .all(&state.db)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect()
    };
    let dtos = rows
        .into_iter()
        .map(|c| {
            let (nickname, username) = match peers.get(&c.user_id) {
                Some(p) => (p.name.clone(), p.username.clone()),
                None => (format!("用户#{}", c.user_id), String::new()),
            };
            CommentAdminDto {
                id: c.id,
                note_id: c.note_id,
                note_title: titles.get(&c.note_id).cloned().unwrap_or_default(),
                content: c.content,
                user_id: c.user_id,
                // 后台要能按账号找到人（用户管理页是按账号列的），所以两个都给；
                // 公开侧只给 nickname（展示名），不发账号
                username,
                nickname,
                reply_to_nickname: c
                    .reply_to_uid
                    .and_then(|u| peers.get(&u).map(|p| p.name.clone())),
                created_at: c.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
                approved: c.approved,
                ai_result: c.ai_result,
                reject_reason: c.reject_reason,
                ai_reason: c.ai_reason,
                is_deleted: c.is_deleted,
            }
        })
        .collect();
    Json(ApiResponsePage::success(dtos, total))
}

#[derive(Deserialize)]
pub struct AuditCommentBody {
    /// 1=通过（放行展示）；0=驳回——写 `approved = 2`「未通过」，与待审(0) 区分
    /// （同留言板的 `AuditBody`：本人那一侧按 0 显示待审、2 显示未通过）
    approved: i16,
    /// 驳回理由，可空。**通过时请求里带什么都不生效**（改判即清空该列）。
    /// `serde(default)` 保证只发 approved 的调用方照常工作。
    #[serde(default)]
    reason: Option<String>,
}

/// PUT /api/protect/comments/:id/audit —— 评论人工复核。
///
/// 规则与 `talks::audit_board` **逐条对齐**（两条链路两个 handler、一套语义）：
///   · 裁决只写 `approved`，**不改写 `ai_result`**——AI 判定是历史留痕；
///   · 驳回理由走三级回落：**人工手填 > `reject_reason`（AI 判 reject 的说明）>
///     `ai_reason`（AI 存疑说明）**，三级都没有就保持 NULL，不往库里塞编好的话
///     （通知层的固定文案在通知那一层兜）；
///   · **改判回通过时清空 `reject_reason`**（不留"已通过却带驳回理由"的矛盾行），
///     `ai_reason` 不动（它是 AI 那一侧的留痕，不回溯）；
///   · **已软删的行不可审**（20261002）：公开侧看不见它，改判只会在后台造出一行
///     "看起来已通过"的假象（判据见下面那段）。
///
/// 通知：这里发的是「你的回复被放行了」那条**回复通知**（发给被回复者），不是
/// 「你的评论已通过审核」（发给作者）。后者**故意不做**——留言板那边发它是因为作者有
/// 「我的河灯」可去，而评论没有对应的「我的评论」入口：待审/未通过的通知会把作者送到
/// 一个**看不到自己那条**的页面上。作者那一侧的即时反馈已经由发评论接口的返回给了
/// （`CreateCommentResult.approved`，前端当场说清三种结局）。
/// 将来若加了「我的评论」，这条通知要在**这里**接上（不要另起一条链路）。
pub async fn audit_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<AuditCommentBody>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match note_comment::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] audit_comment 查询失败 id={id}: {e}");
            return Json(ApiResponse::error("操作失败，请稍后再试"));
        }
    };
    let Some(c) = row else {
        return Json(ApiResponse {
            code: 404,
            message: "Comment not found".to_string(),
            data: String::default(),
        });
    };
    // 已软删的评论**不可再审**（20261002 与评论管理页一起加）：公开侧按
    // `is_deleted = 0` 过滤，所以给一条已删评论改判"通过"是**看不见效果**的，
    // 而后台会弹一句「已通过」并把它标成绿色「通过」——界面因此说了一件没发生的事。
    // 前端那一侧的操作列也不给按钮（**两处都要有**：那里是正常路径的界面判据，
    // 这里是脚本 / 老前端 / 直接打接口也走得到的最终防线）。
    if c.is_deleted != 0 {
        return Json(ApiResponse::error("这条评论已删除，无法审核"));
    }
    let reject = payload.approved == 0;
    let saved_reason = c.reject_reason.clone();
    let saved_ai_reason = c.ai_reason.clone();
    // 回复通知要用的四样，转 ActiveModel 之前先各留一份（`c` 随后被 move）。
    // 这里是低频的管理动作，不做"要不要才克隆"那套（那是写入热路径的优化）
    let owner = c.user_id;
    let was_approved = c.approved;
    let note_id = c.note_id;
    let reply_target = c.reply_to_uid;
    let brief_src = c.content.clone();
    let mut am: note_comment::ActiveModel = c.into();
    am.approved = Set(if reject { 2 } else { 1 });
    am.reject_reason = Set(if reject {
        payload
            .reason
            .as_deref()
            .and_then(super::talks::clip_reject_reason)
            .or(saved_reason)
            .or(saved_ai_reason)
    } else {
        None
    });
    am.updated_at = Set(chrono::Local::now().naive_local());
    match note_comment::Entity::update(am).exec(&state.db).await {
        Ok(_) => {
            // 回复通知的**第二条到达路径**：这条回复创建时进了待审，此刻被人工放行。
            // 判据是"本次真的从'未公开'变成'公开'"（`was_approved != 1 && new == 1`）：
            // 后台重复点同一个按钮不该又发一条（同 `audit_board` 那条 `was_approved != new_approved`）。
            // 创建即通过那条路径在 `create_comment` 里已经发过，两条路**不会同时命中**。
            let new_approved = if reject { 2 } else { 1 };
            if was_approved != 1 && new_approved == 1 {
                if let Some(t) = reply_target {
                    if t != owner {
                        notify_comment_reply(&state.db, t, note_id, id, owner, &brief_src).await;
                    }
                }
            }
            Json(ApiResponse::success("Audited".to_string()))
        }
        Err(e) => {
            tracing::error!("[comment] 人工复核落库失败 id={id}: {e}");
            Json(ApiResponse::error("操作失败，请稍后再试"))
        }
    }
}

/// DELETE /api/protect/comments/:id —— 后台删除（同样**软删**）。
///
/// 后台的删除与作者自删走同一个软删位：公开侧的行为必须一致（都是"连带回复一起消失"），
/// 否则同一个动作在两条路径下效果不同，排查时对不上账。
pub async fn delete_comment_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    let Some(_uid) = super::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponse::error("请先登录"));
    };
    let row = match note_comment::Entity::find_by_id(id).one(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[comment] delete_comment_admin 查询失败 id={id}: {e}");
            return Json(ApiResponse::error("删除失败，请稍后再试"));
        }
    };
    let Some(c) = row else {
        return Json(ApiResponse::error("评论不存在"));
    };
    let mut am: note_comment::ActiveModel = c.into();
    am.is_deleted = Set(1);
    am.updated_at = Set(chrono::Local::now().naive_local());
    match note_comment::Entity::update(am).exec(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
        Err(e) => {
            tracing::error!("[comment] 后台软删失败 id={id}: {e}");
            Json(ApiResponse::error("删除失败，请稍后再试"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 正文归一：控制字符全剥、**`\n` 留着**、首尾空白去掉。
    ///
    /// `\n` 不能跟着一起剥：渲染管线的 breaks 插件拿它换行，分段是评论里的真实表达。
    /// `\r`/`\t`/NUL 则一律剥掉——它们对读者没有意义，却能让后台列表的截断看起来
    /// 莫名其妙（`\r\n` 不剥的话正文里会多出一个空格，留言板那条 `talk_brief`
    /// 就为它专门拍过平）。
    #[test]
    fn 正文归一_剥控制字符但留换行() {
        assert_eq!(clean_content("  你好  "), "你好");
        assert_eq!(clean_content("第一行\r\n第二行"), "第一行\n第二行");
        assert_eq!(clean_content("a\tb\u{0}c"), "abc");
        assert!(clean_content("上\n下").contains('\n'));
    }

    /// 纯空白 = 空：不能靠敲几个空格骗过「评论不能为空」。
    #[test]
    fn 纯空白不算内容() {
        assert!(clean_content("   \n\t  ").is_empty());
    }

    /// 上限按**字符**算不按字节：300 个汉字是 900 字节，按字节判会把中文评论的
    /// 上限压到 100 字（留言板那条 `clip_reject_reason` 的注释记过同一个坑）。
    #[test]
    fn 长度上限按字符算() {
        assert_eq!(clean_content(&"啊".repeat(MAX_COMMENT_CHARS)).chars().count(), MAX_COMMENT_CHARS);
        assert!("啊".repeat(MAX_COMMENT_CHARS + 1).chars().count() > MAX_COMMENT_CHARS);
    }

    // ── 热度公式（20261020）────────────────────────────────────────────────
    // 四条不变量 + 两个交叉点。**不变量**是公式的形状（改符号/去先验/去掉 id 兜底必红），
    // **交叉点**是产品口径（"多少条回复压得过几个赞"是拍出来的，改动必须是一次有意识的
    // 测试修改，而不是顺手调个常量）。

    /// 单调性：赞越多分越高、踩越多分越低、回复越多分越高。三条各挖一个反控。
    #[test]
    fn 热度分对三个信号都单调() {
        assert!(hot_score(3, 0, 0) > hot_score(2, 0, 0), "赞多 ⇒ 分高");
        assert!(hot_score(0, 3, 0) < hot_score(0, 2, 0), "踩多 ⇒ 分低");
        assert!(hot_score(1, 0, 5) > hot_score(1, 0, 4), "回复多 ⇒ 分高");
    }

    /// ★ 先验的存在理由：**0 票 0 回复不许垫底**。
    /// 没有先验时 Wilson(0,0) 恒等于 0，新评论永远沉在坟底——那正是当初反对按票排序的
    /// 理由（见 `HOT_PRIOR_VOTES` 的注释）。这一条钉住它。
    #[test]
    fn 零票评论高于净负票评论_低于有一条赞的() {
        assert!(hot_score(0, 0, 0) > hot_score(0, 1, 0), "0 票要高于净负票（先验的作用）");
        assert!(hot_score(0, 0, 0) < hot_score(1, 0, 0), "但压不过真有一条赞的");
    }

    /// 回复项是**对数增长、没有上界**——这两件事必须一起钉住。
    ///
    /// 第一半（每翻一倍加一个 α）是公式的形状：把 `log2` 换成线性、或把系数写成 1.0
    /// 之外的东西，这几条当场红。
    ///
    /// 第二半（**无上界**）是本条存在的真正理由：写这段代码时我第一版断言的是"再多回复
    /// 也压不过 30 赞"，**那是错的**——`log2` 压得慢，不是封顶，实测约 178 条回复就追平
    /// 30 个赞。错的不是公式，是那句注释。所以这里把兑换率的两侧都钉住：一百条还压不过、
    /// 三百条压得过。**哪天有人给回复项加 `min()`，这两条会一起红**——那正是该发生的事，
    /// 因为"吵架帖霸榜"是一个要拍板的产品取舍，不该由一个安静的 `min()` 悄悄改掉。
    #[test]
    fn 回复项是对数增长_没有上界() {
        let d = |n: i64| hot_score(0, 0, n);
        for n in [0_i64, 1, 3, 7, 15, 31] {
            let step = d(2 * n + 1) - d(n);
            assert!(
                (step - HOT_REPLY_WEIGHT).abs() < 1e-12,
                "回复数从 {n} 翻到 {} 该恰好加一个 α（{HOT_REPLY_WEIGHT}），实际 {step}",
                2 * n + 1
            );
        }
        assert!(d(100) < hot_score(30, 0, 0), "一百条回复还压不过 30 个赞");
        assert!(d(300) > hot_score(30, 0, 0), "但三百条就压过了 —— 回复项**没有上界**");
    }

    /// 排序键是**全序**：同分不同 id 必须分得出先后（id 降序），且**同一份数据每次排出
    /// 同一个顺序**——否则无头断言与人工排查都没法按"第 N 行"对账。
    #[test]
    fn 排序键是全序_同分按id降序() {
        let a = hot_key(hot_score(2, 0, 0), 7);
        let b = hot_key(hot_score(2, 0, 0), 9);
        assert_ne!(a, b, "同分必须靠 id 分出先后");
        assert!(b > a, "id 大的排前面（降序）");
        assert_eq!(a, hot_key(hot_score(2, 0, 0), 7), "同一份输入 ⇒ 同一个键");
    }

    /// 两个交叉点（产品口径，不是数学性质）：**读代码注释里那张表的人应该能在这里看到
    /// 同样的结论**。改常量会让这两条红——那正是"要改先想清楚"的意思。
    #[test]
    fn 交叉点_回复数与赞数的兑换率() {
        // 15 条回复（+0.40）能越过 5 赞 1 踩（0.409）——讨论量是强信号。
        assert!(hot_score(0, 0, 15) > hot_score(5, 1, 0));
        // 但 3 条回复（+0.20）越不过 5 赞 1 踩——随手聊两句不算热度。
        assert!(hot_score(0, 0, 3) < hot_score(5, 1, 0));
    }

    /// 读数对照表：注释里写的那几个数就是这几个数（改公式时这张表要么跟着改、要么红）。
    #[test]
    fn 读数对照表() {
        let round = |v: f64| (v * 1000.0).round() / 1000.0;
        assert_eq!(round(hot_score(0, 0, 0)), 0.095);
        assert_eq!(round(hot_score(1, 0, 0)), 0.208);
        assert_eq!(round(hot_score(5, 1, 0)), 0.409);
        assert_eq!(round(hot_score(0, 0, 15)), 0.495);
        assert_eq!(round(hot_score(0, 5, 0)), 0.026);
    }
}
