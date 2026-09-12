use axum::{Json, extract::{State, Query, Path}, http::StatusCode, response::{IntoResponse, Response}};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, QueryOrder, Condition, ActiveModelTrait, Set, PaginatorTrait, ActiveValue::NotSet};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{note, category};
use crate::routes::AppState;
use crate::utils::ApiResponse;

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
}

/// 封面裁剪参数兜底：焦点归一化到 0..1，缩放夹在 1..4；NaN/inf 等脏值退回默认。
fn clamp01(v: f64) -> f64 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.5 }
}

fn clamp_zoom(v: f64) -> f64 {
    if v.is_finite() { v.clamp(1.0, 4.0) } else { 1.0 }
}

fn map_note(n: note::Model, cat: Option<category::Model>) -> NoteDto {
    let cat_id = cat.as_ref().map(|c| c.id);
    let cat_name = cat.map(|c| c.name);
    
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
        tags: n.tags.unwrap_or_default(),
    }
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
    condition = condition.add(note::Column::IsPublic.eq(true));
    condition = condition.add(note::Column::Status.ne("draft"));

    // PAGINATION LOGIC
    // page.max(1)：page=0 时 `page - 1` 会 u64 下溢（release 环绕成 u64::MAX → 静默空页）。
    // page_size 夹到 1..1000：0 会让 sea-orm paginator panic（`page_size should not be zero`，
    // 公网无鉴权接口可被任意触发，logs/rust.log 有实证）；上限留 1000 是因为 Times 归档页
    // 用 page_size=999 一次拉全量（夹到常见分页值会让归档静默截断）。
    let page = query.page.unwrap_or(1).max(1);
    let per_page = query.page_size.unwrap_or(6).clamp(1, 1000) as u64;

    let paginator = note::Entity::find()
        .filter(condition)
        .order_by_desc(note::Column::CreatedAt)
        .find_also_related(category::Entity)
        .paginate(&state.db, per_page);

    let notes = paginator
        .fetch_page(page - 1)
        .await
        .unwrap_or(vec![]);

    let dtos = notes.into_iter().map(|(n, cat)| {
        map_note_summary(n, cat)
    }).collect();

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
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let dtos = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();

    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct SearchRequest {
    pub keyword: Option<String>,
    pub categories: Option<String>,
    pub status: Option<String>,
    // NEW FILTERS ADDED
    pub is_top: Option<i32>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

pub async fn search_notes(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();

    // PUBLIC SAFEGUARDS
    condition = condition.add(note::Column::IsPublic.eq(true));
    condition = condition.add(note::Column::Status.ne("draft"));

    if let Some(ref k) = payload.keyword {
         if !k.is_empty() {
             condition = condition.add(
                Condition::any()
                    .add(note::Column::Title.contains(k))
                    .add(note::Column::Content.contains(k)).add(note::Column::Tags.contains(k))
             );
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
    
    // Public search likely doesn't need detailed time/top status filters, but no harm logic-wise. 
    // They are omitted here for simplicity and focus on keyword search.

    let notes = note::Entity::find()
        .filter(condition)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let dtos = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();

    Json(ApiResponse::success(dtos))
}

pub async fn search_all_notes(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();
    
    // NO PUBLIC SAFEGUARDS (Admin Route)

    if let Some(ref k) = payload.keyword {
         if !k.is_empty() {
             condition = condition.add(
                Condition::any()
                    .add(note::Column::Title.contains(k))
                    .add(note::Column::Content.contains(k)).add(note::Column::Tags.contains(k))
             );
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

    let notes = note::Entity::find()
        .filter(condition)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let dtos = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();

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
    condition = condition.add(note::Column::IsPublic.eq(true));
    condition = condition.add(note::Column::Status.ne("draft"));

    let notes = note::Entity::find()
        .filter(condition)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

     let dtos = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();

    Json(ApiResponse::success(dtos))
}

pub async fn create_note(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertNoteRequest>,
) -> Json<ApiResponse<String>> {
    let title = payload.title.unwrap_or_else(|| "Untitled".to_string());
    let content = payload.content.unwrap_or_default();
    
    // Determine is_public logic
    let mut is_public = payload.is_public.unwrap_or(true);
    let status_str = payload.status.clone().unwrap_or("published".to_string());
    
    if status_str == "draft" || status_str == "private" {
        is_public = false;
    }
    
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
        status: Set(Some(status_str)),
        created_at: Set(chrono::Local::now().naive_local()),
        updated_at: Set(chrono::Local::now().naive_local()),
        tags: Set(payload.tags),
        ..Default::default()
    };

    match new_note.insert(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Note created successfully".to_string())),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
    }
}

pub async fn update_note(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(payload): Json<UpsertNoteRequest>,
) -> Json<ApiResponse<String>> {
    // 是不是「从编辑器提交的完整发布」：编辑器一定同时带 noteTitle + noteContent。
    // 在字段被逐个 move 进 active_model 之前先判定。
    let from_editor = payload.title.is_some() || payload.content.is_some();

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
        let mut active_model: note::ActiveModel = n.into();

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
        if let Some(v) = payload.tags { active_model.tags = Set(Some(v)); }
        
        // Handle Status and Visibility logic
        if let Some(v) = payload.status.clone() { 
            active_model.status = Set(Some(v.clone()));
            if v == "public" || v == "published" {
                 active_model.is_public = Set(true);
            } else if v == "private" || v == "draft" {
                 active_model.is_public = Set(false);
            }
        }
        
        // If explicit is_public is passed, it overrides (or cooperates)
        if let Some(v) = payload.is_public { active_model.is_public = Set(v); }
        
        // Double check consistency if status was updated
        if let Some(status_val) = payload.status {
             if status_val == "draft" || status_val == "private" {
                 active_model.is_public = Set(false);
             }
        }

        active_model.updated_at = Set(chrono::Local::now().naive_local());
        
        match active_model.update(&state.db).await {
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
            Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
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
    let res = note::Entity::find_by_id(id)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let dto = res.into_iter().next().map(|(n, cats)| {
        map_note(n, cats.into_iter().next())
    });

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
}fn map_note_summary(n: note::Model, cat: Option<category::Model>) -> NoteDto {
    let mut dto = map_note(n, cat);
    dto.content = String::new();
    dto.content_raw = String::new();
    dto
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

    // 克隆原行做修改稿（id 交给自增），内容随后由 payload 覆盖
    let mut am: note::ActiveModel = n.into();
    am.id = NotSet;
    am.draft_of = Set(Some(id));
    am.status = Set(Some("draft".to_string()));
    am.is_public = Set(false);
    am.created_at = Set(now);
    am.updated_at = Set(now);
    am.insert(&state.db)
        .await
        .map_err(|e| format!("Create revision failed: {}", e))
}

pub async fn autosave_note(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AutosaveDraftRequest>,
) -> Json<ApiResponse<AutosaveDraftResult>> {
    let client_id = payload.id;

    let target = match resolve_autosave_target(&state, payload.id).await {
        Ok(t) => t,
        Err(e) => return Json(ApiResponse::error(&e)),
    };

    let is_revision = target.draft_of.is_some();
    let mut am: note::ActiveModel = target.into();

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
    if let Some(v) = payload.tags { am.tags = Set(Some(v)); }
    // status / is_public 一律不动：写的一定是草稿（原行是草稿，克隆出来的修改稿也是草稿），
    // 发布是 update_note 的事。
    am.updated_at = Set(chrono::Local::now().naive_local());

    match am.update(&state.db).await {
        Ok(saved) => Json(ApiResponse::success(AutosaveDraftResult {
            id: client_id.unwrap_or(saved.id),
            draft_id: saved.id,
            is_revision,
            update_time: saved.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        })),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
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

    let dto = EditorNoteDto {
        note: map_note(note_row, note_cats.into_iter().next()),
        draft: draft_row.map(|(d, cats)| map_note(d, cats.into_iter().next())),
    };

    (StatusCode::OK, Json(ApiResponse::success(dto))).into_response()
}
