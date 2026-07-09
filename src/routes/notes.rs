use axum::{Json, extract::{State, Query, Path}};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, QueryOrder, Condition, ActiveModelTrait, Set, PaginatorTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{note, category};
use crate::routes::AppState;
use crate::utils::ApiResponse;

#[derive(Deserialize)]
pub struct NoteQuery {
    pub category_id: Option<i32>,
    pub page: Option<u64>,
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
    
    #[serde(rename = "createTime")]
    pub created_at: String,
    #[serde(rename = "updateTime")]
    pub updated_at: String,
    
    #[serde(rename = "isTop")]
    pub is_top: i32,
    pub status: String,
    
    // Corrected fields for frontend compatibility
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>, 
    #[serde(rename = "categoryTitle")]
    pub category_title: Option<String>,
    
    pub is_public: bool,
    #[serde(rename = "noteTags")]
    pub tags: String, 
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
        created_at: n.created_at.and_utc().with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()).format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: n.updated_at.and_utc().with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()).format("%Y-%m-%d %H:%M:%S").to_string(),
        is_top: n.is_top.unwrap_or(0),
        status: n.status.unwrap_or("published".to_string()),
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
    let page = query.page.unwrap_or(1);
    let per_page = query.page_size.unwrap_or(6) as u64;
    
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
    let notes = note::Entity::find()
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
        is_top: Set(payload.is_top),
        status: Set(Some(status_str)),
        created_at: Set(chrono::Utc::now().naive_utc()),
        updated_at: Set(chrono::Utc::now().naive_utc()),
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
    let note_data = note::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None);
    
    if let Some(n) = note_data {
        let mut active_model: note::ActiveModel = n.into();
        
        if let Some(v) = payload.title { active_model.title = Set(v); }
        if let Some(v) = payload.content { active_model.content = Set(v); }
        if let Some(v) = payload.category_id { active_model.category_id = Set(Some(v)); }
        
        if let Some(v) = payload.description { active_model.description = Set(Some(v)); }
        if let Some(v) = payload.cover { active_model.cover = Set(Some(v)); }
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

        active_model.updated_at = Set(chrono::Utc::now().naive_utc());
        
        match active_model.update(&state.db).await {
            Ok(_) => Json(ApiResponse::success("Note updated successfully".to_string())),
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
) -> Json<ApiResponse<Option<NoteDto>>> {
    let res = note::Entity::find_by_id(id)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);
    
    let dto = res.into_iter().next().map(|(n, cats)| {
        map_note(n, cats.into_iter().next())
    });

    Json(ApiResponse::success(dto))
}fn map_note_summary(n: note::Model, cat: Option<category::Model>) -> NoteDto {
    let mut dto = map_note(n, cat);
    dto.content = String::new();
    dto.content_raw = String::new();
    dto
}
