use axum::{Json, extract::{State, Path}};
use sea_orm::{EntityTrait, ActiveModelTrait, Set, PaginatorTrait, ColumnTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{category, note};
use crate::routes::AppState;
use crate::utils::ApiResponse;

#[derive(Serialize)]
pub struct CategoryDto {
    #[serde(rename = "categoryKey")]
    pub category_key: i32, 

    #[serde(rename = "categoryTitle")]
    pub category_title: String,
    
    #[serde(rename = "pathName")]
    pub path_name: String,
    
    pub introduce: String,
    pub icon: String,
    pub color: String,
    
    #[serde(rename = "noteCount")]
    pub note_count: i64,
}

#[derive(Deserialize)]
pub struct CreateCategoryRequest {
    #[serde(rename = "categoryTitle")]
    pub category_title: Option<String>,
    
    #[serde(rename = "pathName")]
    pub path_name: Option<String>,
    
    pub introduce: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
}

pub async fn list_categories(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<CategoryDto>>> {
    let categories = category::Entity::find().all(&state.db).await.unwrap_or(vec![]);
    
    let mut dtos = Vec::new();
    for cat in categories {
        let count = note::Entity::find()
            .filter(note::Column::CategoryId.eq(cat.id))
            // 编辑修改稿（20260912c）不算数：它是「正在编辑某篇文章」时自动保存落下的影子行，
            // 编辑期间多出一行会让该分类计数凭空 +1（改完发布又 -1），与访客看到的文章数不符。
            .filter(note::Column::DraftOf.is_null())
            .count(&state.db)
            .await
            .unwrap_or(0);
            
        dtos.push(CategoryDto {
            category_key: cat.id,
            category_title: cat.name,
            path_name: cat.path_name.unwrap_or_default(),
            introduce: cat.introduce.unwrap_or_default(),
            icon: cat.icon.unwrap_or_default(),
            color: cat.color.unwrap_or_default(),
            note_count: count as i64, 
        });
    }

    Json(ApiResponse::success(dtos))
}

pub async fn create_category(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateCategoryRequest>,
) -> Json<ApiResponse<String>> {
    let name = payload.category_title.unwrap_or_else(|| "New Category".to_string());
    
    let new_cat = category::ActiveModel {
        name: Set(name),
        path_name: Set(payload.path_name),
        introduce: Set(payload.introduce),
        icon: Set(payload.icon),
        color: Set(payload.color),
        ..Default::default()
    };

    match new_cat.insert(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Category created".to_string())),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
    }
}

pub async fn update_category(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(payload): Json<CreateCategoryRequest>,
) -> Json<ApiResponse<String>> {
    let cat = category::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None);
    if let Some(c) = cat {
        let mut active: category::ActiveModel = c.into();
        
        if let Some(ref v) = payload.category_title {
            if !v.is_empty() {
                active.name = Set(v.clone());
            }
        }

        if let Some(ref v) = payload.path_name {
            if !v.is_empty() {
                active.path_name = Set(Some(v.clone()));
            }
        }
        
        if let Some(ref v) = payload.introduce {
            if !v.is_empty() {
                active.introduce = Set(Some(v.clone()));
            }
        }

        if let Some(ref v) = payload.icon {
             if !v.is_empty() {
                active.icon = Set(Some(v.clone()));
            }
        }

        if let Some(ref v) = payload.color {
             if !v.is_empty() {
                active.color = Set(Some(v.clone()));
            }
        }
        
        match active.update(&state.db).await {
            Ok(_) => Json(ApiResponse::success("Updated".to_string())),
            Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
        }
    } else {
        Json(ApiResponse::error("Not found"))
    }
}

pub async fn delete_category(
    State(state): State<Arc<AppState>>,
    Json(keys): Json<Vec<i32>>,
) -> Json<ApiResponse<String>> {
    match category::Entity::delete_many()
        .filter(category::Column::Id.is_in(keys))
        .exec(&state.db)
        .await {
        Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
    }
}
