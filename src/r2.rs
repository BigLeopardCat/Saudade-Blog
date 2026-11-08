//! Optional R2 configuration and the object_store S3 adapter.
use futures::TryStreamExt;
use object_store::{
    aws::AmazonS3Builder, path::Path, ClientOptions, ObjectStore, ObjectStoreExt, RetryConfig,
};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// 图库配置使用的 web_info 键集合。
pub const R2_KEYS: [&str; 5] = [
    "r2ImageBucket",
    "r2ImagePrefix",
    "r2ImagePublicBase",
    "r2ImageQuotaGB",
    "r2ImageEnabled",
];

/// 缺失或无效配额的默认 GiB 上限。
pub const DEFAULT_QUOTA_GB: f64 = 9.5;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// 图库 R2 的配置面（不含凭据）。
#[derive(Debug, Clone, PartialEq)]
pub struct R2Config {
    /// Enables R2 for new uploads when the remaining settings are valid.
    pub enabled: bool,
    pub bucket: String,
    /// 对象键命名空间，归一后两端无斜杠；空值视为未配置。
    pub prefix: String,
    /// 公开访问域名（归一后无尾 `/`，必须 `http(s)://`）。
    pub public_base: String,
    /// Upload quota in bytes.
    pub quota_bytes: u64,
}

impl Default for R2Config {
    fn default() -> Self {
        Self {
            enabled: false,
            bucket: String::new(),
            prefix: String::new(),
            public_base: String::new(),
            quota_bytes: (DEFAULT_QUOTA_GB * GIB) as u64,
        }
    }
}

impl R2Config {
    /// 开关、桶、命名空间及公开地址均有效时启用 R2。
    pub fn active(&self) -> bool {
        self.enabled
            && !self.bucket.is_empty()
            && !self.prefix.is_empty()
            && !self.public_base.is_empty()
    }
}

/// 纯配置解析；缺失或无效字段使用默认值，true 不区分大小写。
pub fn parse_config(get: impl Fn(&str) -> Option<String>) -> R2Config {
    let raw = |key: &str| get(key).unwrap_or_default();
    let d = R2Config::default();
    R2Config {
        enabled: raw(R2_KEYS[4]).trim().eq_ignore_ascii_case("true"),
        bucket: raw(R2_KEYS[0]).trim().to_string(),
        prefix: normalize_prefix(&raw(R2_KEYS[1])),
        public_base: normalize_base(&raw(R2_KEYS[2])).unwrap_or_default(),
        quota_bytes: parse_quota_bytes(&raw(R2_KEYS[3]), d.quota_bytes),
    }
}

/// Invalid or non-positive quota values use the configured default.
fn parse_quota_bytes(raw: &str, fallback: u64) -> u64 {
    match raw.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && v > 0.0 => (v * GIB) as u64,
        _ => fallback,
    }
}

/// Missing keys use configuration defaults; database failures remain errors.
pub async fn load_config<C: ConnectionTrait>(db: &C) -> Result<R2Config, DbErr> {
    let rows = crate::entity::web_info::Entity::find()
        .filter(crate::entity::web_info::Column::KeyName.is_in(R2_KEYS.to_vec()))
        .all(db)
        .await?;
    let map: HashMap<String, String> = rows.into_iter().map(|r| (r.key_name, r.value)).collect();
    Ok(parse_config(|k| map.get(k).cloned()))
}

// 归一化 / 键 / URL（纯函数）

/// 前缀归一：去两端空白与 `/`。`"/gallery/"` ⇒ `"gallery"`。
pub fn normalize_prefix(raw: &str) -> String {
    raw.trim().trim_matches('/').trim().to_string()
}

/// 公开地址必须使用 HTTP(S)，可包含路径；移除尾斜杠。
pub fn normalize_base(raw: &str) -> Option<String> {
    let t = raw.trim().trim_end_matches('/').trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        // scheme 之后必须还有东西（`https://` 本身不是域名）
        let rest = t.splitn(2, "://").nth(1).unwrap_or("");
        if rest.trim_matches('/').is_empty() {
            return None;
        }
        Some(t.to_string())
    } else {
        None
    }
}

pub fn sanitize_file_name(raw: &str) -> String {
    // 只保留安全文件名，不允许路径分隔符创建额外层级。
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        match ch {
            '#' | '?' | '%' | '"' | '<' | '>' | '|' | ':' | '*' | '\n' | '\r' | '\t' | ' ' => {
                out.push('_')
            }
            c if (c as u32) < 0x20 => out.push('_'),
            c => out.push(c),
        }
    }
    // 限制文件名长度以控制对象键和日志规模。
    let trimmed: String = out.chars().take(120).collect();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        "image".to_string()
    } else {
        trimmed
    }
}

/// Provider URL for a storage key; gallery identities use the media route.
pub fn public_url(base: &str, key: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), key)
}

/// 只解析当前公开地址下的对象键，无法匹配时返回 None。
pub fn r2_key_of(url: &str, cfg: &R2Config) -> Option<String> {
    if cfg.public_base.is_empty() {
        return None;
    }
    let rest = url.strip_prefix(cfg.public_base.as_str())?;
    let key = rest.strip_prefix('/')?;
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

/// 仅在 used + incoming 超过上限时拒绝；饱和相加避免整数回绕。
pub fn quota_exceeded(used: u64, incoming: u64, limit: u64) -> bool {
    used.saturating_add(incoming) > limit
}

pub const IMAGE_ENV_KEYS: [&str; 3] = [
    "R2_IMAGE_ENDPOINT",
    "R2_IMAGE_ACCESS_KEY",
    "R2_IMAGE_SECRET_KEY",
];
pub const DEPLOY_ENV_KEYS: [&str; 3] = ["R2_ENDPOINT", "R2_ACCESS_KEY", "R2_SECRET_KEY"];
#[derive(Clone)]
pub struct Creds {
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    pub image_token: bool,
}
/// 逐项优先使用 R2_IMAGE_*，否则回落 R2_*；缺少必需凭据时返回 None。
pub fn creds_from(get: impl Fn(&str) -> Option<String>) -> Option<Creds> {
    // 逐项回落。返回 (值, 是否来自 R2_IMAGE_*)
    let pick = |i: usize| {
        let from_image = get(IMAGE_ENV_KEYS[i]).map(|v| v.trim().to_string());
        match from_image {
            Some(v) if !v.is_empty() => Some((v, true)),
            _ => get(DEPLOY_ENV_KEYS[i])
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .map(|v| (v, false)),
        }
    };
    let (endpoint, ep_image) = pick(0)?;
    let (access_key, ak_image) = pick(1)?;
    let (secret_key, sk_image) = pick(2)?;

    // 图库专用与部署凭据混用时记录配置警告，不输出凭据。
    if ak_image != sk_image {
        tracing::warn!(
            "[r2] 凭据混搭：access key 来自 {}，secret 来自 {} —— 请成对配置（否则签名必失败）",
            if ak_image {
                IMAGE_ENV_KEYS[1]
            } else {
                DEPLOY_ENV_KEYS[1]
            },
            if sk_image {
                IMAGE_ENV_KEYS[2]
            } else {
                DEPLOY_ENV_KEYS[2]
            },
        );
    }

    let endpoint = endpoint.trim_end_matches('/').to_string();
    let endpoint = if endpoint.contains("://") {
        endpoint
    } else {
        format!("https://{endpoint}")
    };
    Some(Creds {
        endpoint,
        access_key,
        secret_key,
        image_token: ep_image || ak_image || sk_image,
    })
}

/// 读凭据（进程环境版）。三个变量缺一不可 —— 图库那组优先，逐项回落部署那组。
pub fn load_creds() -> Option<Creds> {
    creds_from(|k| std::env::var(k).ok())
}

pub(crate) fn store(creds: &Creds, bucket: &str) -> Result<Arc<dyn ObjectStore>, String> {
    let options = ClientOptions::new()
        .with_connect_timeout(Duration::from_secs(5))
        .with_timeout(Duration::from_secs(30));
    AmazonS3Builder::new()
        .with_region("auto")
        .with_bucket_name(bucket)
        .with_endpoint(&creds.endpoint)
        .with_access_key_id(&creds.access_key)
        .with_secret_access_key(&creds.secret_key)
        .with_virtual_hosted_style_request(false)
        .with_disable_bulk_delete(true)
        .with_client_options(options)
        .with_allow_http(creds.endpoint.starts_with("http://"))
        .with_retry(RetryConfig {
            max_retries: 2,
            retry_timeout: Duration::from_secs(40),
            ..Default::default()
        })
        .build()
        .map(|store| Arc::new(store) as Arc<dyn ObjectStore>)
        .map_err(|_| "R2 storage configuration invalid".into())
}

pub async fn list_used_bytes(creds: &Creds, bucket: &str, prefix: &str) -> Result<u64, String> {
    let store = store(creds, bucket)?;
    let prefix = Path::parse(prefix).map_err(|_| "invalid R2 prefix")?;
    let mut list = store.list(Some(&prefix));
    let mut total = 0u64;
    let mut count = 0usize;
    while let Some(item) = list
        .try_next()
        .await
        .map_err(|_| "R2 listing unavailable")?
    {
        total = total.checked_add(item.size).ok_or("R2 size overflow")?;
        count += 1;
        if count > 200_000 {
            return Err("R2 listing exceeds bounded gallery size".into());
        }
    }
    Ok(total)
}

pub async fn put_object(
    creds: &Creds,
    bucket: &str,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let store = store(creds, bucket)?;
    let path = Path::parse(key).map_err(|_| "invalid R2 path")?;
    let mut attributes = object_store::Attributes::new();
    attributes.insert(
        object_store::Attribute::ContentType,
        content_type.to_owned().into(),
    );
    store
        .put_opts(
            &path,
            body.into(),
            object_store::PutOptions {
                attributes,
                ..Default::default()
            },
        )
        .await
        .map(|_| ())
        .map_err(|_| "R2 upload unavailable".into())
}

pub async fn delete_object(creds: &Creds, bucket: &str, key: &str) -> Result<(), String> {
    let store = store(creds, bucket)?;
    let path = Path::parse(key).map_err(|_| "invalid R2 path")?;
    match store.delete(&path).await {
        Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
        Err(_) => Err("R2 deletion unavailable".into()),
    }
}
#[cfg(test)]
mod tests;
