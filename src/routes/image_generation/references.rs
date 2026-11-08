use super::*;
use crate::utils::sniff_image_ext;

pub async fn snapshot(
    state: &AppState,
    uid: i32,
    id: i32,
) -> Result<(Reference, String, Vec<u8>), DbErr> {
    let image = crate::routes::gallery::read(&state.db, uid, id).await?;
    let location = crate::routes::gallery::storage::resolve(&state.db, &image).await?;
    let bytes = crate::routes::gallery::storage::read(&state.db, &location)
        .await?
        .to_vec();
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(error("参考图片不能超过 10 MiB"));
    }
    let mime = match sniff_image_ext(&bytes) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return Err(error("参考图仅支持 PNG、JPEG、WebP")),
    };
    let reference = Reference {
        image_id: id,
        name: image.display_name.unwrap_or_else(|| format!("图片 {id}")),
        digest: digest(&bytes),
        preview_url: String::new(),
    };
    Ok((reference, mime.into(), bytes))
}
