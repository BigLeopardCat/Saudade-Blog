use super::*;
use crate::utils::{sniff_image_ext, upload_dir};

pub async fn snapshot(
    state: &AppState,
    uid: i32,
    id: i32,
) -> Result<(Reference, String, Vec<u8>), DbErr> {
    let image = crate::routes::gallery::read(&state.db, uid, id).await?;
    let bytes = if let Some(name) = image.image_url.strip_prefix("/api/protect/download/") {
        if name.is_empty() || name.contains(['/', '\\', '%']) || name == "." || name == ".." {
            return Err(error("参考图片路径无效"));
        }
        let path = upload_dir().join(name);
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|_| error("参考图片不存在"))?;
        if !meta.is_file() || meta.len() > 10 * 1024 * 1024 {
            return Err(error("参考图片过大或不可读取"));
        }
        tokio::fs::read(path)
            .await
            .map_err(|_| error("参考图片不可读取"))?
    } else {
        let storage = crate::r2::load_config(&state.db).await;
        let url = reqwest::Url::parse(&image.image_url).map_err(|_| error("参考图片地址无效"))?;
        if storage.public_base.is_empty()
            || !image
                .image_url
                .starts_with(&(storage.public_base.trim_end_matches('/').to_owned() + "/"))
            || url.scheme() != "https"
            || !url.username().is_empty()
        {
            return Err(error("参考图片不在配置的图库存储中"));
        }
        let response = settings::Settings::client()
            .map_err(|_| error("图片客户端不可用"))?
            .get(url)
            .send()
            .await
            .map_err(|_| error("参考图片下载失败"))?;
        if !response.status().is_success() {
            return Err(error("参考图片下载失败"));
        }
        provider::limited(response, 10 * 1024 * 1024)
            .await
            .map_err(error)?
    };
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
