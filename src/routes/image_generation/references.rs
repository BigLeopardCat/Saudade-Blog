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
        source: ReferenceSource::Gallery { image_id: id },
        name: image.display_name.unwrap_or_else(|| format!("图片 {id}")),
        digest: digest(&bytes),
        preview_url: String::new(),
    };
    Ok((reference, mime.into(), bytes))
}

pub async fn conversation_snapshot(
    state: &AppState,
    uid: i32,
    cid: i32,
    role: &str,
    id: &str,
) -> Result<(Reference, String, Vec<u8>), DbErr> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let row = state
        .db
        .query_one(stmt(
            "SELECT i.data FROM chat_image i JOIN chat_history h ON h.id=i.message_id \
         JOIN conversation c ON c.id=h.conversation_id \
         WHERE c.id=$1 AND c.user_id=$2 AND h.user_id=$2 AND h.role='user' AND h.source_role=$3 \
         AND 'img_'||encode(sha256(convert_to(i.data,'UTF8')),'hex')=$4 LIMIT 1",
            vec![cid.into(), uid.into(), role.into(), id.into()],
        ))
        .await?
        .ok_or_else(|| error("聊天参考图不在当前身份和会话中"))?;
    let data: String = row.try_get("", "data")?;
    let (_, encoded) = data
        .split_once(";base64,")
        .ok_or_else(|| error("聊天图片格式无效"))?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| error("聊天图片编码无效"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(error("参考图片不能超过 10 MiB"));
    }
    let mime = match sniff_image_ext(&bytes) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return Err(error("参考图仅支持 PNG、JPEG、WebP")),
    };
    Ok((
        Reference {
            source: ReferenceSource::Conversation {
                image_id: id.into(),
            },
            name: "对话上传图片".into(),
            digest: digest(&bytes),
            preview_url: String::new(),
        },
        mime.into(),
        bytes,
    ))
}
