//! Bound user content before quota consumption, conversation creation or persistence.
use super::ChatRequest;
use base64::{engine::general_purpose::STANDARD, Engine};
const MAX_TEXT_CHARS: usize = 32_768;
const MAX_IMAGES: usize = 6;
const MAX_IMAGE_BYTES: usize = 1024 * 1024;

pub(super) fn validate(payload: &ChatRequest) -> Result<(), &'static str> {
    if payload.message.chars().count() > MAX_TEXT_CHARS {
        return Err("消息最多 32768 个字符");
    }
    let Some(images) = &payload.image else {
        return Ok(());
    };
    if images.len() > MAX_IMAGES {
        return Err("每条消息最多 6 张图片");
    }
    for image in images {
        if image.len() > MAX_IMAGE_BYTES {
            return Err("每张图片的编码最多 1 MiB，请压缩后重试");
        }
        let (mime, encoded) = image
            .split_once(";base64,")
            .ok_or("图片须为 base64 编码的数据地址")?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "图片 base64 编码无效")?;
        let matches = match mime {
            "data:image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "data:image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "data:image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            "data:image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            _ => false,
        };
        if !matches {
            return Err("图片类型或文件头无效，仅支持 PNG、JPEG、WebP、GIF");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request(message: &str, image: Vec<String>) -> ChatRequest {
        serde_json::from_value(json!({"message": message, "image":image})).unwrap()
    }
    #[test]
    fn validates_count_size_encoding_and_type_without_fetching_urls() {
        let png = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture")
        );
        assert!(validate(&request("你好", vec![png.clone(); 6])).is_ok());
        for images in [
            vec![png; 7],
            vec!["https://127.0.0.1/internal".into()],
            vec!["data:image/png;base64,%%%".into()],
            vec!["data:image/png;base64,aGVsbG8=".into()],
            vec![format!(
                "data:image/png;base64,{}",
                "a".repeat(MAX_IMAGE_BYTES)
            )],
            vec!["data:image/svg+xml;base64,PHN2Zz4=".into()],
        ] {
            assert!(validate(&request("test", images)).is_err());
        }
        assert!(validate(&request(&"字".repeat(MAX_TEXT_CHARS), vec![])).is_ok());
        assert!(validate(&request(&"字".repeat(MAX_TEXT_CHARS + 1), vec![])).is_err());
        assert!(
            validate(&request("", vec![])).is_ok(),
            "control requests may have empty text"
        );
    }
}
