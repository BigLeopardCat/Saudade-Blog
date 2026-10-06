//! 站内**聚合搜索**（20261006，用户第 1 条）：一次搜文章 / 说说 / 留言 / 评论。
//!
//! ── 与 `/api/public/notes/search` 的分工 ────────────────────────────────
//! 那个端点是**文章**搜索（20260912 起带相关度排序），前台分类页与 agent 的
//! `search_notes` 工具都在用它，**一个字都不能动**。本模块是它的横向扩展：同样的
//! 「切词 → 判定 → 分档排序」走 `crate::search_core`（规则只有一份），回的是四类混合结果。
//!
//! ── 口径是承重墙 ───────────────────────────────────────────────────
//! 聚合搜索把**四张表**一次倒给访客，所以每一类的公开可见性谓词都必须逐条照抄现成读路径，
//! 少一条就是泄露。四条原文出处：
//!   · 文章   `notes::list_public_notes` / `notes::search_notes`：`is_public = 1`
//!            且 `status <> 'draft'`
//!   · 说说   `talks::list_by_src`：`src = 'talk'` 且 `approved = 1`
//!   · 留言   `talks::list_by_src`：`src = 'board'` 且 `approved = 1`
//!   · 评论   `comments::list_comments`：`approved = 1` 且 `is_deleted = 0`，
//!            且**父文章本身可见**（`comments::note_visible`，同一口径）
//!
//! ⚠️ **留言（`src = 'board'`）的 `title` 列存的是印章**（愿/寄/忆/诉，见
//! `talks.rs::insert_talk` 里「`title` 这一列上挤着两套语义」那段），**不是标题**。
//! 留言只搜 `content` —— 印章是四个字之一，搜 `title` 等于"搜『愿』就把整个留言板
//! 倒出来"，那是把"命中数量"变成噪声。
//!
//! ⚠️ **留言的作者是自由留名（`talk.author`），不是账号身份**。留言板那条边界
//! （公开面不带账号身份）在本接口同样成立：**不许**拿 `talk.user_id` 反查昵称。
//!
//! ── 不加每类上限 ───────────────────────────────────────────────────
//! 本站公开侧处处不分页（`list_public_notes`、说说、留言、单篇评论全是全量），文章量小。
//! 加 cap 会让"命中数量"与列表长度对不上——那是自造的假象：用户看到「文章(12)」却
//! 只数得出 10 行，会以为界面坏了。宁可全给。

use axum::{extract::State, Json};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::entity::{note, note_comment, talk};
use crate::routes::{db_error, AppState};
use crate::search_core::{count_terms, like_escape, rank_tiered, score_term_sum, snippet, split_terms};
use crate::utils::ApiResponse;

/// 每行摘要的字符上限（四类共用）。
///
/// 为什么是 100：搜索弹窗里每行只给两行的高度，100 个汉字已经远超两行；再长也只是
/// 把网络的字节和浏览器的排版都浪费掉。**按字符不按字节**（见 `search_core::snippet`）。
const SNIPPET_CHARS: usize = 100;

#[derive(Deserialize)]
pub struct SearchAllRequest {
    /// 关键词。缺省 / 空串 / 全空白 = 没给（回空结果，见下面 handler 开头）。
    /// 字段名用 `keyword` 与 `/api/public/notes/search` 的 `SearchRequest` 保持一致。
    #[serde(default)]
    pub keyword: Option<String>,
}

/// 四类各自的命中数。**键名与 `SearchHit::kind` 同名**（note/talk/board/comment），
/// 前端只用一处映射表就能把「文章(3)」和列表分组对上。
#[derive(Serialize, Default)]
pub struct SearchCounts {
    pub note: usize,
    pub talk: usize,
    pub board: usize,
    pub comment: usize,
}

/// 一行结果。四类同形——前端一张渲染模板吃到底，跳转目标由 `kind` 决定。
///
/// `title` 是**行首标题**：文章标题 / 说说标题 / **评论所属文章的标题**；
/// 留言恒为空串（见模块头注：留言的 `title` 列是落款，不能当标题用）。
/// `noteId` 只有评论有值——前端拼 `?cid=` 定位到那条评论时要带上它。
#[derive(Serialize)]
pub struct SearchHit {
    /// note / talk / board / comment
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// 该类型内的主键：文章 id / 说说 id / 留言 id / 评论 id
    pub key: i32,
    pub title: String,
    pub snippet: String,
    /// 展示用的发布者：文章=署名（与卡片同一条回退链）/ 说说=昵称 / 留言=自由留名 /
    /// 评论=评论者昵称
    pub author: String,
    /// 只有评论有：所属文章 id
    #[serde(rename = "noteId")]
    pub note_id: Option<i32>,
    #[serde(rename = "createTime")]
    pub create_time: String,
}

#[derive(Serialize, Default)]
pub struct SearchAllData {
    /// 命中总数 == `counts` 四项之和 == 四个数组长度之和（三处同源，见 handler 末尾）
    pub total: usize,
    pub counts: SearchCounts,
    pub notes: Vec<SearchHit>,
    pub talks: Vec<SearchHit>,
    pub board: Vec<SearchHit>,
    pub comments: Vec<SearchHit>,
}

/// POST /api/public/search —— 站内聚合搜索（**无鉴权**，与 `/api/public/notes/search` 同档）。
///
/// ⚠️ 只许挂 `public_routes`。`protected_routes` 域内由 `auth_guard` **全量要求管理员**，
/// 挂进去普通访客会 403——而搜索框是给未登录访客用的。
pub async fn search_all(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchAllRequest>,
) -> Json<ApiResponse<SearchAllData>> {
    // 先切词再判空：**"没给关键词"与"给了但切不出可用 term"（`第1章` / 纯标点）在这里
    // 合流成同一个答案**（空结果）。这与 `search_notes` 的分岔不同——那边"没给关键词"
    // 是"返回整表"（分类页靠它拉全量），所以必须用 `keyword_given` 把两者分开；
    // 本接口没有"无关键词 → 返回全部"这回事，合流是安全的，也堵死了那条假命中的路。
    //
    // ⚠️ 空关键词在这里**直接返回、不查库**：既省四次查询，也让"空查询回什么"这件事
    // 完全确定（集成测试可以在没有库的情况下断言它）。
    let terms = payload
        .keyword
        .as_deref()
        .map(split_terms)
        .unwrap_or_default();
    if terms.is_empty() {
        return Json(ApiResponse::success(SearchAllData::default()));
    }

    // ── ① 文章 ────────────────────────────────────────────────────────
    // 与 `notes::search_notes` **故意一致**地不做 SQL 侧关键词过滤：`note.tags` 存的是
    // 逗号分隔的标签 **id**，SQL 只能对 id 串 LIKE（搜标签名永远 0 命中、搜纯数字却假命中）。
    // 标签名要先过字典，只能在内存里判。代价是全量加载，理由同那边：本站文章量小、公开侧不分页。
    let dict = super::notes::load_tag_names(&state.db).await;
    let all_notes = match note::Entity::find()
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => return db_error("站内搜索-文章", &e),
    };
    // 这一批同时就是**评论能挂在哪些文章上**的可见集合（口径完全同源，省一次查询）：
    // 文章可见性只有这一处判据，两边各写一遍迟早会漂成"评论读得到、文章打不开"。
    let visible_ids: Vec<i32> = all_notes.iter().map(|n| n.id).collect();
    let title_by_id: HashMap<i32, String> =
        all_notes.iter().map(|n| (n.id, n.title.clone())).collect();

    let mut note_rows = Vec::new();
    for n in all_notes {
        let tag_names = super::notes::note_tag_names(n.tags.as_deref(), &dict);
        let hit = count_terms(&terms, |t| super::notes::note_hits_keyword(&n, t, &tag_names));
        if hit == 0 {
            continue;
        }
        let score = score_term_sum(&terms, Some(&n.title), &tag_names, &n.content);
        note_rows.push((hit, score, n.created_at, n));
    }
    let note_ranked = rank_tiered(terms.len(), note_rows);

    // ── ② 说说 / ③ 留言 ───────────────────────────────────────────────
    let talk_ranked = match talk_hits(&state, "talk", &terms).await {
        Ok(v) => v,
        Err(e) => return db_error("站内搜索-说说", &e),
    };
    let board_ranked = match talk_hits(&state, "board", &terms).await {
        Ok(v) => v,
        Err(e) => return db_error("站内搜索-留言", &e),
    };

    // ── ④ 评论 ────────────────────────────────────────────────────────
    let comment_ranked = match comment_hits(&state, &terms, &visible_ids).await {
        Ok(v) => v,
        Err(e) => return db_error("站内搜索-评论", &e),
    };

    // ── 署名 ──────────────────────────────────────────────────────────
    // 文章与评论都按账号查展示名（`profile::peer_map`，昵称优先、空昵称退账号）。
    let mut uids: Vec<i32> = Vec::new();
    uids.extend(note_ranked.iter().filter_map(|n| n.user_id));
    uids.extend(talk_ranked.iter().map(|t| t.user_id));
    uids.extend(comment_ranked.iter().map(|c| c.user_id));
    let peers = super::profile::peer_map(&state.db, &uids).await;
    // 文章署名的兜底与卡片完全同一条链：uid 为 NULL（本列之前发布的老文章 / 发布者账号
    // 已销）⇒ 站点级署名。**有作者记录时一个字段都不借站长的身份**（见 `attach_authors`）。
    let site_author = super::web_info::site_author(&state.db).await.0;
    let note_author = |n: &note::Model| -> String {
        match n.user_id.and_then(|id| peers.get(&id)) {
            Some(p) => p.name.clone(),
            None => site_author.clone(),
        }
    };

    let notes: Vec<SearchHit> = note_ranked
        .iter()
        .map(|n| SearchHit {
            kind: "note",
            key: n.id,
            title: n.title.clone(),
            snippet: note_snippet(n),
            author: note_author(n),
            note_id: None,
            create_time: stamp(n.created_at),
        })
        .collect();

    let talks: Vec<SearchHit> = talk_ranked
        .iter()
        .map(|t| SearchHit {
            kind: "talk",
            key: t.id,
            title: t.title.clone().unwrap_or_default(),
            snippet: snippet(&t.content, SNIPPET_CHARS),
            // 说说给**展示名**（昵称优先、空昵称退账号）——这是后台说说卡上那一份，
            // 也是 `TalkDto.nickname` 的语义。查不到就退回自由留名，不编人名。
            author: peers
                .get(&t.user_id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| t.author.clone()),
            note_id: None,
            create_time: stamp(t.created_at),
        })
        .collect();

    let board: Vec<SearchHit> = board_ranked
        .iter()
        .map(|t| SearchHit {
            kind: "board",
            // ⚠️ 留言的作者是**自由留名**，`user_id` 一概不看（见模块头注）。
            key: t.id,
            title: String::new(),
            snippet: snippet(&t.content, SNIPPET_CHARS),
            author: t.author.clone(),
            note_id: None,
            create_time: stamp(t.created_at),
        })
        .collect();

    let comments: Vec<SearchHit> = comment_ranked
        .iter()
        .map(|c| SearchHit {
            kind: "comment",
            key: c.id,
            // 评论自己**没有**标题：行首标题用**它挂在哪篇文章**上——那才是读者定位
            // 这条讨论所需的上下文（也是跳转 `?cid=` 之后会落到的地方）。
            title: title_by_id.get(&c.note_id).cloned().unwrap_or_default(),
            snippet: snippet(&c.content, SNIPPET_CHARS),
            author: peers
                .get(&c.user_id)
                .map(|p| p.name.clone())
                .unwrap_or_default(),
            note_id: Some(c.note_id),
            create_time: stamp(c.created_at),
        })
        .collect();

    let counts = SearchCounts {
        note: notes.len(),
        talk: talks.len(),
        board: board.len(),
        comment: comments.len(),
    };
    // 三处同源：`total` 就是四个数组的长度之和，也就是 `counts` 四项之和。
    // 不另算一遍"命中总数"——两个来源迟早会不一样，而前端会同时显示这两个数。
    let total = counts.note + counts.talk + counts.board + counts.comment;

    Json(ApiResponse::success(SearchAllData {
        total,
        counts,
        notes,
        talks,
        board,
        comments,
    }))
}

/// 说说 / 留言的候选行（`src` = `"talk"` 或 `"board"`），已按公共口径分档排序。
///
/// SQL 只做**预筛**：`approved = 1` + 逐 term 的 `content LIKE`（说说**另加** `title LIKE`）。
/// 取回后再在内存里用同一套 `count_terms` / `score_term_sum` 走档位 —— SQL 的
/// "OR of terms" 正好是"至少命中一个词"的**超集**，不会漏；而它做不了的
/// 「全中优先」与打分留在内存里。
///
/// ⚠️ 两件事都不许"优化"掉：
///   · **不许拿整串 keyword 直接 LIKE**（`%ESP32 固件%`）——多词查询会被静默漏掉，
///     而那正是切词要解决的问题（见 `search_core::split_terms` 头注里的假否定实例）；
///   · **留言不许 LIKE `title`**（那是印章，见模块头注）。
async fn talk_hits(
    state: &Arc<AppState>,
    src: &str,
    terms: &[String],
) -> Result<Vec<talk::Model>, sea_orm::DbErr> {
    let is_talk = src == "talk";
    let mut cond = Condition::any();
    for t in terms {
        let pat = format!("%{}%", like_escape(t));
        cond = cond.add(talk::Column::Content.like(&pat));
        if is_talk {
            cond = cond.add(talk::Column::Title.like(&pat));
        }
    }
    let rows = talk::Entity::find()
        .filter(talk::Column::Src.eq(src))
        .filter(talk::Column::Approved.eq(1))
        .filter(cond)
        .all(&state.db)
        .await?;

    let mut scored = Vec::new();
    for t in rows {
        let title = t.title.clone().unwrap_or_default();
        let hit = count_terms(terms, |k| {
            t.content.to_lowercase().contains(k)
                || (is_talk && title.to_lowercase().contains(k))
        });
        if hit == 0 {
            continue;
        }
        // 打分的标题维度只有说说有；留言传 `None`（它的 `title` 是落款，算进标题权重
        // 等于给"落款撞上关键词"的留言凭空加分）。
        let score = score_term_sum(
            terms,
            if is_talk { Some(&title) } else { None },
            &[],
            &t.content,
        );
        scored.push((hit, score, t.created_at, t));
    }
    Ok(rank_tiered(terms.len(), scored))
}

/// 评论候选行，已按公共口径分档排序。
///
/// 三个过滤器缺一不可：`approved = 1`（未过审不公开）、`is_deleted = 0`（软删的
/// 不能从搜索里漏出来）、`note_id IN (可见文章)`（**草稿/隐藏文章下的讨论整片不出现**）。
/// 最后一条还有个坑：`visible_ids` 为空时**必须短路**——`IN ()` 是 SQL 语法错误，
/// 库里一条可见文章都没有时（全新部署）会整条请求 500。
///
/// 打分**只对 `content`**：把所属文章的标题也算进去，搜一个常见词会让评论栏被
/// "那篇文章标题里有这个词"的评论灌满——那些评论自己根本没提这个词。
async fn comment_hits(
    state: &Arc<AppState>,
    terms: &[String],
    visible_ids: &[i32],
) -> Result<Vec<note_comment::Model>, sea_orm::DbErr> {
    if visible_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut cond = Condition::any();
    for t in terms {
        cond = cond.add(note_comment::Column::Content.like(format!("%{}%", like_escape(t))));
    }
    let rows = note_comment::Entity::find()
        .filter(note_comment::Column::NoteId.is_in(visible_ids.to_vec()))
        .filter(note_comment::Column::Approved.eq(1))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .filter(cond)
        .all(&state.db)
        .await?;

    let mut scored = Vec::new();
    for c in rows {
        let hit = count_terms(terms, |k| c.content.to_lowercase().contains(k));
        if hit == 0 {
            continue;
        }
        let score = score_term_sum(terms, None, &[], &c.content);
        scored.push((hit, score, c.created_at, c));
    }
    Ok(rank_tiered(terms.len(), scored))
}

/// 文章那行的摘要：有 `description`（作者自己写的导读）就用它，否则退回正文开头。
fn note_snippet(n: &note::Model) -> String {
    let desc = n.description.as_deref().unwrap_or("").trim();
    if desc.is_empty() {
        snippet(&n.content, SNIPPET_CHARS)
    } else {
        snippet(desc, SNIPPET_CHARS)
    }
}

/// 与四条读路径一致的钟面格式（`+08:00` 本地钟面，见 CLAUDE.md 的时区约定）。
fn stamp(t: chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}
