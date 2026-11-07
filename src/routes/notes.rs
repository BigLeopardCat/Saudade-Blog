pub(crate) mod authors;

use axum::{Json, extract::{State, Query, Path}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}};
use sea_orm::{DatabaseConnection, EntityTrait, ColumnTrait, QueryFilter, QueryOrder, QuerySelect, Condition, ActiveModelTrait, Set, PaginatorTrait, DerivePartialModel, TransactionTrait};
// `Expr` / `SimpleExpr` 只服务关键词预筛那几处（列表达式要带表名限定，见 `search_notes`）。
use sea_orm::sea_query::{Expr, SimpleExpr};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use crate::entity::{note, category};
use crate::routes::note_tags::{self, attach_tags};
use crate::routes::AppState;
use crate::search_core::{count_terms, keyword_given, keyword_prefilter, score_term_sum, split_terms};
use crate::utils::ApiResponse;


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
    #[serde(rename = "coverFit")]
    pub cover_fit: Option<String>,
    // 置顶轮播专用裁剪参数，null = 未设置（前端渲染时回退跟随 cover_* 那套）
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,
    #[serde(rename = "carouselFit")]
    pub carousel_fit: Option<String>,

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
    #[serde(rename = "noteTagRefs")]
    pub tag_refs: Vec<note_tags::TagRef>,

    #[serde(skip)]
    pub author_id: Option<i32>,
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
        cover_fit: n.cover_fit,
        carousel_focus_x: n.carousel_focus_x,
        carousel_focus_y: n.carousel_focus_y,
        carousel_zoom: n.carousel_zoom,
        carousel_fit: n.carousel_fit,
        created_at: n.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: n.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        is_top: n.is_top.unwrap_or(0),
        status: n.status.unwrap_or("published".to_string()),
        draft_of: n.draft_of,
        category_id: cat_id,
        category_title: cat_name,
        is_public: n.is_public,
        tags: String::new(),
        tag_refs: Vec::new(),
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
    pub cover_fit: Option<String>,
    pub carousel_focus_x: Option<f64>,
    pub carousel_focus_y: Option<f64>,
    pub carousel_zoom: Option<f64>,
    pub carousel_fit: Option<String>,
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
            cover_fit: self.cover_fit,
            carousel_focus_x: self.carousel_focus_x,
            carousel_focus_y: self.carousel_focus_y,
            carousel_zoom: self.carousel_zoom,
            carousel_fit: self.carousel_fit,
            is_top: self.is_top,
            status: self.status,
            draft_of: self.draft_of,
            user_id: self.user_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            is_public: self.is_public,
            tags: None,
            category_id: self.category_id,
        }
    }
}

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
    pub title: Option<String>,
    pub categories: Option<String>,
    pub status: Option<String>,
    pub is_top: Option<i32>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub only_public: Option<bool>,
}


pub(crate) fn note_hits_keyword(n: &note::Model, kw: &str, tag_names: &[String]) -> bool {
    n.title.to_lowercase().contains(kw)
        || n.content.to_lowercase().contains(kw)
        || tag_names.iter().any(|t| t.to_lowercase().contains(kw))
}


/// 命中的 term 个数（0 = 不命中；`terms.len()` = 全中）。**档位即这个词数**——
/// 前台按「全中优先、无全中才降级到部分命中」分档（见 search_notes）。
fn term_hit_count(n: &note::Model, terms: &[String], tag_names: &[String]) -> usize {
    count_terms(terms, |t| note_hits_keyword(n, t, tag_names))
}

/// 多词命中：任一 term 命中即算（后台筛选用——召回优先，后台列表自己排序）。
fn note_hits_terms(n: &note::Model, terms: &[String], tag_names: &[String]) -> bool {
    term_hit_count(n, terms, tag_names) > 0
}

fn search_score_terms(note: &note::Model, terms: &[String], tag_names: &[String]) -> i64 {
    score_term_sum(terms, Some(&note.title), tag_names, &note.content)
}

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

mod legacy_search;
pub use legacy_search::search_notes;

async fn search_notes_query(
    state: Arc<AppState>,
    payload: SearchRequest,
    terms: Vec<String>,
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

    if keyword_given(payload.keyword.as_deref()) && terms.is_empty() {
        return Json(ApiResponse::success(vec![]));
    }
    match note_keyword_prefilter(&state.db, &terms).await {
        Ok(Some(pre)) => condition = condition.add(pre),
        // 没有可用 term（此时上面的短路已经放过去了 ⇒ 真的没给关键词）⇒ 不加条件。
        Ok(None) => {}
        Err(e) => return crate::routes::db_error("公开文章搜索预筛", &e),
    }

    if let Some(ref cat_name) = payload.categories {
        let cat_model = category::Entity::find()
            .filter(category::Column::Name.eq(cat_name))
            .one(&state.db)
            .await;
        let cat_model = match cat_model {
            Ok(row) => row,
            Err(e) => return crate::routes::db_error("搜索分类", &e),
        };

        if let Some(c) = cat_model {
            condition = condition.add(note::Column::CategoryId.eq(c.id));
        } else {
            return Json(ApiResponse::success(vec![]));
        }
    }

    if terms.is_empty() {
        let rows = note::Entity::find()
            .filter(condition)
            .order_by_asc(note::Column::Id)
            .limit(legacy_search::CANDIDATE_LIMIT + 1)
            .into_partial_model::<NoteSummary>()
            .all(&state.db)
            .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(e) => return crate::routes::db_error("公开文章筛选", &e),
        };
        if rows.len() as u64 > legacy_search::CANDIDATE_LIMIT {
            return legacy_search::too_broad();
        }
        let cats = category_names(&state.db, rows.iter().filter_map(|r| r.category_id)).await;
        let mut dtos: Vec<NoteDto> = rows.into_iter().map(|r| summary_to_dto(r, &cats)).collect();
        attach_tags(&state.db, &mut dtos).await;
        attach_stats(&state.db, &mut dtos).await;
        attach_authors(&state.db, &mut dtos).await;
        return Json(ApiResponse::success(dtos));
    }

    let notes = note::Entity::find()
        .filter(condition)
        .order_by_asc(note::Column::Id)
        .limit(legacy_search::CANDIDATE_LIMIT + 1)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await;
    let notes = match notes {
        Ok(rows) => rows,
        Err(e) => return crate::routes::db_error("公开文章搜索", &e),
    };
    if notes.len() as u64 > legacy_search::CANDIDATE_LIMIT {
        return legacy_search::too_broad();
    }

    let notes = if terms.is_empty() {
        notes
    } else {
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

    let mut dtos: Vec<NoteDto> = notes
        .into_iter()
        .map(|(n, cats)| map_note_summary(n, cats.into_iter().next().map(|c| (c.id, c.name))))
        .collect();
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

    let terms = payload
        .keyword
        .as_deref()
        .map(split_terms)
        .unwrap_or_default();
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
    attach_tags(&state.db, &mut dtos).await;
    attach_authors(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverFit {
    Cover,
    Contain,
}

impl CoverFit {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cover => "cover",
            Self::Contain => "contain",
        }
    }
}

#[derive(Deserialize)]
pub struct UpsertNoteRequest {
    #[serde(rename = "expectedVersion")]
    pub expected_version: Option<String>,
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
    #[serde(rename = "coverFit")]
    pub cover_fit: Option<CoverFit>,
    // 置顶轮播专用裁剪参数：同样不传则不改动该列；三列必须同进同出（渲染端按三元组原子判定，
    // 只写其中一列会让整组失效 ⇒ 写入静默不生效）
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,
    #[serde(rename = "carouselFit")]
    pub carousel_fit: Option<CoverFit>,

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
        cover_fit: Set(Some(payload.cover_fit.unwrap_or(CoverFit::Contain).as_str().into())),
        carousel_focus_x: Set(payload.carousel_focus_x.map(clamp01)),
        carousel_focus_y: Set(payload.carousel_focus_y.map(clamp01)),
        carousel_zoom: Set(payload.carousel_zoom.map(clamp_zoom)),
        carousel_fit: Set(payload.carousel_fit.map(|v| v.as_str().into())),
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
            return write_error(&e);
        }
    };
    if let Err(e) = note_tags::replace_note_tags(&txn, inserted.id, new_tags.as_deref()).await {
        tracing::error!("[notes] 建文章 {}：写标签失败: {e}", inserted.id);
        let _ = txn.rollback().await;
        return write_error(&e);
    }
    match txn.commit().await {
        Ok(_) => Json(ApiResponse::success("Note created successfully".to_string())),
        Err(e) => {
            tracing::error!("[notes] 建文章：提交失败: {e}");
            write_error(&e)
        }
    }
}

fn write_error<T: Default>(e: &sea_orm::DbErr) -> Json<ApiResponse<T>> {
    if let sea_orm::DbErr::RecordNotFound(message) = e {
        if matches!(message.as_str(), "文章不存在" | "原文章已删除") {
            return Json(ApiResponse::error(message));
        }
    }
    tracing::error!(error = %e, "article transaction failed");
    Json(ApiResponse::error("操作结果未确认，请先查询实际状态后重试"))
}

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

    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return write_error(&e),
    };
    let (root, draft) = match drafts::locked_document(&txn, id).await {
        Ok(rows) => rows,
        Err(e) => return write_error(&e),
    };
    if from_editor {
        match drafts::document_version(&txn, &root, draft.as_ref()).await {
            Ok(version) if payload.expected_version.as_deref() == Some(&version) => {},
            Ok(_) => return drafts::conflict(),
            Err(e) => return write_error(&e),
        }
    }
    let note_data = if from_editor || id == root.id { Some(root) } else { draft };

    if let Some(n) = note_data {
        let target_id = n.id;
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
        if let Some(v) = payload.cover_fit { active_model.cover_fit = Set(Some(v.as_str().into())); }
        if let Some(v) = payload.carousel_fit { active_model.carousel_fit = Set(Some(v.as_str().into())); }
        if let Some(v) = payload.cover_zoom { active_model.cover_zoom = Set(Some(clamp_zoom(v))); }
        if let Some(v) = payload.carousel_focus_x { active_model.carousel_focus_x = Set(Some(clamp01(v))); }
        if let Some(v) = payload.carousel_focus_y { active_model.carousel_focus_y = Set(Some(clamp01(v))); }
        if let Some(v) = payload.carousel_zoom { active_model.carousel_zoom = Set(Some(clamp_zoom(v))); }
        if let Some(v) = payload.is_top { active_model.is_top = Set(Some(v)); }

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

        if let Err(e) = active_model.update(&txn).await {
            let _ = txn.rollback().await;
            return write_error(&e);
        }
        if new_tags.is_some() {
            if let Err(e) =
                note_tags::replace_note_tags(&txn, target_id, new_tags.as_deref()).await
            {
                tracing::error!("[notes] 更新文章 {target_id}：写标签失败: {e}");
                let _ = txn.rollback().await;
                return write_error(&e);
            }
        }
        if from_editor {
            if let Err(e) = note::Entity::delete_many()
                .filter(note::Column::DraftOf.eq(target_id)).exec(&txn).await {
                return write_error(&e);
            }
        }
        match txn.commit().await {
            Ok(_) => {
                Json(ApiResponse::success("Note updated successfully".to_string()))
            }
            Err(e) => {
                tracing::error!("[notes] 更新文章 {target_id}：提交失败: {e}");
                write_error(&e)
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
    let result=async {
        let txn=state.db.begin().await?;
        super::article_deletions::delete_current(&txn,&keys).await?;
        txn.commit().await?;
        Ok::<_,sea_orm::DbErr>("Deleted".to_owned())
    }.await;
    match result {
        Ok(value)=>Json(ApiResponse::success(value)),
        Err(error)=>super::db_error("删除文章",&error),
    }
}

pub async fn get_note_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Response {
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

async fn attach_authors(db: &sea_orm::DatabaseConnection, dtos: &mut [NoteDto]) {
    let ids: Vec<i32> = dtos.iter().filter_map(|d| d.author_id)
        .collect::<std::collections::HashSet<i32>>().into_iter().collect();
    if ids.is_empty() {
        return;
    }

    let by_id = match authors::profiles(db, ids).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error=%error, "public article attribution unavailable");
            return;
        }
    };
    let (site_name, site_avatar) = crate::routes::web_info::site_author(db).await;

    for dto in dtos.iter_mut() {
        match dto.author_id.and_then(|id| by_id.get(&id)) {
            Some(author) => {
                dto.author_name = Some(author.name.clone());
                dto.author_avatar = Some(author.avatar.clone());
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

pub(crate) mod drafts;
pub use drafts::{autosave_note, get_note_for_edit};


#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn 列表查询的_select_列表里没有正文() {
        use sea_orm::{DbBackend, PartialModelTrait, QuerySelect, QueryTrait};

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
