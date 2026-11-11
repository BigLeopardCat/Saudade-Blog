pub mod admin_list;
pub(crate) mod authors;

use crate::entity::{category, note};
use crate::routes::note_tags::{self, attach_tags};
use crate::routes::AppState;
use crate::search_core::{
    count_terms, keyword_given, keyword_prefilter, score_term_sum, split_terms,
};
use crate::utils::ApiResponse;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseConnection,
    DerivePartialModel, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Public status values include the database default `published`, normalized to `public`.
pub(crate) fn public_status_words() -> Vec<String> {
    vec!["public".to_string(), "published".to_string()]
}

/// Public articles are published roots, never editor shadow drafts.
pub(crate) fn public_condition() -> Condition {
    Condition::all()
        .add(note::Column::IsPublic.eq(true))
        .add(note::Column::Status.is_in(public_status_words()))
        .add(note::Column::DraftOf.is_null())
}

/// Parse known article states; unknown values must be rejected before persistence.
fn normalize_status_word(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "public" | "published" => Some("public"),
        "private" => Some("private"),
        "draft" => Some("draft"),
        _ => None,
    }
}

/// Check visibility before or after status normalization.
fn status_is_publicish(word: &str) -> bool {
    matches!(word, "public" | "published")
}

#[derive(Deserialize)]
pub struct NoteQuery {
    pub category_id: Option<i32>,
    pub page: Option<u64>,
    // Accept pageSize and page_size while preserving category_id.
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
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

fn clamp_zoom(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(1.0, 4.0)
    } else {
        1.0
    }
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
        // Author details are attached by one batch query; mapping itself performs no I/O.
        author_id: n.user_id,
        author_name: None,
        author_avatar: None,
        // Statistics are attached to list responses, not repeatedly fetched for article details.
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
    /// Reuse the canonical DTO mapper without loading article bodies for lists.
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

async fn category_names<C: ConnectionTrait>(
    db: &C,
    ids: impl Iterator<Item = i32>,
) -> Result<HashMap<i32, String>, sea_orm::DbErr> {
    let ids: Vec<i32> = ids
        .collect::<std::collections::HashSet<i32>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = category::Entity::find()
        .select_only()
        .column(category::Column::Id)
        .column(category::Column::Name)
        .filter(category::Column::Id.is_in(ids))
        .into_tuple::<(i32, String)>()
        .all(db)
        .await?;
    Ok(rows.into_iter().collect())
}

/// Map summaries with a category only when its referenced row exists.
fn summary_to_dto(r: NoteSummary, cats: &HashMap<i32, String>) -> NoteDto {
    let cat = r
        .category_id
        .and_then(|id| cats.get(&id).map(|n| (id, n.clone())));
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

    condition = condition.add(public_condition());

    // Zero page size is invalid; archive requests may fetch up to 1000 summaries.
    let page = query.page.unwrap_or(1).max(1);
    let per_page = query.page_size.unwrap_or(6).clamp(1, 1000) as u64;

    let notes = note::Entity::find()
        .filter(condition)
        .order_by_desc(note::Column::CreatedAt)
        .order_by_desc(note::Column::Id)
        // Select summary columns only; category names are attached in one batch query.
        .into_partial_model::<NoteSummary>()
        .paginate(&state.db, per_page)
        .fetch_page(page - 1)
        .await;
    let notes = match notes {
        Ok(rows) => rows,
        Err(error) => return crate::routes::db_error("公开文章列表", &error),
    };

    let cats = match category_names(&state.db, notes.iter().filter_map(|r| r.category_id)).await {
        Ok(rows) => rows,
        Err(error) => return crate::routes::db_error("文章分类", &error),
    };
    let mut dtos: Vec<NoteDto> = notes
        .into_iter()
        .map(|r| summary_to_dto(r, &cats))
        .collect();
    attach_tags(&state.db, &mut dtos).await;
    attach_stats(&state.db, &mut dtos).await;
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
        // An omitted keyword does not restrict the result set.
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
        let cats = match category_names(&state.db, rows.iter().filter_map(|r| r.category_id)).await
        {
            Ok(rows) => rows,
            Err(error) => return crate::routes::db_error("文章分类", &error),
        };
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

pub async fn get_top_notes(State(state): State<Arc<AppState>>) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();
    condition = condition.add(note::Column::IsTop.eq(1));
    condition = condition.add(public_condition());

    let notes = note::Entity::find()
        .filter(condition)
        .into_partial_model::<NoteSummary>()
        .all(&state.db)
        .await;
    let notes = match notes {
        Ok(rows) => rows,
        Err(error) => return crate::routes::db_error("置顶文章列表", &error),
    };

    let cats = match category_names(&state.db, notes.iter().filter_map(|r| r.category_id)).await {
        Ok(rows) => rows,
        Err(error) => return crate::routes::db_error("文章分类", &error),
    };
    let mut dtos: Vec<NoteDto> = notes
        .into_iter()
        .map(|r| summary_to_dto(r, &cats))
        .collect();
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
    // Record the authenticated publisher; missing attribution stays unknown.
    let author = crate::auth_jwt::auth_uid(&state.db, &headers).await.ok();

    let status_word = match payload.status.as_deref() {
        Some(raw) => match normalize_status_word(raw) {
            Some(w) => w,
            None => return Json(ApiResponse::error("文章状态不合法")),
        },
        None => "public",
    };
    let is_public = status_is_publicish(status_word) && payload.is_public.unwrap_or(true);

    // Tag associations and their cached representation are written only by replace_note_tags.
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
        cover_fit: Set(Some(
            payload.cover_fit.unwrap_or(CoverFit::Cover).as_str().into(),
        )),
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

    // Article content and tag associations commit atomically.
    let txn = match state
        .db
        .begin_with_config(Some(sea_orm::IsolationLevel::ReadCommitted), None)
        .await
    {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[notes] 建文章：开启事务失败: {e}");
            return Json(ApiResponse::error("Error: 数据库不可用"));
        }
    };
    if let Err(error) = crate::routes::gallery::references::guard_model(&txn, &new_note).await {
        return write_error(&error);
    }
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
        Ok(_) => Json(ApiResponse::success(
            "Note created successfully".to_string(),
        )),
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
    // Capture editor publication intent before moving the individual payload fields.
    let from_editor = payload.title.is_some() || payload.content.is_some();
    // Omitted tags preserve associations; an explicit empty list clears them.
    let new_tags = payload.tags.clone();

    let txn = match state
        .db
        .begin_with_config(Some(sea_orm::IsolationLevel::ReadCommitted), None)
        .await
    {
        Ok(t) => t,
        Err(e) => return write_error(&e),
    };
    let (root, draft) = match drafts::locked_document(&txn, id).await {
        Ok(rows) => rows,
        Err(e) => return write_error(&e),
    };
    if from_editor {
        match drafts::document_version(&txn, &root, draft.as_ref()).await {
            Ok(version) if payload.expected_version.as_deref() == Some(&version) => {}
            Ok(_) => return drafts::conflict(),
            Err(e) => return write_error(&e),
        }
    }
    let note_data = if from_editor || id == root.id {
        Some(root)
    } else {
        draft
    };

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

        if let Some(v) = payload.title {
            active_model.title = Set(v);
        }
        if let Some(v) = payload.content {
            active_model.content = Set(v);
        }
        if let Some(v) = payload.category_id {
            active_model.category_id = Set(Some(v));
        }

        if let Some(v) = payload.description {
            active_model.description = Set(Some(v));
        }
        if let Some(v) = payload.cover {
            active_model.cover = Set(Some(v));
        }
        if let Some(v) = payload.cover_focus_x {
            active_model.cover_focus_x = Set(Some(clamp01(v)));
        }
        if let Some(v) = payload.cover_focus_y {
            active_model.cover_focus_y = Set(Some(clamp01(v)));
        }
        if let Some(v) = payload.cover_fit {
            active_model.cover_fit = Set(Some(v.as_str().into()));
        }
        if let Some(v) = payload.carousel_fit {
            active_model.carousel_fit = Set(Some(v.as_str().into()));
        }
        if let Some(v) = payload.cover_zoom {
            active_model.cover_zoom = Set(Some(clamp_zoom(v)));
        }
        if let Some(v) = payload.carousel_focus_x {
            active_model.carousel_focus_x = Set(Some(clamp01(v)));
        }
        if let Some(v) = payload.carousel_focus_y {
            active_model.carousel_focus_y = Set(Some(clamp01(v)));
        }
        if let Some(v) = payload.carousel_zoom {
            active_model.carousel_zoom = Set(Some(clamp_zoom(v)));
        }
        if let Some(v) = payload.is_top {
            active_model.is_top = Set(Some(v));
        }

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
        // Metadata-only updates retain visibility.
        if requested_word.is_some() || payload.is_public.is_some() {
            // Absent visibility is private; provided public and status values must agree.
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

        if let Err(error) =
            crate::routes::gallery::references::guard_model(&txn, &active_model).await
        {
            return write_error(&error);
        }
        if let Err(e) = active_model.update(&txn).await {
            let _ = txn.rollback().await;
            return write_error(&e);
        }
        if new_tags.is_some() {
            if let Err(e) = note_tags::replace_note_tags(&txn, target_id, new_tags.as_deref()).await
            {
                tracing::error!("[notes] 更新文章 {target_id}：写标签失败: {e}");
                let _ = txn.rollback().await;
                return write_error(&e);
            }
        }
        if from_editor {
            if let Err(e) = note::Entity::delete_many()
                .filter(note::Column::DraftOf.eq(target_id))
                .exec(&txn)
                .await
            {
                return write_error(&e);
            }
        }
        match txn.commit().await {
            Ok(_) => Json(ApiResponse::success(
                "Note updated successfully".to_string(),
            )),
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
    let result = async {
        let txn = state.db.begin().await?;
        super::article_deletions::delete_current(&txn, &keys).await?;
        txn.commit().await?;
        Ok::<_, sea_orm::DbErr>("Deleted".to_owned())
    }
    .await;
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => super::db_error("删除文章", &error),
    }
}

pub async fn get_note_detail(State(state): State<Arc<AppState>>, Path(id): Path<i32>) -> Response {
    let res = match note::Entity::find_by_id(id)
        .filter(public_condition())
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                super::db_error::<Option<NoteDto>>("读取文章", &error),
            )
                .into_response()
        }
    };

    // 详情页头部同样按**文章作者**渲染（与卡片同一份判据，不是站点主人）
    let mut dtos: Vec<NoteDto> = res
        .into_iter()
        .next()
        .map(|(n, cats)| map_note(n, cats.into_iter().next().map(|c| (c.id, c.name))))
        .into_iter()
        .collect();
    attach_tags(&state.db, &mut dtos).await;
    attach_authors(&state.db, &mut dtos).await;
    let dto = dtos.into_iter().next();

    match dto {
        Some(dto) => (StatusCode::OK, Json(ApiResponse::success(dto))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                code: 404,
                message: "文章不存在".to_string(),
                data: Option::<NoteDto>::None,
            }),
        )
            .into_response(),
    }
}
fn map_note_summary(n: note::Model, cat: Option<(i32, String)>) -> NoteDto {
    let mut dto = map_note(n, cat);
    dto.content = String::new();
    dto.content_raw = String::new();
    dto
}

async fn attach_authors(db: &sea_orm::DatabaseConnection, dtos: &mut [NoteDto]) {
    let ids: Vec<i32> = dtos
        .iter()
        .filter_map(|d| d.author_id)
        .collect::<std::collections::HashSet<i32>>()
        .into_iter()
        .collect();
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
        assert!(
            should_backfill_author(true, true),
            "老文章第一次被编辑器保存 ⇒ 补上作者"
        );
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

        let sql =
            <NoteSummary as PartialModelTrait>::select_cols(note::Entity::find().select_only())
                .build(DbBackend::Postgres)
                .sql;
        assert!(
            sql.contains("\"title\""),
            "标题在（不然这条判据连自己都没在测）：{sql}"
        );
        assert!(
            !sql.contains("\"content\""),
            "列表查询又把正文读回来了 —— 见 NoteSummary 头注：这是唯一随语料线性增长的读放大。SQL={sql}"
        );
        // `content_raw` 不是列名（DTO 才叫这个），防的是有人误把它当列加进 partial。
        assert!(!sql.contains("content_raw"), "SQL={sql}");

        // A full-model query must still include content, validating the negative control.
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
        assert_eq!(
            normalize_status_word("published"),
            Some("public"),
            "别名归一"
        );
        assert_eq!(normalize_status_word("private"), Some("private"));
        assert_eq!(normalize_status_word("draft"), Some("draft"));
        assert_eq!(
            normalize_status_word("  public  "),
            Some("public"),
            "两侧空白不算词的一部分"
        );
        // Unknown values cannot enter the persisted status vocabulary.
        assert_eq!(normalize_status_word("archived"), None);
        assert_eq!(
            normalize_status_word("Public"),
            None,
            "大小写敏感，不做模糊匹配"
        );
        assert_eq!(normalize_status_word(""), None);
        // 公开档的判定：归一之后只剩 public，但 published 也得算公开（归一之前也会问）。
        assert!(status_is_publicish("public") && status_is_publicish("published"));
        assert!(!status_is_publicish("private") && !status_is_publicish("draft"));
        // 白名单就是这两个词 —— 与上面 `is_in` 谓词喂的是同一份。
        assert_eq!(
            public_status_words(),
            vec!["public".to_string(), "published".to_string()]
        );
    }
}
