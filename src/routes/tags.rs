use axum::{Json, extract::State};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{tag_one, tag_two};
use crate::routes::AppState;
use crate::utils::ApiResponse;

#[derive(Serialize)]
pub struct TagOneDto {
    #[serde(rename = "tagKey")]
    pub id: i32,
    pub title: String,
    pub color: String,
    pub level: i32,
    // children not needed for getTagOne list as per frontend mapping?
    // Frontend maps manually?
    // "children: []" in frontend mapper implies it builds tree locally.
    // So simple list is fine.
}

#[derive(Serialize)]
pub struct TagTwoDto {
    #[serde(rename = "tagKey")]
    pub id: i32,
    pub title: String,
    pub color: String,
    pub level: i32,
    #[serde(rename = "fatherTag")]
    pub father_tag: String, 
}

pub async fn list_tags_one(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagOneDto>>> {
    let t1s = tag_one::Entity::find().all(&state.db).await.unwrap_or(vec![]);
    let dtos = t1s.into_iter().map(|t| TagOneDto {
        id: t.id,
        title: t.name,
        color: t.color.unwrap_or_default(),
        level: 1,
    }).collect();
    Json(ApiResponse::success(dtos))
}

pub async fn list_tags_two(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagTwoDto>>> {
     let t2s = tag_two::Entity::find().find_with_related(tag_one::Entity).all(&state.db).await.unwrap_or(vec![]);
     
     let dtos = t2s.into_iter().map(|(t2, t1s)| {
         let t1 = t1s.into_iter().next();
         let father_name = t1.as_ref().map(|x| x.name.clone()).unwrap_or_default();
         
         TagTwoDto {
             id: t2.id,
             title: t2.name,
             color: t2.color.unwrap_or_default(),
             level: 2,
             father_tag: father_name,
         }
     }).collect();
     
     Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertTagOne {
    pub title: String,
    pub color: String,
}

pub async fn create_tag_one(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTagOne>,
) -> Json<ApiResponse<String>> {
    let t = tag_one::ActiveModel {
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        ..Default::default()
    };
    tag_one::Entity::insert(t).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Created".to_string()))
}

#[derive(Deserialize)]
pub struct UpsertTagTwo {
    pub title: String,
    pub color: String,
    #[serde(rename = "fatherTag")]
    pub father_id: i32,
}

pub async fn create_tag_two(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTagTwo>,
) -> Json<ApiResponse<String>> {
    let t = tag_two::ActiveModel {
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        tag_one_id: Set(Some(payload.father_id)),
        ..Default::default()
    };
    tag_two::Entity::insert(t).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Created".to_string()))
}

pub async fn delete_tags(
    State(state): State<Arc<AppState>>,
    Json(keys): Json<Vec<i32>>,
) -> Json<ApiResponse<String>> {
    // Try delete from both? Or how to distinguish?
    // Assuming keys are IDs.
    // If we delete a Tag1, children Tag2s cascade? (Db constraint usually)
    // We'll try delete from both for now.
    
    let _ = tag_two::Entity::delete_many()
        .filter(tag_two::Column::Id.is_in(keys.clone()))
        .exec(&state.db)
        .await;
        
    let _ = tag_one::Entity::delete_many()
        .filter(tag_one::Column::Id.is_in(keys))
        .exec(&state.db)
        .await;
        
    Json(ApiResponse::success("Deleted".to_string()))
}

#[derive(Deserialize)]
pub struct UpdateTagOne {
    pub title: String,
    pub color: String,
}

pub async fn update_tag_one(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
    Json(payload): Json<UpdateTagOne>,
) -> Json<ApiResponse<String>> {
    use sea_orm::EntityTrait;
    
    let t = tag_one::ActiveModel {
        id: Set(id),
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        ..Default::default()
    };
    tag_one::Entity::update(t).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Updated".to_string()))
}

#[derive(Deserialize)]
pub struct UpdateTagTwo {
    pub title: String,
    pub color: String,
}

pub async fn update_tag_two(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
    Json(payload): Json<UpdateTagTwo>,
) -> Json<ApiResponse<String>> {
    use sea_orm::EntityTrait;
    
    let t = tag_two::ActiveModel {
        id: Set(id),
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        ..Default::default()
    };
    tag_two::Entity::update(t).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Updated".to_string()))
}
