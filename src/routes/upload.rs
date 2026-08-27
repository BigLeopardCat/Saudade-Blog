use axum::{
    extract::{Multipart, State},
    Json,
};
use std::sync::Arc;
use crate::routes::AppState;
use crate::utils::{ApiResponse, upload_dir};
use std::path::Path;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use sea_orm::{ActiveModelTrait, EntityTrait, Set, QueryOrder, ColumnTrait, QueryFilter};
use crate::entity::image;

// POST /api/protect/upload
pub async fn upload_image(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Json<ApiResponse<String>> {
    let upload_dir = upload_dir();
    
    // Iterate over fields
    while let Ok(Some(field)) = multipart.next_field().await {
        // We look for a field that has a filename
        if let Some(file_name) = field.file_name() {
             let file_name = file_name.to_string();
             // Simple sanitization: only keep basename
             let file_name = Path::new(&file_name).file_name().unwrap_or_default().to_string_lossy().to_string();
             
             // Prepend timestamp to avoid collision（本地时区钟面，与 DB 时间约定一致）
             let timestamp = chrono::Local::now().format("%Y%m%d%H%M%S").to_string();
             let new_name = format!("{}_{}", timestamp, file_name);
             let file_path = upload_dir.join(&new_name);

             if let Ok(data) = field.bytes().await {
                 if let Ok(mut file) = fs::File::create(&file_path).await {
                     if let Ok(_) = file.write_all(&data).await {
                         // Use relative path matching the ServeDir route
                         let url = format!("/api/protect/download/{}", new_name);
                         
                         // Insert to DB
                         let new_image = image::ActiveModel {
                             image_url: Set(url.clone()),
                             ..Default::default()
                         };
                         let _ = new_image.insert(&state.db).await;

                         return Json(ApiResponse::success(url));
                     }
                 }
             }
        }
    }
    
    Json(ApiResponse::error("Upload failed"))
}

// GET /api/protect/images
pub async fn list_images(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<image::Model>>> {
    let images = image::Entity::find()
        .order_by_desc(image::Column::ImageKey)
        .all(&state.db)
        .await
        .unwrap_or_default();

    Json(ApiResponse::success(images))
}

// DELETE /api/protect/delImg
pub async fn delete_images(
    State(state): State<Arc<AppState>>,
    Json(urls): Json<Vec<String>>,
) -> Json<ApiResponse<String>> {
    let upload_dir = upload_dir();
    for url in urls {
        // Find in DB
        if let Ok(Some(img)) = image::Entity::find()
            .filter(image::Column::ImageUrl.eq(&url))
            .one(&state.db)
            .await 
        {
            // Delete file logic: Extract filename from URL
            let filename_opt = if let Some(part) = url.split("/upload/").nth(1) {
                Some(part) 
            } else if let Some(part) = url.split("/download/").nth(1) {
                Some(part)
            } else {
                None
            };

            if let Some(filename) = filename_opt {
                 if let Some(safe_name) = std::path::Path::new(filename).file_name() {
                     let path = upload_dir.join(safe_name);
                     let _ = tokio::fs::remove_file(path).await;
                 }
            }
            
            // Delete from DB
            let _ = image::Entity::delete_by_id(img.image_key).exec(&state.db).await;
        }
    }
    Json(ApiResponse::success("Deleted".to_string()))
}
