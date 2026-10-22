use axum::{Json, extract::{State, Query, Path}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}};
use sea_orm::{DatabaseConnection, EntityTrait, ColumnTrait, QueryFilter, QueryOrder, QuerySelect, Condition, ActiveModelTrait, Set, PaginatorTrait, ActiveValue::NotSet, DerivePartialModel, TransactionTrait};
// `Expr` / `SimpleExpr` 只服务关键词预筛那几处（列表达式要带表名限定，见 `search_notes`）。
use sea_orm::sea_query::{Expr, SimpleExpr};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use crate::entity::{note, category, user};
use crate::routes::note_tags::{self, attach_tags};
use crate::routes::AppState;
use crate::search_core::{count_terms, keyword_given, keyword_prefilter, score_term_sum, split_terms};
use crate::utils::ApiResponse;

// ── 文章状态词表：唯一解析点（20261018）───────────────────────────────────────
//
// `status` 与 `is_public` 是**两个字段描述同一件事**，此前四处写点各自手写 if 链去对齐，
// 而公开侧的守卫是"排除 draft"（`status != 'draft'`）—— 那是**黑名单**：任何没见过的词
// （以及 NULL）都不在"排除名单"里，于是**漏过去**。可触达的后果：一条
// `status='private'` 而 `is_public=true` 的行会被公开列出（`update_note` 只带
// `{"is_public":true}` 就能造出来）。今天没泄漏只是因为四处写点恰好对齐，**不是因为有约束**。
//
// 这里做两件事：读侧把黑名单翻成**白名单**（未知词/NULL 从"放行"变"拦截"），
// 写侧把词表收敛到**一处**（未知词 400 拒绝，绝不原样写库）。

/// 公开可见的 status 词。`published` 必须在里面：`0000_schema.sql` 的列缺省就是它，
/// 集成测夹具也按它 INSERT。它是 `public` 的**兼容别名**，不是第二个真值。
pub(crate) fn public_status_words() -> Vec<String> {
    vec!["public".to_string(), "published".to_string()]
}

/// Public articles are published roots, never editor shadow drafts.
pub(crate) fn public_condition() -> Condition {
    Condition::all().add(note::Column::IsPublic.eq(true))
        .add(note::Column::Status.is_in(public_status_words()))
        .add(note::Column::DraftOf.is_null())
}

/// 状态词的**唯一解析点**：只认这三个（`published` 归一成 `public`），未知词返回 `None`
/// —— 调用方必须拒绝，**不要**原样写库（原样写库正是"未知词留在库里且照旧公开"的来路）。
fn normalize_status_word(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "public" | "published" => Some("public"),
        "private" => Some("private"),
        "draft" => Some("draft"),
        _ => None,
    }
}

/// 这个词是不是"公开可见"那一档（`normalize_status_word` 之后只剩 `public` 一个，
/// 但这里照样认 `published`，好在归一之前也能问）。
fn status_is_publicish(word: &str) -> bool {
    matches!(word, "public" | "published")
}

#[derive(Deserialize)]
pub struct NoteQuery {
    pub category_id: Option<i32>,
    pub page: Option<u64>,
    // 前端传 camelCase `pageSize`（apis/NoteMethods.tsx），Times 归档页传 `page_size`（123 行）。
    // 逐字段 rename + alias 让两种拼写都成立——注意**不要**图省事写 rename_all = "camelCase"，
    // 那会把 category_id 一起改名，直接打断分类页/归档页的按分类过滤。
    #[serde(rename = "pageSize", alias = "page_size")]
    pub page_size: Option<u64>,
}

#[derive(Serialize)]
pub struct NoteDto {
    #[serde(rename = "noteKey")]
    pub id: i32,
    #[serde(rename = "key")]
    pub key: i32, 

    #[serde(rename = "noteTitle")]
    pub title: String,
    
    #[serde(rename = "noteContent")]
    pub content: String,
    #[serde(rename = "content")] 
    pub content_raw: String, 
    
    #[serde(rename = "description")]
    pub description: String,
    #[serde(rename = "cover")]
    pub cover: String,
    // 封面裁剪参数（焦点归一化坐标 + 额外缩放），null = 未设置
    #[serde(rename = "coverFocusX")]
    pub cover_focus_x: Option<f64>,
    #[serde(rename = "coverFocusY")]
    pub cover_focus_y: Option<f64>,
    #[serde(rename = "coverZoom")]
    pub cover_zoom: Option<f64>,
    // 置顶轮播专用裁剪参数，null = 未设置（前端渲染时回退跟随 cover_* 那套）
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,

    #[serde(rename = "createTime")]
    pub created_at: String,
    #[serde(rename = "updateTime")]
    pub updated_at: String,
    
    #[serde(rename = "isTop")]
    pub is_top: i32,
    pub status: String,
    // 编辑修改稿链接：Some(原文章 id) = 本行是那篇文章的自动保存修改稿（列表里带「修改稿」标记）
    #[serde(rename = "draftOf")]
    pub draft_of: Option<i32>,

    // Corrected fields for frontend compatibility
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>, 
    #[serde(rename = "categoryTitle")]
    pub category_title: Option<String>,
    
    pub is_public: bool,
    #[serde(rename = "noteTags")]
    pub tags: String,

    // ── 卡片上的四个数（20260930，20261003 补讨论数；见 `note_stats::counts_for`）──
    // **`None` 时整个键不出现在 JSON 里**（不是 `null`）：这是刻意的，因为只有列表接口
    // 会挂数，详情接口不挂——`get_article_detail`（看板娘读文章详情）那条路因此**一个
    // 字节都没变**，跨仓契约不受影响。
    //
    // `None` = 这一路没有（或取不到）计数 ⇒ 卡片不渲染那一排；`Some(0)` = 挂了数且真的是
    // 0 ⇒ 显示 0。**"读不到"与"真的是 0"必须分得开**，否则统计接口一挂，站上每篇文章
    // 都会谎报"0 阅读"。
    // ── 谁发的（20261001，见 `attach_authors`）──────────────────────────────
    // **不留 id**（`skip`）：uid 是内部编号，公开接口没有理由印出去；它只在本模块内
    // 走一趟（`map_note` 填 ⇒ `attach_authors` 读），用来把 user 行批量取回来。
    #[serde(skip)]
    pub author_id: Option<i32>,
    // `None` = 这一路没解析（或解析失败）⇒ **键不出现**，前端回退站点级署名
    // （与改造前逐字相同）。`Some` = 已经判定了是谁 ⇒ 卡片按它渲染。
    // 「取不到」与「真的是站点主人发的」必须分得开：后者是事实，前者是没查着。
    #[serde(rename = "authorName", skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(rename = "authorAvatar", skip_serializing_if = "Option::is_none")]
    pub author_avatar: Option<String>,

    #[serde(rename = "views", skip_serializing_if = "Option::is_none")]
    pub views: Option<i64>,
    #[serde(rename = "likes", skip_serializing_if = "Option::is_none")]
    pub likes: Option<i64>,
    #[serde(rename = "favorites", skip_serializing_if = "Option::is_none")]
    pub favorites: Option<i64>,
    /// 讨论数（20261003）。**与上面三个数同一条纪律**（`None` ⇒ 键不出现 ⇒ 卡片不渲染
    /// 这一格）。数量口径 = 公开讨论区看得见的那些（`approved = 1 AND is_deleted = 0`，
    /// 见 `note_stats::comments_of`）——点一下卡片进去数得出来的就是这个数。
    #[serde(rename = "comments", skip_serializing_if = "Option::is_none")]
    pub comments: Option<i64>,
}

/// 封面裁剪参数兜底：焦点归一化到 0..1，缩放夹在 1..4；NaN/inf 等脏值退回默认。
fn clamp01(v: f64) -> f64 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.5 }
}

fn clamp_zoom(v: f64) -> f64 {
    if v.is_finite() { v.clamp(1.0, 4.0) } else { 1.0 }
}

/// `cat` 是**已经取出来的**（id, 名字）二元组，不是 `category::Model`。
///
/// 20261018 起刻意收窄：列表查询只 select 分类的这两列（见 `CategoryPartial`），
/// 硬要收成 `Model` 就得给 `introduce`/`path_name`/`icon`/`color` 编一堆 `None` 填进去
/// —— 而"哪天有人在 `map_note` 里读了 `cat.introduce`，它恒为 None 且没有任何东西会红"
/// 正是本仓最忌讳的那类静默失效。收成二元组之后，**没取的东西在类型上就不存在**。
fn map_note(n: note::Model, cat: Option<(i32, String)>) -> NoteDto {
    let (cat_id, cat_name) = match cat {
        Some((id, name)) => (Some(id), Some(name)),
        None => (None, None),
    };

    NoteDto {
        id: n.id,
        key: n.id,
        title: n.title,
        content: n.content.clone(),
        content_raw: n.content,
        description: n.description.unwrap_or_default(),
        cover: n.cover.unwrap_or_default(),
        cover_focus_x: n.cover_focus_x,
        cover_focus_y: n.cover_focus_y,
        cover_zoom: n.cover_zoom,
        carousel_focus_x: n.carousel_focus_x,
        carousel_focus_y: n.carousel_focus_y,
        carousel_zoom: n.carousel_zoom,
        created_at: n.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: n.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        is_top: n.is_top.unwrap_or(0),
        status: n.status.unwrap_or("published".to_string()),
        draft_of: n.draft_of,
        category_id: cat_id,
        category_title: cat_name,
        is_public: n.is_public,
        // ⚠️ **恒空串**（20261018）：标签的 id 串从 `note_tag` 关联表重建，由
        // `note_tags::attach_tags` 在 handler 里挂上去 —— 与 `attach_authors` /
        // `attach_stats` 同一个分工（`map_note` 是纯函数，不查库）。
        // 这一行**不是**"忘了填"：`note.tags` 那列仍在写（soak 期两处同源，见
        // `routes/note_tags.rs` 头注），但读路径已经不再看它 —— 所以这里刻意不读 `n.tags`，
        // 免得"某一篇的列陈旧了"与"某一篇真的没标签"在连线上长得一样。
        tags: String::new(),
        // 作者只搬 id 过来，名字/头像由 `attach_authors` 批量解析（`map_note` 是纯函数，
        // 不查库——与 `attach_stats` 同一个分工）。
        author_id: n.user_id,
        author_name: None,
        author_avatar: None,
        // 三个数一律留空：挂数是**列表接口**的事（`attach_stats`），详情接口不挂。
        // 想给详情接口也带数请先读 `note_stats` 模块头注——那条路被看板娘频繁读取。
        views: None,
        likes: None,
        favorites: None,
        comments: None,
    }
}

// ── 列表端点的 SELECT 形状（20261018）：**没有 `content` 列** ────────────────────────
//
// 三个列表端点（`list_public_notes` / `list_all_notes` / `get_top_notes`）此前走
// `find_also_related` / `find_with_related` —— 那是 `SELECT note.*`，**整篇正文一起读回来**，
// 而紧接着 `map_note_summary` 的第一件事就是把 `content` / `content_raw` 置空
// （`description` 21/21 全非空，卡片摘要本来就不需要正文）。Times 归档页一次
// `page_size=999` ⇒ 一次读回**全站正文**。这是本站唯一一处**随语料线性增长**的读放大。
//
// 用 partial model 而不是"记得别 select content"：正文列**根本不在 select 列表里**，
// 没有纪律要守。两个方向都是编译强制 —— 给 `note::Entity` 加一列会让 `into_model()`
// 编译不过（新列没处放），给 `NoteDto` 加字段会让 `map_note` 编译不过。
#[derive(Debug, Clone, DerivePartialModel)]
#[sea_orm(entity = "note::Entity", from_query_result)]
pub struct NoteSummary {
    pub id: i32,
    pub title: String,
    pub description: Option<String>,
    pub cover: Option<String>,
    pub cover_focus_x: Option<f64>,
    pub cover_focus_y: Option<f64>,
    pub cover_zoom: Option<f64>,
    pub carousel_focus_x: Option<f64>,
    pub carousel_focus_y: Option<f64>,
    pub carousel_zoom: Option<f64>,
    pub is_top: Option<i32>,
    pub status: Option<String>,
    pub draft_of: Option<i32>,
    pub user_id: Option<i32>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
    pub is_public: bool,
    pub category_id: Option<i32>,
}

impl NoteSummary {
    /// 补齐成 `note::Model`，好让 `map_note` / `map_note_summary` 仍是**唯一**的字段映射器
    /// （否则"摘要行怎么变成 DTO"就有了第二份实现）。
    ///
    /// `content` 恒空 —— 这不是"忘了填"，是「列表查询不读正文」这条事实在类型上的落地。
    fn into_model(self) -> note::Model {
        note::Model {
            id: self.id,
            title: self.title,
            content: String::new(),
            description: self.description,
            cover: self.cover,
            cover_focus_x: self.cover_focus_x,
            cover_focus_y: self.cover_focus_y,
            cover_zoom: self.cover_zoom,
            carousel_focus_x: self.carousel_focus_x,
            carousel_focus_y: self.carousel_focus_y,
            carousel_zoom: self.carousel_zoom,
            is_top: self.is_top,
            status: self.status,
            draft_of: self.draft_of,
            user_id: self.user_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            is_public: self.is_public,
            // `tags` 那一列**不在 `NoteSummary` 的列里**（20261018）：标签的 id 串改由
            // `note_tag` 关联表重建（`note_tags::attach_tags`），列表查询因此连这一列也不读。
            // 填 `None` 不是"读到了空" —— `map_note` 本来就不看它（见那边的注释）。
            tags: None,
            category_id: self.category_id,
        }
    }
}

/// 本页用到的分类名（键 = 分类 id）。
///
/// ⚠️ **分类走单独一次查询，不跟着 LEFT JOIN 一起取**（20261018 现场修正）。
/// 原来那版是 `find_also_related(category::Entity).into_partial_model::<NoteSummary, CategoryPartial>()`
/// —— **它不工作**：`SelectTwo::into_partial_model` 的第一步是 `QuerySelect::select_only(self)`，
/// 而 `select_only` 会 `clear_selects()`；`SelectTwoModel` 读行时用的是 `from_query_result(res, "A_")`
/// / `"B_"`，那两个前缀**正是 `find_also_related` 写进 select 列表的别名**（`apply_alias`），
/// 被 `select_only` 清掉之后就再也对不上 ⇒ 每一行都 `Err(ColumnNotFound)`。
/// 而三个调用点都是 `.unwrap_or(vec![])` ⇒ **公网文章列表静默变空**，没有任何东西报错。
/// `Select<Entity>`（单实体）那条 `into_partial_model` 没这个问题（它按空前缀读）。
///
/// 失败 → 空表：卡片那一栏留空，列表本身照常返回（与 `attach_stats` / `attach_authors` 同一取向）。
async fn category_names(
    db: &sea_orm::DatabaseConnection,
    ids: impl Iterator<Item = i32>,
) -> HashMap<i32, String> {
    let ids: Vec<i32> = ids.collect::<std::collections::HashSet<i32>>().into_iter().collect();
    if ids.is_empty() {
        return HashMap::new();
    }
    match category::Entity::find()
        .select_only()
        .column(category::Column::Id)
        .column(category::Column::Name)
        .filter(category::Column::Id.is_in(ids))
        .into_tuple::<(i32, String)>()
        .all(db)
        .await
    {
        Ok(v) => v.into_iter().collect(),
        Err(e) => {
            tracing::warn!("[notes] 分类查询失败，本页不挂分类名: {e}");
            HashMap::new()
        }
    }
}

/// `.unwrap_or(vec![])` 会把**查询出错**与**查询结果本来为空**合成同一个结果。
///
/// 20261018 的现场就是被这一句吃掉的：`SelectTwo` 那版 `into_partial_model` 每一行都
/// 映射失败 ⇒ 公网文章列表**静默变空**，接口照旧 200、日志一个字都没有（`fetch_page`
/// 的错误在 `unwrap_or` 里蒸发）。
/// 列表端点一律走这里：**照旧返回空列表**（列表本身不能 500），但**留一行 WARN** ——
/// "空"这件事至少要有迹可循。
fn or_empty_warn<T>(r: Result<Vec<T>, sea_orm::DbErr>, what: &str) -> Vec<T> {
    match r {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("[notes] {what} 查询失败，已降级成空列表（接口仍 200）: {e}");
            Vec::new()
        }
    }
}

/// 把 `NoteSummary` 那一行变成 DTO 的**唯一**入口（三个列表端点共用）。
///
/// 分类那半：`NoteSummary.category_id` 是 `note` 自己的列，`cats` 是 `category_names`
/// 查回来的名字。**两边都对得上才给 `Some((id, name))`** —— 查不到分类行（分类被删、
/// note 还指着它）时 `map_note` 收到的仍是 `None`，与 LEFT JOIN 出 `NULL` 的旧行为逐字一致。
fn summary_to_dto(r: NoteSummary, cats: &HashMap<i32, String>) -> NoteDto {
    let cat = r.category_id.and_then(|id| cats.get(&id).map(|n| (id, n.clone())));
    map_note_summary(r.into_model(), cat)
}

pub async fn list_public_notes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<NoteQuery>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();

    if let Some(cat_id) = query.category_id {
        condition = condition.add(note::Column::CategoryId.eq(cat_id));
    }

    // STRICT FILTER FOR PUBLIC API
    condition = condition.add(public_condition());

    // PAGINATION LOGIC
    // page.max(1)：page=0 时 `page - 1` 会 u64 下溢（release 环绕成 u64::MAX → 静默空页）。
    // page_size 夹到 1..1000：0 会让 sea-orm paginator panic（`page_size should not be zero`，
    // 公网无鉴权接口可被任意触发，logs/rust.log 有实证）；上限留 1000 是因为 Times 归档页
    // 用 page_size=999 一次拉全量（夹到常见分页值会让归档静默截断）。
    let page = query.page.unwrap_or(1).max(1);
    let per_page = query.page_size.unwrap_or(6).clamp(1, 1000) as u64;

    let notes = note::Entity::find()
        .filter(condition)
        .order_by_desc(note::Column::CreatedAt)
        // `into_partial_model` 把 select 列表换成 `NoteSummary` 的列 —— 正文不在其中
        // （见 `NoteSummary` 头注）。⚠️ **只用单实体这一版**：`SelectTwo` 那版不工作，
        // 理由见 `category_names` 头注（分类因此走单独一次查询）。
        .into_partial_model::<NoteSummary>()
        .paginate(&state.db, per_page)
        .fetch_page(page - 1)
        .await;
    let notes = or_empty_warn(notes, "公开文章列表");

    let cats = category_names(&state.db, notes.iter().filter_map(|r| r.category_id)).await;
    let mut dtos: Vec<NoteDto> = notes.into_iter().map(|r| summary_to_dto(r, &cats)).collect();
    attach_tags(&state.db, &mut dtos).await;
    attach_stats(&state.db, &mut dtos).await;
    attach_authors(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

// ADMIN FUNCTION: List ALL notes
pub async fn list_all_notes(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    // No filters on public/status
    // 但排除「编辑修改稿」（draft_of 非空）：它是编辑某篇文章时自动保存落下的影子行，
    // 混进「全部文章」会与它正在被编辑的那篇同标题重复一行。草稿箱 tab（search_all_notes
    // 带 status=draft）不加这个过滤，修改稿本该在那里出现。
    let notes = note::Entity::find()
        .filter(note::Column::DraftOf.is_null())
        .order_by_desc(note::Column::CreatedAt)
        // 正文列不进 select 列表（见 `NoteSummary` 头注）；分类走 `category_names`
        // 单独一次查询，理由见那个函数的头注（`SelectTwo` 那版 `into_partial_model` 不工作）。
        .into_partial_model::<NoteSummary>()
        .all(&state.db)
        .await;
    let notes = or_empty_warn(notes, "全部文章列表");

    let cats = category_names(&state.db, notes.iter().filter_map(|r| r.category_id)).await;
    let mut dtos: Vec<NoteDto> = notes.into_iter().map(|r| summary_to_dto(r, &cats)).collect();
    attach_tags(&state.db, &mut dtos).await;
    attach_authors(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct SearchRequest {
    pub keyword: Option<String>,
    /// 后台列表的「文章标题」筛选。**这个字段此前根本不存在**，而结构体又没开
    /// `deny_unknown_fields` → 前端表单里的「文章标题」一直是静默空操作（填了也没用，
    /// 也不报错）。见 `search_all_notes`。
    pub title: Option<String>,
    pub categories: Option<String>,
    pub status: Option<String>,
    // NEW FILTERS ADDED
    pub is_top: Option<i32>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// 后台列表「公开文章」页签（20261006 用户第 5 条）。`true` = 只要**站上真能读到**的那些。
    ///
    /// 口径不新造，用既有的那一份（见 `search_all_notes` 里的落地处）。
    pub only_public: Option<bool>,
}

// ── 标签字典（20261018 改道）───────────────────────────────────────────────
//
// 这里原来有 `load_tag_names` / `merge_tag_name_dict` / `note_tag_names` 三件：
// 把两级标签读成一张 `id → 名字` 的字典，再把 `note.tags` 那个 id 串过一遍字典翻成名字。
// 「撞号取一级」那条规则就是在这张扁平字典上打的补丁（两级 id 命名空间不隔离，
// 一个数字可能两张表都有）。
//
// 关联表落地之后这三件**整体退休**：`note_tag` 的一行自己知道指向哪张表，
// 「这个 id 是哪一级」不再是需要猜的事 —— 读路径改为
// `note_tags::load_note_tags`（一次取回整批的 `(id, 名字)`，按 `seq` 排好），
// 撞号在**写入侧**就已经不可能（`replace_note_tags` 按列归属，不按数字大小）。

/// 关键词是否命中这篇文章：标题 / 正文 / **标签名字**。`kw` 必须已小写化。
///
/// `pub(crate)`：20261006 聚合搜索的文章那一栏走**同一套命中判定**（不能各写一份，
/// 否则"首页搜得到的文章"与"分类页搜得到的"会开始漂）。
pub(crate) fn note_hits_keyword(n: &note::Model, kw: &str, tag_names: &[String]) -> bool {
    n.title.to_lowercase().contains(kw)
        || n.content.to_lowercase().contains(kw)
        || tag_names.iter().any(|t| t.to_lowercase().contains(kw))
}

// ── 切词 / 命中 / 打分：实现已搬到 `search_core`（20261006） ────────────────────────
//
// `split_terms` / `script_runs` / `keyword_given` 三件**原样**搬进了 `crate::search_core`，
// 连同它们的单测。搬家的理由只有一个：聚合搜索（`routes/search.rs`）是第二个消费方，
// 「怎么切词」这条规则不能有第二份 —— 本仓在这上面栽过太多次（同一套规则抄两份、后来各漂各的）。
// 这里保留的几个 `note_*` 助手是**转调**：权重、判定、大小写口径逐字不变，
// 所以文章那一栏的结果与改动前**逐条一致**。
//
// ⚠️ `search_notes` 的 handler 本身（下面那个函数，含它的分档循环）**一个字没改**：
// 它同时服务 agent 的 `search_notes` 工具，不趟这摊水。

/// 命中的 term 个数（0 = 不命中；`terms.len()` = 全中）。**档位即这个词数**——
/// 前台按「全中优先、无全中才降级到部分命中」分档（见 search_notes）。
fn term_hit_count(n: &note::Model, terms: &[String], tag_names: &[String]) -> usize {
    count_terms(terms, |t| note_hits_keyword(n, t, tag_names))
}

/// 多词命中：任一 term 命中即算（后台筛选用——召回优先，后台列表自己排序）。
fn note_hits_terms(n: &note::Model, terms: &[String], tag_names: &[String]) -> bool {
    term_hit_count(n, terms, tag_names) > 0
}

/// 多词打分（20260920）：每个 term 各按同一套权重计分后**求和**（档内排序用）。
///
/// 权重（标题命中 +100 / 标签命中 +30 / 正文出现次数、上限 10，防长文堆词刷分）与
/// 大小写口径住在 `search_core::score_term`——聚合搜索共用同一套，这里只把文章的
/// 标题/标签/正文喂进去。
///
/// `tag_names` 是该文标签的**名字**（由 `note_tag_names` 过字典得到）。旧版这里直接拿
/// `note.tags` 的 id 串 `contains(kw)`：搜标签名永远 0 分，搜纯数字（"1"）却被
/// id 1/10/21 全部加成 +30 —— 这就是「按相关度排序」里那部分假信号。
///
/// 不再额外加"多词全中"奖励——命中词数由调用方的**档位**承担（全中优先），
/// 档内只比"每个词命中的位置有多好"。单词查询时与旧分数完全一致。
fn search_score_terms(note: &note::Model, terms: &[String], tag_names: &[String]) -> i64 {
    score_term_sum(terms, Some(&note.title), tag_names, &note.content)
}

/// 文章搜索的**关键词 SQL 预筛**（标题 / 正文 / 标签名）。`search_notes`、`search_all_notes`
/// 与聚合搜索（`routes/search.rs`）**三处共用这一份** —— 这套规则抄三遍就是三份会各自漂的
/// 实现，而漂的后果是"首页搜得到、聚合搜索搜不到"这种没人会去比对的差异。
///
/// 预筛**只保证超集**（`search_core::keyword_prefilter` 头注）：档位、权重、顺序全留在内存
/// 那一遍，一个字没动。
///
/// 返回 `Ok(None)` = 没有可用 term（调用方**不许**拿它拼一个恒真条件）；
/// `Err` = 标签那一维查不到 ⇒ **整个预筛都不能用** —— 少收一行是**静默的错误答案**，
/// 调用方必须回退全量加载（并留一行 WARN 让"这轮为什么慢"有迹可循）。
///
/// 为什么标签要单独取一次：命中判定是 标题 / 正文 / **标签名字**，前两维在 `note` 表上，
/// 第三维住在 `note_tag` 关联表里 —— SQL 主查询碰不到，只能先把"标签名命中"的文章 id
/// 取回来 OR 进去。这正是关联表落地解锁的能力（此前标签是 id 串，SQL 侧搜标签名恒空、
/// 搜数字恒假命中）。
pub(crate) async fn note_keyword_prefilter(
    db: &DatabaseConnection,
    terms: &[String],
) -> Result<Option<Condition>, sea_orm::DbErr> {
    // 列表达式必须带表名限定（`note.title` 而不是裸 `title`）：主查询是单表，但预筛条件
    // 会与别处拼在一起，裸列名在将来加 join 时会歧义。
    let cols = [
        SimpleExpr::from(Expr::col((note::Entity, note::Column::Title))),
        SimpleExpr::from(Expr::col((note::Entity, note::Column::Content))),
    ];
    let Some(mut pre) = keyword_prefilter(&cols, terms) else {
        return Ok(None);
    };
    let tag_ids = note_tags::note_ids_with_tag_name_hits(db, terms).await?;
    if !tag_ids.is_empty() {
        pre = pre.add(Expr::col((note::Entity, note::Column::Id)).is_in(tag_ids));
    }
    Ok(Some(pre))
}

pub async fn search_notes(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();

    // PUBLIC SAFEGUARDS
    condition = condition.add(public_condition());

    if let Some(ref t) = payload.title {
        let t = t.trim();
        if !t.is_empty() {
            condition = condition.add(note::Column::Title.contains(t));
        }
    }

    // ── 关键词：先切词，再下 SQL 预筛（20261018）──────────────────────────────
    // 预筛**只保证超集**（`search_core::keyword_prefilter` 头注），真判定与打分仍在
    // 内存里那一遍（档位、权重、顺序一个字没动）。
    //
    // 为什么以前完全不下 SQL：那时"标签"是 `note.tags` 那一列**逗号分隔的 id 串**，
    // SQL 只能对 id 串 LIKE —— 搜标签名永远 0 命中、搜纯数字（`1`）假命中所有含
    // id 1/10/21 的文章。关联表落地之后标签名在 `tag_one`/`tag_two` 里，**这一维终于
    // 能在 SQL 里判了**（先取回命中的文章 id 再 OR 进主查询），预筛因此是完整的。
    let terms = payload
        .keyword
        .as_deref()
        .map(split_terms)
        .unwrap_or_default();
    // 给了关键词却切不出任何可用 term（`第1章` / 纯标点）→ 回空，**不要**落到下面的
    // "无关键词 → 返回整表"（那会把"站内没有这种东西"答成全站文章列表，见 keyword_given）。
    // ⚠️ 这条短路从"查询之后"挪到了"查询之前"（20261018）：结论一样，但省一次全量查询。
    if keyword_given(payload.keyword.as_deref()) && terms.is_empty() {
        return Json(ApiResponse::success(vec![]));
    }
    match note_keyword_prefilter(&state.db, &terms).await {
        Ok(Some(pre)) => condition = condition.add(pre),
        // 没有可用 term（此时上面的短路已经放过去了 ⇒ 真的没给关键词）⇒ 不加条件。
        Ok(None) => {}
        // ⚠️ 标签那一维**读不到就不许用预筛**：少收一行是**静默的错误答案**，
        // 多收几行只是慢一点。回退到全量加载 + 内存判定，并留一行 WARN。
        Err(e) => tracing::warn!("[search_notes] 关键词预筛失败，本轮回退到全量加载: {e}"),
    }

     if let Some(ref cat_name) = payload.categories {
        let cat_model = category::Entity::find()
            .filter(category::Column::Name.eq(cat_name))
            .one(&state.db)
            .await
            .unwrap_or(None);
            
        if let Some(c) = cat_model {
            condition = condition.add(note::Column::CategoryId.eq(c.id));
        } else {
             return Json(ApiResponse::success(vec![]));
        }
    }
    
    // Public search likely doesn't need detailed time/top status filters, but no harm logic-wise. 
    // They are omitted here for simplicity and focus on keyword search.

    // 分类/标题筛选不需要正文；旧实现全量读取 content 后又清空，浪费传输与内存。
    if terms.is_empty() {
        let rows = note::Entity::find().filter(condition)
            .order_by_asc(note::Column::Id)
            .into_partial_model::<NoteSummary>().all(&state.db).await;
        let rows = or_empty_warn(rows, "公开文章筛选");
        let cats = category_names(&state.db, rows.iter().filter_map(|r| r.category_id)).await;
        let mut dtos: Vec<NoteDto> = rows.into_iter().map(|r| summary_to_dto(r, &cats)).collect();
        attach_tags(&state.db, &mut dtos).await;
        attach_stats(&state.db, &mut dtos).await;
        attach_authors(&state.db, &mut dtos).await;
        return Json(ApiResponse::success(dtos));
    }

    let notes = note::Entity::find()
        .filter(condition)
        // ⚠️ **显式钉住行序**（20261018）。此前这里没有 ORDER BY，返回顺序是**存储顺序**
        // （实测主键升序）—— 那不是一个契约，只是当时查询计划的产物。加预筛之后计划会变
        // （顺序扫 → 位图索引扫），而下面的相关度排序对**同分**的行是稳定的（`sort_by` 稳定，
        // 同分保持入参顺序）⇒ 行序一变，"同分的那几条谁在前"就跟着变。
        // 这里把它钉成 id 升序 = **与今天实测的行为一致**，只是从"碰巧"变成"确定"。
        .order_by_asc(note::Column::Id)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    // 关键词命中筛选 + 相关度排序（20260912 引入排序 / 20260919 把命中判定也收进来）。
    //
    // 排序的来由：本查询此前**无 ORDER BY**，返回顺序即存储顺序（实测主键升序）——于是搜索
    // 「架构」的第一条是《Git从入门到入土》（它只在正文表格里顺带出现过一次该词），而真正讲
    // 架构的那篇紧随其后。agent 侧 search_notes 取候选[0] 时因此读错文章（9/8 跑题事故的
    // 供给端根因）。同分按 created_at 倒序（新的在前，与 list_public_notes 一致），
    // 再同分落到上面那条 `ORDER BY id`。
    //
    // 命中判定为什么还在内存里：SQL 那一层只是**预筛**（超集），真判定要连标签名一起看、
    // 还要算档位与权重（一遍遍历同时完成判定与打分，正文不必扫两次）。
    // 注：本端点同时服务博客前端搜索（NoteMethods.tsx）与 agent 的 search_notes，
    // 改动影响结果集（数字关键词不再假命中、标签名开始能搜到）与顺序，不影响 DTO。
    // 切成 terms 后逐词判定（20260920，见 split_terms：整串子串匹配对多词查询是假否定）；
    // 空关键词（缺省/全空白）走原来的整表返回。
    // 命中分档（20260920）：**全中优先**——多词查询先只留"每个词都命中"的文章（精度优先，
    // 与切词前的严格度同源，agent 不会因为降级候选读到跑题文章）；一篇全中的都没有时，
    // 才降级用"部分命中"（召回兜底：搜 "Docker 部署博客" 不该是一片空白）。
    // 档内按各词分项求和（+ created_at 兜底）排序；单词查询只有一档，等价于旧行为。
    let notes = if terms.is_empty() {
        notes
    } else {
        // 这一批文章的标签名一次取回（20261018 起走 `note_tag`，见 `note_tags` 模块头注）。
        // **不再**是"先读全站字典、再拿 id 串去查"：关联表自己带归属，读的也就是这一批。
        let ids: Vec<i32> = notes.iter().map(|r| r.0.id).collect();
        let tag_map = note_tags::load_note_tags(&state.db, &ids).await;
        let mut all: Vec<(usize, i64, (note::Model, Vec<category::Model>))> = Vec::new();
        let mut part: Vec<(usize, i64, (note::Model, Vec<category::Model>))> = Vec::new();
        for r in notes {
            let names: Vec<String> = tag_map
                .get(&r.0.id)
                .map(|v| v.iter().map(|t| t.name.clone()).collect())
                .unwrap_or_default();
            let hit = term_hit_count(&r.0, &terms, &names);
            if hit == 0 {
                continue;
            }
            let row = (hit, search_score_terms(&r.0, &terms, &names), r);
            if hit == terms.len() {
                all.push(row);
            } else {
                part.push(row);
            }
        }
        let mut scored = if all.is_empty() { part } else { all };
        scored.sort_by(|a, b| {
            let (ha, sa, (na, _)) = a;
            let (hb, sb, (nb, _)) = b;
            hb.cmp(ha)
                .then_with(|| sb.cmp(sa))
                .then_with(|| nb.created_at.cmp(&na.created_at))
        });
        scored.into_iter().map(|(_, _, r)| r).collect()
    };

    let mut dtos: Vec<NoteDto> = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next().map(|c| (c.id, c.name)))
    }).collect();
    attach_tags(&state.db, &mut dtos).await;
    attach_stats(&state.db, &mut dtos).await;
    attach_authors(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

pub async fn search_all_notes(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();

    // NO PUBLIC SAFEGUARDS (Admin Route)

    // `title` 是后台列表「文章标题」筛选的落地——这个字段以前压根不在 `SearchRequest` 里，
    // 前端填了也白填（结构体没开 `deny_unknown_fields`，所以是静默空操作）。
    // 关键词这一路 20261018 起也下 SQL 了（预筛，见下），判定仍统一在内存里做一遍。
    if let Some(ref t) = payload.title {
        let t = t.trim();
        if !t.is_empty() {
            condition = condition.add(note::Column::Title.contains(t));
        }
    }

    if let Some(ref cat_name) = payload.categories {
        let cat_model = category::Entity::find()
            .filter(category::Column::Name.eq(cat_name))
            .one(&state.db)
            .await
            .unwrap_or(None);
            
        if let Some(c) = cat_model {
            condition = condition.add(note::Column::CategoryId.eq(c.id));
        } else {
             return Json(ApiResponse::success(vec![]));
        }
    }
    
    if let Some(ref s) = payload.status {
        // Allow filtering by specific status
         condition = condition.add(note::Column::Status.eq(s));
    }

    // 「公开文章」页签（20261006 用户第 5 条）：把 `/notes/search` 收窄成**站上真能读到的
    // 那些**。三条判据各有出处，别各自发明：
    //   ① `is_public = true` + ② `status != 'draft'` —— 与 `list_public_notes`（:172-173）
    //      一字不差，那才是 nginx 后面访客看得见的集合；
    //   ③ `draft_of IS NULL` —— 与 `list_all_notes`（:212）一致：`shot` 出来的编辑修改稿是
    //      影子行，不排掉的话「公开 ⊂ 全部文章」不成立（同一篇会在两个页签里各出现一次）。
    // ⚠️ ② 对 `status IS NULL` 的老行是 **NULL 判定**（SQL 三值逻辑），那些行**不进**本页签。
    // 这是**有意的**：它们也确实进不了 `list_public_notes`（同一条 `ne` 谓词），页面跟着后端的
    // 真实行为走。前端曾有一份 `noteVisibility.ts` 把 NULL 当公开，那是前端自己臆断的口径，
    // 已随绿标一起删除。
    if let Some(true) = payload.only_public {
        condition = condition.add(public_condition());
    }


    // NEW FILTERS
    if let Some(top) = payload.is_top {
        condition = condition.add(note::Column::IsTop.eq(top));
    }
    
    if let Some(ref start) = payload.start_date {
         if let Ok(date) = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d") {
             let datetime = date.and_hms_opt(0, 0, 0).unwrap();
             condition = condition.add(note::Column::CreatedAt.gte(datetime));
         }
    }
    
    if let Some(ref end) = payload.end_date {
         if let Ok(date) = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d") {
             let datetime = date.and_hms_opt(23, 59, 59).unwrap();
             condition = condition.add(note::Column::CreatedAt.lte(datetime));
         }
    }

    // ── 关键词：先切词，再下 SQL 预筛（20261018，与 `search_notes` 同一套）──────────
    // 判定与前台同样先切词（20260920，见 split_terms）——否则后台搜"OBC 固件"是空、
    // 前台却有结果，两边对不上。
    let terms = payload
        .keyword
        .as_deref()
        .map(split_terms)
        .unwrap_or_default();
    // 同 search_notes：给了关键词却切不出 term → 空结果（后台"没有匹配的文章"是正确答复）。
    // ⚠️ 短路挪到查询之前（20261018）：结论一样，省一次全量查询。
    if keyword_given(payload.keyword.as_deref()) && terms.is_empty() {
        return Json(ApiResponse::success(vec![]));
    }
    // 预筛**只保证超集**（`search_core::keyword_prefilter` 头注），真判定仍在下面内存里那一遍。
    // 后台这一路的可见性收窄全靠 `only_public` 那个可选条件，预筛不许把它顶掉 —— 它是
    // `condition.add(...)`，与既有条件**与**在一起，收窄关系不变。
    match note_keyword_prefilter(&state.db, &terms).await {
        Ok(Some(pre)) => condition = condition.add(pre),
        Ok(None) => {}
        // 标签那一维读不到就不许用预筛（少收一行是静默的错误答案），回退全量加载。
        Err(e) => {
            tracing::warn!("[search_all_notes] 关键词预筛失败，本轮回退到全量加载: {e}")
        }
    }

    let notes = note::Entity::find()
        .filter(condition)
        // 后台列表要有确定顺序：本查询此前**无 ORDER BY**（返回顺序即存储顺序），而前端把
        // 它整份装进 antd Table 做本地分页 —— 顺序不稳意味着同一篇文章可能在第 2 页和第 3 页
        // 各出现一次、另一篇谁也没见过。与 `list_all_notes` 保持同序（新的在前）。
        .order_by_desc(note::Column::CreatedAt)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    // 关键词命中：标题 / 正文 / 标签**名字**（标签名从 `note_tag` 关联表取）。后台列表不按
    // 相关度排序（它有自己的列排序/时间序），所以这里只做过滤，不打分。
    let notes = if terms.is_empty() {
        notes
    } else {
        let ids: Vec<i32> = notes.iter().map(|(n, _)| n.id).collect();
        let tag_map = note_tags::load_note_tags(&state.db, &ids).await;
        notes
            .into_iter()
            .filter(|(n, _)| {
                let names: Vec<String> = tag_map
                    .get(&n.id)
                    .map(|v| v.iter().map(|t| t.name.clone()).collect())
                    .unwrap_or_default();
                note_hits_terms(n, &terms, &names)
            })
            .collect()
    };

    let mut dtos: Vec<NoteDto> = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next().map(|c| (c.id, c.name)))
    }).collect();
    // 标签照挂（20261018）：`map_note` 不再从 `note.tags` 那列取 id 串，改由关联表重建 ——
    // **每一路都要显式挂**，而"某条路径忘了挂"的症状是"这篇文章的标签在列表里显示成空"。
    // 与署名同族，见下面那段。
    attach_tags(&state.db, &mut dtos).await;
    // 署名照挂（20261001）：本函数是后台列表的搜索入口，**与 `list_all_notes` 同一族**。
    // 这里不挂的话，同一篇文章在后台列表里署名是站点级、在公开首页上却是作者本人——
    // 而"某条路径忘了挂"正是这个 bug 的复发形状（见 `attach_authors` 头注）。
    // 统计（`attach_stats`）**刻意不挂**：后台列表不显示三个数，见 `NoteDto` 里那段。
    attach_authors(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertNoteRequest {
    #[serde(rename = "noteTitle")]
    pub title: Option<String>, 
    #[serde(rename = "noteContent")]
    pub content: Option<String>,
    
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>, 
    
    #[serde(rename = "isTop")]
    pub is_top: Option<i32>,
    pub status: Option<String>,
    pub description: Option<String>,
    pub cover: Option<String>,
    // 封面裁剪参数：不传则不改动该列（编辑旧文章不会误清参数）
    #[serde(rename = "coverFocusX")]
    pub cover_focus_x: Option<f64>,
    #[serde(rename = "coverFocusY")]
    pub cover_focus_y: Option<f64>,
    #[serde(rename = "coverZoom")]
    pub cover_zoom: Option<f64>,
    // 置顶轮播专用裁剪参数：同样不传则不改动该列；三列必须同进同出（渲染端按三元组原子判定，
    // 只写其中一列会让整组失效 ⇒ 写入静默不生效）
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,

    #[serde(rename = "noteTags")]
    pub tags: Option<String>,
    
    pub is_public: Option<bool>, 
}

pub async fn get_top_notes(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();
    condition = condition.add(note::Column::IsTop.eq(1));
    condition = condition.add(public_condition());

    let notes = note::Entity::find()
        .filter(condition)
        .into_partial_model::<NoteSummary>()
        .all(&state.db)
        .await;
    let notes = or_empty_warn(notes, "置顶文章列表");

    let cats = category_names(&state.db, notes.iter().filter_map(|r| r.category_id)).await;
    let mut dtos: Vec<NoteDto> = notes.into_iter().map(|r| summary_to_dto(r, &cats)).collect();
    attach_tags(&state.db, &mut dtos).await;
    attach_stats(&state.db, &mut dtos).await;
    attach_authors(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

pub async fn create_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<UpsertNoteRequest>,
) -> Json<ApiResponse<String>> {
    let title = payload.title.unwrap_or_else(|| "Untitled".to_string());
    let content = payload.content.unwrap_or_default();
    // 发布者 = 这一刻的操作者（auth_uid = 验签 + 查库 + 冻结/收回判据，与河灯同一处出口）。
    // 解不出来就留 NULL（= 未记录）⇒ 展示端回退站点级署名，不编一个人名上去。
    let author = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok();
    
    // 状态词与可见性：走**唯一解析点**（`normalize_status_word`）。
    //
    // 两处变化（20261018）：① 未知词不再**原样写库**（那正是"库里出现没见过的词、
    // 而它照旧被公开列出"的来路），改为如实报错；② 缺省词从 `published` 改成 `public`
    // —— 库里只该有一个"公开"词，`published` 只是兼容别名（老列缺省 + 集成测夹具）。
    let status_word = match payload.status.as_deref() {
        Some(raw) => match normalize_status_word(raw) {
            Some(w) => w,
            None => return Json(ApiResponse::error("文章状态不合法")),
        },
        None => "public",
    };
    let is_public = status_is_publicish(status_word) && payload.is_public.unwrap_or(true);

    // 标签**不在这里写**：`replace_note_tags` 是唯一写点（它同时维护关联表与那一列，
    // 见 `routes/note_tags.rs` 头注）。`ActiveModel` 里省掉 `tags` 就是"这一列不归这里管"。
    let new_tags = payload.tags.clone();

    let new_note = note::ActiveModel {
        title: Set(title),
        content: Set(content),
        is_public: Set(is_public),
        category_id: Set(payload.category_id),
        description: Set(payload.description),
        cover: Set(payload.cover),
        cover_focus_x: Set(payload.cover_focus_x.map(clamp01)),
        cover_focus_y: Set(payload.cover_focus_y.map(clamp01)),
        cover_zoom: Set(payload.cover_zoom.map(clamp_zoom)),
        carousel_focus_x: Set(payload.carousel_focus_x.map(clamp01)),
        carousel_focus_y: Set(payload.carousel_focus_y.map(clamp01)),
        carousel_zoom: Set(payload.carousel_zoom.map(clamp_zoom)),
        is_top: Set(payload.is_top),
        status: Set(Some(status_word.to_string())),
        user_id: Set(author),
        created_at: Set(chrono::Local::now().naive_local()),
        updated_at: Set(chrono::Local::now().naive_local()),
        ..Default::default()
    };

    // 文章行与它的标签行必须**一起**成功：只落文章不落标签，编辑器再打开这篇
    // 会看到"标签全没了"，一保存就把用户的标签清空。
    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[notes] 建文章：开启事务失败: {e}");
            return Json(ApiResponse::error("Error: 数据库不可用"));
        }
    };
    let inserted = match new_note.insert(&txn).await {
        Ok(m) => m,
        Err(e) => {
            let _ = txn.rollback().await;
            return Json(ApiResponse::error(&format!("Error: {}", e)));
        }
    };
    if let Err(e) = note_tags::replace_note_tags(&txn, inserted.id, new_tags.as_deref()).await {
        tracing::error!("[notes] 建文章 {}：写标签失败: {e}", inserted.id);
        let _ = txn.rollback().await;
        return Json(ApiResponse::error(&format!("Error: {}", e)));
    }
    match txn.commit().await {
        Ok(_) => Json(ApiResponse::success("Note created successfully".to_string())),
        Err(e) => {
            tracing::error!("[notes] 建文章：提交失败: {e}");
            Json(ApiResponse::error(&format!("Error: {}", e)))
        }
    }
}

/// 署名回填的判据（纯函数，便于单测）：**两条同时成立**才把当前操作者记成作者。
///
/// · `author_missing`：这一行的 `user_id` 还空着（老文章从没记过作者 / 失败的写入重试）；
/// · `from_editor`：这一笔是**编辑器提交**（`title`/`content` 至少带来一个，见
///   `update_note` 开头那行）——也就是"发布"这一路。
///
/// 缺第二条时，只改标签（`noteTags`）或只改状态（`{status,isTop}`）的写会把**写的人**
/// 记成作者。这两条路的调用方都不是在发布文章（后台列表的快速改状态、agent 的
/// `set_article_tags`/`set_article_status`），而"只在为空时补写"这条规矩会让错误署名
/// **再也改不回来**——20261007 文章 23 被评测身份 uid 721 这样记名的现场见函数内注释。
fn should_backfill_author(author_missing: bool, from_editor: bool) -> bool {
    author_missing && from_editor
}

pub async fn update_note(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
    Json(payload): Json<UpsertNoteRequest>,
) -> Json<ApiResponse<String>> {
    // 是不是「从编辑器提交的完整发布」：编辑器一定同时带 noteTitle + noteContent。
    // 在字段被逐个 move 进 active_model 之前先判定。
    let from_editor = payload.title.is_some() || payload.content.is_some();
    // 标签单独走 `replace_note_tags`（唯一写点）。**没给就一个字节都不动** ——
    // 后台的快速改状态、agent 的 `set_article_status` 都不带 `noteTags`，
    // 把它们当成"清空标签"会让那些操作顺手把标签删光。
    let new_tags = payload.tags.clone();

    let note_data = note::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None);

    // 被点的行本身是「修改稿」（草稿箱里直接点开修改稿再提交）→ 内容得落到它的原文章行上，
    // 否则线上会凭空多出一篇同内容的新文章、原文章永远停在旧内容。
    // 只对编辑器提交（from_editor）重定向：只发 {isTop,status} 的快速改状态仍作用于被点的那行。
    let target = match note_data {
        Some(n) if from_editor && n.draft_of.is_some() => {
            let parent_id = n.draft_of.unwrap_or_default();
            match note::Entity::find_by_id(parent_id).one(&state.db).await.unwrap_or(None) {
                Some(p) => Some(p),
                // 原文章已不存在（孤儿修改稿）→ 不重定向，当普通草稿原地保存
                None => Some(n),
            }
        }
        other => other,
    };

    if let Some(n) = target {
        let target_id = n.id;
        // 作者只在**为空**时补写：「谁发的」是发布那一刻的事实，别人后来编辑这篇文章
        // （改标题/改状态/换个管理员接手）都不该把署名改成最后保存的那个人。
        // 为空的两条路：老文章第一次被编辑时补上、以及失败的写入重试。
        //
        // 20261007 补第二道判据 `from_editor`：**纯元数据写不算"发布"，写它的人也不因此
        // 成为作者**。此前只要 `user_id` 为空，任何一次写（只带 noteTags 的标签写、只带
        // {status,isTop} 的状态写）都会把**写的人**记成作者——而这两条路的调用方（后台列表
        // 的快速改状态、agent 的 set_article_tags / set_article_status）都不是在发布文章。
        // 生产实证：20261007 08:26 评测跑的 `set_article_tags` 以评测管理员身份（uid 721）
        // 写文章 23 的标签，那一行当时 `user_id` 为 NULL ⇒ 站点上这篇老文章的作者被记成了
        // `agent_test_admin_721`；而"只在为空时补写"这条规矩反过来让它**再也改不回来**
        // ——主人自己反复在后台编辑器里保存都不动它（20261007 20:11 两次）。
        // 编辑器提交（title/content 至少带来一个）才是"发布"那一路 ⇒ 老文章第一次被编辑
        // 时照旧补上；纯元数据写一律不碰署名。
        let backfill_author = should_backfill_author(n.user_id.is_none(), from_editor);
        // 行里当前的状态词：`n` 马上要被 move 进 active_model，而下面算"有效状态"要用它。
        let current_status: Option<String> = n.status.clone();
        let mut active_model: note::ActiveModel = n.into();

        if backfill_author {
            if let Ok(uid) = crate::auth_jwt::auth_uid(&state.db, &headers).await {
                active_model.user_id = Set(Some(uid));
            }
        }

        if let Some(v) = payload.title { active_model.title = Set(v); }
        if let Some(v) = payload.content { active_model.content = Set(v); }
        if let Some(v) = payload.category_id { active_model.category_id = Set(Some(v)); }
        
        if let Some(v) = payload.description { active_model.description = Set(Some(v)); }
        if let Some(v) = payload.cover { active_model.cover = Set(Some(v)); }
        if let Some(v) = payload.cover_focus_x { active_model.cover_focus_x = Set(Some(clamp01(v))); }
        if let Some(v) = payload.cover_focus_y { active_model.cover_focus_y = Set(Some(clamp01(v))); }
        if let Some(v) = payload.cover_zoom { active_model.cover_zoom = Set(Some(clamp_zoom(v))); }
        if let Some(v) = payload.carousel_focus_x { active_model.carousel_focus_x = Set(Some(clamp01(v))); }
        if let Some(v) = payload.carousel_focus_y { active_model.carousel_focus_y = Set(Some(clamp01(v))); }
        if let Some(v) = payload.carousel_zoom { active_model.carousel_zoom = Set(Some(clamp_zoom(v))); }
        if let Some(v) = payload.is_top { active_model.is_top = Set(Some(v)); }
        // ⚠️ `payload.tags` **不在这里写**（20261018）：标签的唯一写点是
        // `replace_note_tags`，它在下面那个事务里跟这一笔一起提交。
        // 在这里写列、在别处写关联表 = 两个落脚点各写一半，失败时留下半截状态。

        // 状态与可见性：**一次推导**（20261018）。
        //
        // 此前这里是"派生 → 允许显式覆盖 → 再补一次"的补丁摞补丁：只带 `{"is_public":true}`
        // 打在一条 `status='private'` 的行上时，第二次覆盖把 `is_public` 置回 true，而
        // `status` 一个字节没动 ⇒ 库里落下 `('private', true)`。公开列表的守卫是
        // "排除 draft"（黑名单），这种行**会被公开列出**。现在把这条路口封死：
        // 显式要公开而有效状态词不公开 → **拒绝**，不落库。
        let requested_word = match payload.status.as_deref() {
            Some(raw) => match normalize_status_word(raw) {
                Some(w) => Some(w),
                None => return Json(ApiResponse::error("文章状态不合法")),
            },
            None => None,
        };
        if let Some(w) = requested_word {
            active_model.status = Set(Some(w.to_string()));
        }
        // 只带 `{isTop}` 之类的纯元数据写不进这一支 —— 不动可见性。
        if requested_word.is_some() || payload.is_public.is_some() {
            // 有效状态词：这一笔给了就用它，没给就沿用行里现有的（NULL 视作 `private`，
            // 与"没记录的可见性一律不可见"同取向）。
            let eff_word = requested_word
                .map(|w| w.to_string())
                .or_else(|| current_status.clone())
                .unwrap_or_else(|| "private".to_string());
            let eff_public = payload.is_public.unwrap_or(status_is_publicish(&eff_word));
            if eff_public && !status_is_publicish(&eff_word) {
                return Json(ApiResponse::error("私密/草稿状态的文章不能设为公开"));
            }
            active_model.is_public = Set(eff_public);
        }

        active_model.updated_at = Set(chrono::Local::now().naive_local());

        // 文章行与标签行同一个事务（20261018）：`replace_note_tags` 自己写两张表，
        // 而"内容存进去了、标签没存"是最难被发现的一类半截状态（用户看到保存成功）。
        let txn = match state.db.begin().await {
            Ok(t) => t,
            Err(e) => {
                tracing::error!("[notes] 更新文章 {target_id}：开启事务失败: {e}");
                return Json(ApiResponse::error("Error: 数据库不可用"));
            }
        };
        if let Err(e) = active_model.update(&txn).await {
            let _ = txn.rollback().await;
            return Json(ApiResponse::error(&format!("Error: {}", e)));
        }
        if new_tags.is_some() {
            if let Err(e) =
                note_tags::replace_note_tags(&txn, target_id, new_tags.as_deref()).await
            {
                tracing::error!("[notes] 更新文章 {target_id}：写标签失败: {e}");
                let _ = txn.rollback().await;
                return Json(ApiResponse::error(&format!("Error: {}", e)));
            }
        }
        match txn.commit().await {
            Ok(_) => {
                // 发布即消费掉修改稿：编辑器提交（from_editor）时原文章行已拿到最新内容，
                // 挂在它下面的修改稿就没有存在意义了，删掉免得草稿箱里留过期副本。
                // 只发 {isTop, status} 的快速改状态（updateNoteStatus）不清——那不是发布内容，
                // 清了会把用户编辑中的修改稿误删。
                if from_editor {
                    let _ = note::Entity::delete_many()
                        .filter(note::Column::DraftOf.eq(target_id))
                        .exec(&state.db)
                        .await;
                }
                Json(ApiResponse::success("Note updated successfully".to_string()))
            }
            Err(e) => {
                tracing::error!("[notes] 更新文章 {target_id}：提交失败: {e}");
                Json(ApiResponse::error(&format!("Error: {}", e)))
            }
        }
    } else {
         Json(ApiResponse::error("Note not found"))
    }
}

pub async fn delete_note(
    State(state): State<Arc<AppState>>,
    Json(keys): Json<Vec<i32>>,
) -> Json<ApiResponse<String>> {
    // 级联删修改稿：文章删了，挂它的修改稿（draft_of = 该 id）就是孤儿——草稿箱里会留一行
    // 指向不存在文章的行，点进去编辑器还会 404。先删修改稿再删本体。
    let _ = note::Entity::delete_many()
        .filter(note::Column::DraftOf.is_in(keys.clone()))
        .exec(&state.db)
        .await;

    match note::Entity::delete_many()
        .filter(note::Column::Id.is_in(keys))
        .exec(&state.db)
        .await {
        Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
    }
}

pub async fn get_note_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Response {
    // 公开详情仅返回已发布文章（A4 修复：与列表/搜索接口的过滤条件一致，防枚举自增 id 读取草稿/私密文章）
    // 20261018：谓词从"排除 draft"翻成白名单，未知 status 由放行变拦截（口径只有一处，
    // 见 `public_status_words`）。
    let res = note::Entity::find_by_id(id)
        .filter(public_condition())
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    // 详情页头部同样按**文章作者**渲染（与卡片同一份判据，不是站点主人）
    let mut dtos: Vec<NoteDto> = res.into_iter().next().map(|(n, cats)| {
        map_note(n, cats.into_iter().next().map(|c| (c.id, c.name)))
    }).into_iter().collect();
    attach_tags(&state.db, &mut dtos).await;
    attach_authors(&state.db, &mut dtos).await;
    let dto = dtos.into_iter().next();

    // 20260902：文章不存在/不可见时返回 HTTP 404（此前 200+data:null）——前端
    // ReadArticle 的 notFound 判定依赖 err.response.status===404，200+null 会让
    // 编造的文章链接（如 agent 幻觉输出的 /article/17）显示成"文章加载中"而非
    // "文章不存在"，幻觉无法被用户戳穿。
    match dto {
        Some(dto) => (StatusCode::OK, Json(ApiResponse::success(dto))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(ApiResponse {
            code: 404,
            message: "文章不存在".to_string(),
            data: Option::<NoteDto>::None,
        })).into_response(),
    }
}fn map_note_summary(n: note::Model, cat: Option<(i32, String)>) -> NoteDto {
    let mut dto = map_note(n, cat);
    dto.content = String::new();
    dto.content_raw = String::new();
    dto
}

/// 给一批列表行挂上卡片要的四个数（阅读 / 点赞 / 收藏 / 讨论，查询在
/// `note_stats::counts_for`）。
///
/// **失败只降级、不报错**：统计查询挂了就四列留 `None`（卡片那一排不渲染），列表本身照常
/// 返回——四个数是装饰，不是"列表能不能看"的前提。这也正是 `Option` 而非 `i64` 的理由：
/// 一次查询失败绝不能变成"站上每篇文章都 0 阅读"。
///
/// 只挂在**公开列表**（首页/分类页的卡片、搜索、置顶）上；后台那两个列表不挂——那里一次
/// 可能拉上千行（Times 归档页 `page_size=999`），而这四个数的消费者只有卡片。
/// 给这一批文章挂上「谁发的」（`note.user_id` → 那个账号的 `nickname`/`avatar`）。
///
/// **回退链**（与 `web_info::site_author` 共用站点级那一份，口径只有一处）：
///   行里的 uid 有、且那个账号还在 → **署名就是这个账号**：昵称空则用账号名，
///   头像空则**留空**（前端画 antd 默认头像）；
///   uid 为 NULL（本列之前发布的老文章 / 发布者账号已销）→ **站点级署名**，
///   也就是改造前卡片上显示的那一份 ⇒ 存量文章的外观一个像素都不变。
///
/// **有作者记录时，一个字段都不借站长的身份**（20261001 实测修）。此前那两个
/// `.unwrap_or_else(站点级)` 是"这个字段空就退到站点级"，退到的是**站长自己**——
/// 于是 jingbao 发的文章（昵称有、头像没上传过）在卡片上是「jingbao 的名字 + Sora
/// Saudade 的脸」。用户报的正是这个（"作者头像不对，还是硬编码的？"：不是硬编码，
/// 是回退链把别人的文章安到了站长头上）。脸指向另一个人比没有脸更糟：名字留空还能看出
/// "这里没记录"，顶着别人的照片则是**看起来有据的错信息**。名字那条同理退到账号名
/// （这个人另一个真名），不是站长名。
///
/// 两个键**成对写**：都在（= 这一路的作者信息定过稿）或都不在（= 这一路没挂作者）——
/// 前端 `utils/noteAuthor.ts` 按"键在不在场"判，就是靠这条。只写一个会让前端把
/// "另一个字段留空"读成"没有作者信息"。
///
/// **失败时一个键都不写**（`return` 而不是回退）：查库失败意味着"没查着"，
/// 与"这个人没有昵称"是两件事。键缺席 ⇒ 前端照旧用站点级署名渲染，屏幕上没有假的
/// 人名；写一个站点级署名冒充"查着了"才是错的。
///
/// 一次查询取回整批（同一页最多几十个不同作者，实际上通常只有一个）。
async fn attach_authors(db: &sea_orm::DatabaseConnection, dtos: &mut [NoteDto]) {
    let ids: Vec<i32> = dtos.iter().filter_map(|d| d.author_id)
        .collect::<std::collections::HashSet<i32>>().into_iter().collect();
    if ids.is_empty() {
        return;
    }

    // 只取署名真正用到的四列（20261014）。从前是整行 `user::Model`——`SELECT *`
    // 把每个作者的 **password 哈希** 也捞进内存，而这里只用 username / nickname / avatar。
    // ⚠️ `match` 保留：**失败**与**查着了但一个都没匹配上**必须分开（前者一个键都不写，
    // 见函数头注），所以不能省成 `unwrap_or_default()`。
    struct AuthorRow {
        username: String,
        nickname: String,
        avatar: Option<String>,
    }
    let users: Vec<(i32, AuthorRow)> = match user::Entity::find()
        .select_only()
        .column(user::Column::Id)
        .column(user::Column::Username)
        .column(user::Column::Nickname)
        .column(user::Column::Avatar)
        .filter(user::Column::Id.is_in(ids))
        .into_tuple::<(i32, String, String, Option<String>)>()
        .all(db)
        .await
    {
        Ok(v) => v
            .into_iter()
            .map(|(id, username, nickname, avatar)| {
                (id, AuthorRow { username, nickname, avatar })
            })
            .collect(),
        Err(e) => {
            tracing::warn!("[notes] 作者查询失败，本页不挂署名（前端回退站点级）: {e}");
            return;
        }
    };
    let by_id: HashMap<i32, AuthorRow> = users.into_iter().collect();
    let (site_name, site_avatar) = crate::routes::web_info::site_author(db).await;

    for dto in dtos.iter_mut() {
        match dto.author_id.and_then(|id| by_id.get(&id)) {
            // 有作者记录：两个字段都只出自这个账号，谁也不退到站长（见函数头注）
            Some(u) => {
                let nick = u.nickname.trim();
                dto.author_name = Some(if nick.is_empty() {
                    u.username.trim().to_string()
                } else {
                    nick.to_string()
                });
                // 空串**要发出去**（`skip_serializing_if` 只跳过 `None`）：键在场 =
                // "这个人没设过头像" ⇒ 前端画默认头像；键缺席 = "这一路没挂作者" ⇒
                // 前端回退站点级。两件事在连线上必须是两个样子。
                dto.author_avatar = Some(u.avatar.as_deref().unwrap_or("").trim().to_string());
            }
            None => {
                dto.author_name = Some(site_name.clone());
                dto.author_avatar = Some(site_avatar.clone());
            }
        }
    }
}

async fn attach_stats(db: &sea_orm::DatabaseConnection, dtos: &mut [NoteDto]) {
    let ids: Vec<i32> = dtos.iter().map(|d| d.id).collect();
    match crate::routes::note_stats::counts_for(db, &ids).await {
        Ok(counts) => {
            for dto in dtos.iter_mut() {
                if let Some(c) = counts.get(&dto.id) {
                    dto.views = Some(c.views);
                    dto.likes = Some(c.likes);
                    dto.favorites = Some(c.favorites);
                    dto.comments = Some(c.comments);
                }
            }
        }
        Err(e) => tracing::warn!("[notes] 列表附带统计失败，本页四个数不显示: {e}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 编辑草稿（自动保存，20260912c）：编辑器每 2s 把正在写的内容落到草稿箱里的一行。
// 与 update_note 分开是刻意的——update_note 是「发布」语义（会改 status/is_public、
// 会消费掉修改稿），自动保存绝不能碰这些。
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AutosaveDraftRequest {
    /// 正在编辑的文章 id；None/缺省 = 新建文章（还没落过库）→ 新建一行独立草稿
    pub id: Option<i32>,
    #[serde(rename = "noteTitle")]
    pub title: Option<String>,
    #[serde(rename = "noteContent")]
    pub content: Option<String>,
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>,
    #[serde(rename = "isTop")]
    pub is_top: Option<i32>,
    pub description: Option<String>,
    pub cover: Option<String>,
    #[serde(rename = "coverFocusX")]
    pub cover_focus_x: Option<f64>,
    #[serde(rename = "coverFocusY")]
    pub cover_focus_y: Option<f64>,
    #[serde(rename = "coverZoom")]
    pub cover_zoom: Option<f64>,
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,
    #[serde(rename = "noteTags")]
    pub tags: Option<String>,
}

#[derive(Serialize, Default)]
pub struct AutosaveDraftResult {
    /// 客户端此后继续沿用的文章 id（新建时 = 刚建出来的草稿行 id）
    pub id: i32,
    /// 本次实际写入了哪一行（原文章行 / 独立草稿行 / 修改稿行）
    #[serde(rename = "draftId")]
    pub draft_id: i32,
    /// true = 写的是「原文章的修改稿」，原文章线上内容一个字没动
    #[serde(rename = "isRevision")]
    pub is_revision: bool,
    #[serde(rename = "updateTime")]
    pub update_time: String,
}

/// 解析这次自动保存该写哪一行：
/// - `id = None`            → 新建一行独立草稿（status='draft'，进草稿箱）
/// - 目标行 status='draft'  → 原地更新（它本来就是草稿箱里的一行）
/// - 其他（public/private） → 取它的修改稿行（draft_of = id）；没有就克隆原行建一行。
///   原行在此期间**一个列都不动**，线上访客看到的仍是旧内容。
async fn resolve_autosave_target(
    state: &Arc<AppState>,
    id: Option<i32>,
) -> Result<note::Model, String> {
    let now = chrono::Local::now().naive_local();

    let Some(id) = id else {
        let row = note::ActiveModel {
            title: Set(String::new()),
            content: Set(String::new()),
            status: Set(Some("draft".to_string())),
            is_public: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        return row
            .insert(&state.db)
            .await
            .map_err(|e| format!("Create draft failed: {}", e));
    };

    let Some(n) = note::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None) else {
        return Err("Note not found".to_string());
    };

    // 草稿（含新建时落下的那行）原地更新，不再套一层修改稿
    if n.status.as_deref() == Some("draft") {
        return Ok(n);
    }

    if let Some(rev) = note::Entity::find()
        .filter(note::Column::DraftOf.eq(id))
        .order_by_desc(note::Column::Id)
        .one(&state.db)
        .await
        .unwrap_or(None)
    {
        return Ok(rev);
    }

    // 克隆原行做修改稿（id 交给自增），内容随后由 payload 覆盖。
    // ⚠️ 关联表**不会**跟着列克隆走（20261018）：`note_tag` 的行得显式复制一份，
    // 否则"继续编辑"打开修改稿时标签栏是空的，用户一保存就把标签清光。
    let src_tags = match note_tags::current_tags(&state.db, id).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[notes] 建修改稿：读源行标签失败: {e}");
            return Err("Create revision failed".to_string());
        }
    };
    let mut am: note::ActiveModel = n.into();
    am.id = NotSet;
    am.draft_of = Set(Some(id));
    am.status = Set(Some("draft".to_string()));
    am.is_public = Set(false);
    am.created_at = Set(now);
    am.updated_at = Set(now);
    let txn = state
        .db
        .begin()
        .await
        .map_err(|e| format!("Create revision failed: {}", e))?;
    let rev = am
        .insert(&txn)
        .await
        .map_err(|e| format!("Create revision failed: {}", e))?;
    note_tags::replace_note_tags(&txn, rev.id, src_tags.as_deref())
        .await
        .map_err(|e| format!("Create revision failed: {}", e))?;
    txn.commit()
        .await
        .map_err(|e| format!("Create revision failed: {}", e))?;
    Ok(rev)
}

pub async fn autosave_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AutosaveDraftRequest>,
) -> Json<ApiResponse<AutosaveDraftResult>> {
    let client_id = payload.id;

    let target = match resolve_autosave_target(&state, payload.id).await {
        Ok(t) => t,
        Err(e) => return Json(ApiResponse::error(&e)),
    };

    let is_revision = target.draft_of.is_some();
    // 草稿也要记作者：它是"这篇文章是谁开写的"的第一现场，比发布更早。
    // 与 update_note 同规矩——只在为空时写（新建的那行草稿在建行的第一次自动保存
    // 就补上；修改稿是从原行克隆的，user_id 已经带过来了）。
    let author_missing = target.user_id.is_none();
    // 这一笔没带 `noteTags` 就沿用行里现有的（`replace_note_tags` 下面**总会**调一次：
    // 新建出来的草稿行也要把关联表落到"空"，克隆出来的修改稿要复制一份）。
    // ⚠️ 沿用的是**关联表里的现状**（`note_tags::current_tags`），不是 `note.tags` 那一列
    // —— 读那一列等于把"它可能已经陈旧"请进读路径，而陈旧是看不见的。
    // 读失败**不许**退化成"没有标签"：那会让下一次自动保存把标签清光。
    let eff_tags = match payload.tags.clone() {
        Some(v) => Some(v),
        None => match note_tags::current_tags(&state.db, target.id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("[notes] 自动保存 {}：读现有标签失败: {e}", target.id);
                return Json(ApiResponse::error("Error: 读现有标签失败"));
            }
        },
    };
    let mut am: note::ActiveModel = target.into();

    if author_missing {
        if let Ok(uid) = crate::auth_jwt::auth_uid(&state.db, &headers).await {
            am.user_id = Set(Some(uid));
        }
    }

    if let Some(v) = payload.title { am.title = Set(v); }
    if let Some(v) = payload.content { am.content = Set(v); }
    if let Some(v) = payload.category_id { am.category_id = Set(Some(v)); }
    if let Some(v) = payload.description { am.description = Set(Some(v)); }
    if let Some(v) = payload.cover { am.cover = Set(Some(v)); }
    if let Some(v) = payload.cover_focus_x { am.cover_focus_x = Set(Some(clamp01(v))); }
    if let Some(v) = payload.cover_focus_y { am.cover_focus_y = Set(Some(clamp01(v))); }
    if let Some(v) = payload.cover_zoom { am.cover_zoom = Set(Some(clamp_zoom(v))); }
    if let Some(v) = payload.carousel_focus_x { am.carousel_focus_x = Set(Some(clamp01(v))); }
    if let Some(v) = payload.carousel_focus_y { am.carousel_focus_y = Set(Some(clamp01(v))); }
    if let Some(v) = payload.carousel_zoom { am.carousel_zoom = Set(Some(clamp_zoom(v))); }
    if let Some(v) = payload.is_top { am.is_top = Set(Some(v)); }
    // 标签不在这里写（唯一写点是 `replace_note_tags`，见下）。
    // status / is_public 一律不动：写的一定是草稿（原行是草稿，克隆出来的修改稿也是草稿），
    // 发布是 update_note 的事。
    am.updated_at = Set(chrono::Local::now().naive_local());

    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[notes] 自动保存：开启事务失败: {e}");
            return Json(ApiResponse::error("Error: 数据库不可用"));
        }
    };
    let saved = match am.update(&txn).await {
        Ok(s) => s,
        Err(e) => {
            let _ = txn.rollback().await;
            return Json(ApiResponse::error(&format!("Error: {}", e)));
        }
    };
    if let Err(e) = note_tags::replace_note_tags(&txn, saved.id, eff_tags.as_deref()).await {
        tracing::error!("[notes] 自动保存 {}：写标签失败: {e}", saved.id);
        let _ = txn.rollback().await;
        return Json(ApiResponse::error(&format!("Error: {}", e)));
    }
    match txn.commit().await {
        Ok(_) => Json(ApiResponse::success(AutosaveDraftResult {
            id: client_id.unwrap_or(saved.id),
            draft_id: saved.id,
            is_revision,
            update_time: saved.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        })),
        Err(e) => {
            tracing::error!("[notes] 自动保存：提交失败: {e}");
            Json(ApiResponse::error(&format!("Error: {}", e)))
        }
    }
}

#[derive(Serialize)]
pub struct EditorNoteDto {
    /// 原文章行（id 就是 URL 里那个 id）
    pub note: NoteDto,
    /// 待继续编辑的修改稿；null = 没有未发布的修改稿，编辑器直接用 note 回填
    pub draft: Option<NoteDto>,
}

/// 编辑器专用的读入口：公开的 `GET /api/public/notes/:id` 会挡掉草稿/私密文章（A4），
/// 导致草稿箱点进去 404、编辑器打不开自己的草稿。这里不做可见性过滤（protected 组已限 admin）。
pub async fn get_note_for_edit(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Response {
    let rows = note::Entity::find_by_id(id)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let Some((n, cats)) = rows.into_iter().next() else {
        return (StatusCode::NOT_FOUND, Json(ApiResponse {
            code: 404,
            message: "文章不存在".to_string(),
            data: Option::<EditorNoteDto>::None,
        })).into_response();
    };

    // 三行：(原文章, 原文章分类, 待继续编辑的修改稿)
    let (note_row, note_cats, draft_row) = match n.draft_of {
        // URL 里的 id 本身就是一行「修改稿」（草稿箱直接点开修改稿、或旧链接）：
        // 得把它的**原文章**当 note 返回——编辑器用 note 的状态回填弹窗，
        // 拿修改稿自己的 status（恒为 draft）回填会让弹窗默认「草稿」，用户不改直接提交
        // 就什么都没发布。内容仍用这行修改稿回填。发布时 update_note 做同样的重定向。
        Some(parent_id) => {
            let parents = note::Entity::find_by_id(parent_id)
                .find_with_related(category::Entity)
                .all(&state.db)
                .await
                .unwrap_or(vec![]);
            match parents.into_iter().next() {
                Some((p, pcats)) => (p, pcats, Some((n, cats))),
                // 原文章已被删（孤儿修改稿）→ 当普通草稿，至少内容还在
                None => (n, cats, None),
            }
        }
        None => {
            let drafts = note::Entity::find()
                .filter(note::Column::DraftOf.eq(id))
                .order_by_desc(note::Column::Id)
                .find_with_related(category::Entity)
                .all(&state.db)
                .await
                .unwrap_or(vec![]);
            (n, cats, drafts.into_iter().next())
        }
    };

    let (note_dto, draft_dto) = (
        map_note(note_row, note_cats.into_iter().next().map(|c| (c.id, c.name))),
        draft_row.map(|(d, cats)| map_note(d, cats.into_iter().next().map(|c| (c.id, c.name)))),
    );
    // 原文章与修改稿**一起**挂标签（一次查询 —— `attach_tags` 收的是一批 DTO）。
    // 两行都得挂：编辑器靠 `noteTags` 回填标签选择器，漏了修改稿那一行，
    // 用户打开"继续编辑"会发现标签全没了、一保存就把标签清空。
    let mut rows: Vec<NoteDto> = std::iter::once(note_dto).chain(draft_dto).collect();
    attach_tags(&state.db, &mut rows).await;
    let mut rows = rows.into_iter();
    let dto = EditorNoteDto {
        note: rows.next().expect("上面刚放进去的原文章那一行"),
        draft: rows.next(),
    };

    (StatusCode::OK, Json(ApiResponse::success(dto))).into_response()
}

// `#[cfg(test)] mod split_terms_tests` 随 `split_terms` 一起搬到了 `crate::search_core`
// （20261006）：测试跟着实现走，否则改一份、另一份假绿。

#[cfg(test)]
mod tests {
    use super::*;

    /// 署名回填的四个组合（20261007 修的 bug 就在第一行之外的两个"false"上）。
    ///
    /// 这条判据红过的样子：文章 23 的 `user_id` 为空，agent 以评测管理员身份只写了一次
    /// `noteTags` ⇒ 那一行被记成 `agent_test_admin_721`，而"只在为空时补写"让主人自己
    /// 反复保存也改不回来。所以第二、三条不是"顺手也断言一下"，它们是这个 bug 的两半。
    #[test]
    fn 署名只认编辑器提交且只补空行() {
        assert!(should_backfill_author(true, true), "老文章第一次被编辑器保存 ⇒ 补上作者");
        assert!(
            !should_backfill_author(true, false),
            "只改标签/状态的元数据写不是发布 ⇒ 不许把写它的人记成作者"
        );
        assert!(
            !should_backfill_author(false, true),
            "已经有作者的行 ⇒ 后来的保存不许改写署名（谁发的≠最后保存的）"
        );
        assert!(!should_backfill_author(false, false));
    }

    /// 列表查询的 SELECT 列表里**没有 `content`**（20261018）。
    ///
    /// 这条判据红的样子：有人往 `NoteSummary` 里加回 `content`（或者干脆把
    /// `into_partial_model` 换回 `into_model::<note::Model>`）—— 那时 Times 归档页
    /// （`page_size=999`）又会一次把**全站正文**读回内存，而**没有任何别的东西会红**
    /// （接口照常 200，`map_note_summary` 照旧把 content 置空，用户看不出区别）。
    ///
    /// ⚠️ **不能**用"端点返回 200 / content 是空串"当判据 —— 那是**空真**：
    /// content 本来就会被 `map_note_summary` 置空，读不读回来都一样。
    #[test]
    fn 列表查询的_select_列表里没有正文() {
        use sea_orm::{DbBackend, PartialModelTrait, QuerySelect, QueryTrait};

        // 组合方式必须与 sea-orm 的 `into_partial_model` **逐字一致**：
        //   `M::select_cols(QuerySelect::select_only(self))`（`executor/select.rs:218`，
        //   `SelectTwo` 那版在 `:500`，同样是先 `select_only` 再两个 `select_cols`）。
        // ⚠️ `select_cols` 是**追加**，不是替换 —— 少写 `select_only()` 取到的是
        // 「整实体列 + partial 列」的拼接，里面当然有 `content`，判据就会红在一个
        // **它自己造出来的**假象上（20261018 CI 首跑就是这么红的：它报出来的 SQL 以
        // `SELECT "note"."id", "note"."title", "note"."content", …` 开头）。
        let sql = <NoteSummary as PartialModelTrait>::select_cols(
            note::Entity::find().select_only(),
        )
        .build(DbBackend::Postgres)
        .sql;
        assert!(sql.contains("\"title\""), "标题在（不然这条判据连自己都没在测）：{sql}");
        assert!(
            !sql.contains("\"content\""),
            "列表查询又把正文读回来了 —— 见 NoteSummary 头注：这是唯一随语料线性增长的读放大。SQL={sql}"
        );
        // `content_raw` 不是列名（DTO 才叫这个），防的是有人误把它当列加进 partial。
        assert!(!sql.contains("content_raw"), "SQL={sql}");

        // 反控**写在测试里**，不靠人记得：不走 `into_partial_model` 那条组合时取到的
        // SQL 必须**含** `content`。少了这一条，上面那句「没有 content」在
        // 「`note` 表真的没有 content 列了」「`select_only` 语义变了」这类情形下
        // 会**空真通过**，而它看起来跟真通过一模一样。
        let naive = note::Entity::find().build(DbBackend::Postgres).sql;
        assert!(
            naive.contains("\"content\""),
            "反控失败：整实体的 SELECT 里居然没有 content ⇒ 上面那句「没有正文」\
             已经不是在测任何东西了。SQL={naive}"
        );
    }

    /// 状态词表的唯一解析点：只认三个词，`published` 归一成 `public`，其余一律 `None`。
    #[test]
    fn 状态词只认白名单() {
        assert_eq!(normalize_status_word("public"), Some("public"));
        assert_eq!(normalize_status_word("published"), Some("public"), "别名归一");
        assert_eq!(normalize_status_word("private"), Some("private"));
        assert_eq!(normalize_status_word("draft"), Some("draft"));
        assert_eq!(normalize_status_word("  public  "), Some("public"), "两侧空白不算词的一部分");
        // 这几个是"原样写库"的来路：必须 None（调用方据此拒绝），而不是 Some("随便什么")。
        assert_eq!(normalize_status_word("archived"), None);
        assert_eq!(normalize_status_word("Public"), None, "大小写敏感，不做模糊匹配");
        assert_eq!(normalize_status_word(""), None);
        // 公开档的判定：归一之后只剩 public，但 published 也得算公开（归一之前也会问）。
        assert!(status_is_publicish("public") && status_is_publicish("published"));
        assert!(!status_is_publicish("private") && !status_is_publicish("draft"));
        // 白名单就是这两个词 —— 与上面 `is_in` 谓词喂的是同一份。
        assert_eq!(public_status_words(), vec!["public".to_string(), "published".to_string()]);
    }
}
