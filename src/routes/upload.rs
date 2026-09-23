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
use sha2::{Digest, Sha256};

// ── 同一份字节重复上传 ⇒ 复用已有文件（20260924，用户拍板的 A 方案）─────────────
// 事故现象：博主在文章里"用一张图库里已有的图"，图库里就多出一张重复的图。
// 根因有两条，缺一不可：
//   ① 正文插图只有一条通道 = bytemd 的 uploadImages → 本接口（前端有"从图库选图"
//      的入口，但只接了封面，见 NewNotes 的 selectGalleryImage）；
//   ② 本接口对任何一次 POST 都**无条件**落新文件 + 无条件 INSERT 一行，因为文件名
//      带了秒级时间戳前缀，同一张图重传永不重名、也永远查不出重复。
// 于是"复用"实际变成"再上传一份"。取证：uploads/ 里 EMQX.png 有 4 份、agent_2.png
// 有 2 份，md5 逐字节相同、只有时间戳前缀不同。
//
// 现在的判据 = **字节相同就复用**（sha256 比对已有文件），不写盘、不新增行，
// 直接把已有 URL 还回去 —— 前端零改动、表结构零改动，一次覆盖正文/封面/图库页
// 三条上传路径。
//
// 已知盲区（不要当 bug 报）：
//   · 只按**原始文件名**筛候选（`{14位时间戳}_原名` 去掉前缀后同名）再比内容。
//     这是为了避免每次上传都把整个 uploads/ 读一遍算哈希（文件数会一直涨）；
//     代价是"同一张图改了文件名再传"仍会存两份。要连那种也去掉，把
//     `strip_timestamp_prefix` 那道 continue 删掉即可（当前目录规模下开销可忽略）。
//   · 封面/图库页上传会先经前端 `ImageCompression` 压成 800×600 q0.7（有损），
//     同一张原图走"正文（不压缩）"与"封面（压缩）"两条路会得到**不同字节**，
//     哈希不同 ⇒ 去不掉，这是有损编码的固有结果，不是判据漏洞。
//   · 历史重复行不清理（要清得先读库看引用，本批不动存量）。

/// 一次上传的候选筛选用：把 `20260912013218_EMQX.png` 还原成 `EMQX.png`。
/// 不是"时间戳_原名"形状的原样返回（手工放进 uploads/ 的文件也算候选）。
fn strip_timestamp_prefix(name: &str) -> &str {
    let bytes = name.as_bytes();
    // 14 位数字 + 下划线；前 15 字节全是 ASCII ⇒ 这里一定是字符边界
    if bytes.len() > 15 && bytes[14] == b'_' && bytes[..14].iter().all(|b| b.is_ascii_digit()) {
        &name[15..]
    } else {
        name
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// 在 uploads/ 里找一份与 `digest` 逐字节相同的已有文件，返回它的站内 URL。
async fn find_duplicate_url(dir: &Path, file_name: &str, digest: &str) -> Option<String> {
    let mut entries = fs::read_dir(dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if strip_timestamp_prefix(&name) != file_name {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()).await else { continue };
        if sha256_hex(&bytes) == digest {
            return Some(format!("/api/protect/download/{}", name));
        }
    }
    None
}

/// 表盘一致：复用盘上已有文件时，若 `images` 里还没有指向它的行，补一条。
/// （盘上有文件而表里没行是可能的——早年上传不落库时留下的存量。）
async fn ensure_image_row(state: &Arc<AppState>, url: &str) {
    let exists = image::Entity::find()
        .filter(image::Column::ImageUrl.eq(url))
        .one(&state.db)
        .await
        .ok()
        .flatten()
        .is_some();
    if !exists {
        let _ = image::ActiveModel {
            image_url: Set(url.to_string()),
            ..Default::default()
        }
        .insert(&state.db)
        .await;
    }
}

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
                 // 命中已有文件 = 这次上传根本不需要发生：不写盘、不新增行
                 let digest = sha256_hex(&data);
                 if let Some(existing) = find_duplicate_url(&upload_dir, &file_name, &digest).await {
                     ensure_image_row(&state, &existing).await;
                     return Json(ApiResponse::success(existing));
                 }

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
