use crate::entity::image;
use crate::r2;
use crate::routes::AppState;
use crate::utils::{
    image_ext_ok, sniff_image_ext, upload_dir, ApiResponse, ALLOWED_IMAGE_EXTS_TEXT,
};
use axum::{
    extract::{Multipart, State},
    Json,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement,
};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub const IMAGE_MAX_BYTES: usize = 20 * 1024 * 1024;

pub fn route() -> axum::routing::MethodRouter<Arc<AppState>> {
    axum::routing::post(upload_image).layer(axum::extract::DefaultBodyLimit::max(
        IMAGE_MAX_BYTES + 64 * 1024,
    ))
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn object_name(prefix: &str, ext: &str) -> String {
    format!("{prefix}{}.{}", uuid::Uuid::new_v4().simple(), ext)
}

fn generation_prefix(name: &str, data: &[u8]) -> String {
    let identity = serde_json::to_vec(&(name, sha256_hex(data))).expect("string tuple serializes");
    format!("generated-{}-", sha256_hex(&identity))
}

fn validate_url(url: &str) -> Result<(), DbErr> {
    if url.len() > 2048 {
        return Err(DbErr::Custom("图片地址过长，请检查图库存储配置".into()));
    }
    Ok(())
}

async fn register(state: &Arc<AppState>, url: &str, name: Option<&str>) -> Result<(), DbErr> {
    match name {
        Some(name) => super::gallery::register_named_image(&state.db, url, name).await?,
        None => super::gallery::register_image(&state.db, url).await?,
    };
    Ok(())
}

async fn write_local(dir: &Path, name: &str, data: &[u8]) -> Result<String, DbErr> {
    let url = format!("/api/protect/download/{name}");
    validate_url(&url)?;
    fs::create_dir_all(dir)
        .await
        .map_err(|_| DbErr::Custom("图库目录不可用".into()))?;
    let path = dir.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|_| DbErr::Custom("无法创建图片，请重试".into()))?;
    if file.write_all(data).await.is_err() || file.sync_all().await.is_err() {
        drop(file);
        let _ = fs::remove_file(&path).await;
        return Err(DbErr::Custom("图片保存失败，请重试".into()));
    }
    Ok(url)
}

async fn registered_generation(
    state: &Arc<AppState>,
    prefix: &str,
) -> Result<Option<String>, DbErr> {
    let row = state
        .db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT i.image_url FROM images i WHERE i.image_url LIKE $1 \
         AND NOT EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=i.image_key) \
         ORDER BY i.image_key DESC LIMIT 1",
            [format!("%/{prefix}%").into()],
        ))
        .await?;
    row.map(|row| row.try_get("", "image_url")).transpose()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UploadTarget {
    FollowPanel,
    Local,
    R2,
}

impl UploadTarget {
    fn parse(raw: Option<&str>) -> Option<Self> {
        match raw.map(str::trim) {
            None | Some("") => Some(UploadTarget::FollowPanel),
            Some("local") => Some(UploadTarget::Local),
            Some("r2") => Some(UploadTarget::R2),
            Some(_) => None,
        }
    }
}

/// Storage extensions follow the verified image bytes.
fn ext_matches_content(name: &str, sniffed: &str) -> bool {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if ext.eq_ignore_ascii_case(sniffed) {
        return true;
    }
    let jpeg = |s: &str| s.eq_ignore_ascii_case("jpg") || s.eq_ignore_ascii_case("jpeg");
    jpeg(ext) && jpeg(sniffed)
}

fn normalize_file_name(raw: &str, sniffed: &str) -> String {
    let stem = match raw.rsplit_once('.') {
        Some((s, _)) => s,
        None => raw,
    };
    let stem = if stem.is_empty() { "image" } else { stem };
    if ext_matches_content(raw, sniffed) {
        raw.to_string()
    } else {
        format!("{}.{}", stem, sniffed)
    }
}

// Quota listing and PUT share a process-local critical section.
static R2_UPLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 体积给人看的 GB（GiB 口径，与面板上的 `r2ImageQuotaGB` 同一把尺子）。
fn gib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0 * 1024.0)
}

fn guess_content_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Explicit R2 failures never switch the upload to local storage.
async fn try_r2_upload(
    state: &Arc<AppState>,
    name: &str,
    object: &str,
    data: &[u8],
    required: bool,
    named: bool,
) -> Option<ApiResponse<String>> {
    let cfg = match r2::load_config(&state.db).await {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!("upload storage configuration unavailable: {error}");
            return Some(ApiResponse::error("图库存储配置读取失败，请稍后重试"));
        }
    };
    if !cfg.active() {
        return required.then(|| ApiResponse::error("R2 图库尚未完整配置，请检查存储设置"));
    }
    let Some(creds) = r2::load_creds() else {
        return Some(ApiResponse::error("R2 图库缺少服务端凭据，请检查存储配置"));
    };
    let key = format!("{}/{}", cfg.prefix, object);
    let url = r2::public_url(&cfg.public_base, &key);
    if validate_url(&url).is_err() {
        return Some(ApiResponse::error("图片地址过长，请检查图库存储配置"));
    }
    let _guard = R2_UPLOAD_LOCK.lock().await;
    let used = match r2::list_used_bytes(&creds, &cfg.bucket, &cfg.prefix).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!("upload quota lookup failed: {error}");
            return Some(ApiResponse::error("R2 用量暂不可用，本次没有上传文件"));
        }
    };
    if r2::quota_exceeded(used, data.len() as u64, cfg.quota_bytes) {
        return Some(ApiResponse::error(&format!(
            "R2 已用 {:.2} GB / 上限 {:.2} GB，空间不足",
            gib(used),
            gib(cfg.quota_bytes)
        )));
    }
    if let Err(error) = r2::put_object(
        &creds,
        &cfg.bucket,
        &key,
        data.to_vec(),
        guess_content_type(object),
    )
    .await
    {
        tracing::warn!("upload to R2 failed: {error}");
        return Some(ApiResponse::error("R2 上传未完成，请稍后重试"));
    }
    if let Err(error) = register(state, &url, named.then_some(name)).await {
        // A failed commit response is ambiguous; never delete a possibly registered object.
        tracing::error!(storage_key = %key, "uploaded image registration failed: {error}");
        return Some(ApiResponse::error(
            "图片未完成图库登记，请刷新图库核对后重试",
        ));
    }
    Some(ApiResponse::success(url))
}

pub async fn upload_image(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Json<ApiResponse<String>> {
    let upload_dir = upload_dir();

    let mut target_raw: Option<String> = None;
    let mut received: Option<(String, axum::body::Bytes)> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!("[upload] 读取 multipart 失败：{}", e);
                return Json(ApiResponse::error("读取上传内容失败（可能超过大小上限）"));
            }
        };
        let part_name = field.name().unwrap_or_default().to_string();
        let file_name = field.file_name().map(|s| s.to_string());

        if let Some(raw_name) = file_name {
            let data = match field.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("[upload] 读文件体失败：{}", e);
                    return Json(ApiResponse::error("文件读取失败（可能超过大小上限）"));
                }
            };
            if received.is_none() {
                // 只保留 basename：客户端给的名字里可能带路径
                let base = raw_name
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or("")
                    .to_string();
                received = Some((base, data));
            }
        } else if part_name == "target" {
            match field.text().await {
                Ok(t) => target_raw = Some(t),
                Err(e) => {
                    tracing::warn!("[upload] 读 target 失败：{}", e);
                    return Json(ApiResponse::error("读取上传目标失败"));
                }
            }
        } else {
            let _ = field.bytes().await; // 无关字段：读掉即可
        }
    }

    let Some((raw_name, data)) = received else {
        return Json(ApiResponse::error("没有收到文件"));
    };

    let Some(target) = UploadTarget::parse(target_raw.as_deref()) else {
        return Json(ApiResponse::error(
            "上传目标只认 local（本站服务器）或 r2（R2 图床）。这次没有上传任何文件。",
        ));
    };

    if data.len() > IMAGE_MAX_BYTES {
        return Json(ApiResponse::error("单张图片不能超过 20 MiB，本次未上传。"));
    }

    if !image_ext_ok(&raw_name) {
        return Json(ApiResponse::error(&format!(
            "只收图片（{ALLOWED_IMAGE_EXTS_TEXT}）。这次没有上传任何文件。"
        )));
    }
    let Some(sniffed) = sniff_image_ext(&data) else {
        return Json(ApiResponse::error(&format!(
            "这个文件的内容不是图片（只收 {ALLOWED_IMAGE_EXTS_TEXT}）。这次没有上传任何文件。"
        )));
    };
    let file_name = normalize_file_name(&raw_name, sniffed);

    if file_name.chars().count() > 255 {
        return Json(ApiResponse::error("图片文件名不能超过 255 个字符"));
    }
    let object = object_name("", sniffed);
    if target != UploadTarget::Local {
        if let Some(response) = try_r2_upload(
            &state,
            &file_name,
            &object,
            &data,
            target == UploadTarget::R2,
            true,
        )
        .await
        {
            return Json(response);
        }
    }
    let result = async {
        let url = write_local(&upload_dir, &object, &data).await?;
        register(&state, &url, Some(&file_name)).await?;
        Ok::<_, DbErr>(url)
    }
    .await;
    match result {
        Ok(url) => Json(ApiResponse::success(url)),
        Err(error) => {
            tracing::error!(storage_key = %object, "local image upload failed: {error}");
            Json(ApiResponse::error(
                "图片未完成保存或图库登记，请刷新图库核对后重试",
            ))
        }
    }
}

#[derive(serde::Deserialize)]
pub struct ImageListQuery {
    /// 只回 `image_key < before` 的行；首页不传。取的是**上一页最后一张**的 key。
    #[serde(default)]
    pub before: Option<i32>,
    /// Requested page size; short pages indicate the end of the cursor stream.
    #[serde(default)]
    pub limit: Option<u64>,
}

pub async fn list_images(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<ImageListQuery>,
) -> Json<ApiResponse<Vec<image::Model>>> {
    let mut finder = image::Entity::find()
        .filter(sea_orm::sea_query::Expr::cust(
            "NOT EXISTS (SELECT 1 FROM image_deletion d WHERE d.image_id=images.image_key)",
        ))
        .order_by_desc(image::Column::ImageKey);
    if let Some(before) = q.before {
        finder = finder.filter(image::Column::ImageKey.lt(before));
    }
    if let Some(limit) = q.limit {
        finder = finder.limit(limit);
    }
    let images = match finder.all(&state.db).await {
        Ok(images) => images,
        Err(error) => {
            tracing::warn!("gallery picker query failed: {error}");
            return Json(ApiResponse::error("图库暂时无法读取，请稍后重试"));
        }
    };

    Json(ApiResponse::success(images))
}

/// `used_bytes` is authoritative only when `list_error` is absent.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2Usage {
    /// 面板里的总开关（用户点的那一个）
    pub enabled: bool,
    /// 四样是否齐备（开关 + 桶名 + 前缀 + 公开域名）——即"这次上传会不会走 R2"
    pub configured: bool,
    /// 服务端 .env 里的凭据在不在（不在 ⇒ 配了也传不上去）
    pub credentials: bool,
    /// Credential source label only, never credential values.
    pub creds_source: Option<String>,
    pub bucket: String,
    pub prefix: String,
    pub public_base: String,
    pub quota_gb: f64,
    pub limit_bytes: u64,
    pub used_bytes: u64,
    /// **为什么没有可信读数**（未启用 / 没配全 / 没凭据 / 列表失败）。
    /// `None` 才代表 `used_bytes` 可信；非 `None` 时前端据它分支（先看 enabled/configured）。
    pub list_error: Option<String>,
}

// GET /api/protect/images/r2
pub async fn r2_usage(State(state): State<Arc<AppState>>) -> Json<ApiResponse<R2Usage>> {
    let cfg = match r2::load_config(&state.db).await {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!("R2 usage configuration unavailable: {error}");
            return Json(ApiResponse::error("图库存储配置读取失败，请稍后重试"));
        }
    };
    let creds = r2::load_creds();
    let mut used_bytes = 0u64;
    let mut list_error = None;
    if cfg.active() {
        match creds.as_ref() {
            None => {
                list_error = Some(
                    "服务端没有 R2 凭据（.env 里既没有 R2_IMAGE_ACCESS_KEY / R2_IMAGE_SECRET_KEY，\
                     也没有 R2_ACCESS_KEY / R2_SECRET_KEY）"
                        .to_string(),
                )
            }
            Some(c) => match r2::list_used_bytes(c, &cfg.bucket, &cfg.prefix).await {
                Ok(v) => used_bytes = v,
                Err(e) => list_error = Some(e),
            },
        }
    } else if !cfg.enabled {
        list_error = Some("R2 图床未启用（面板里关着开关）".to_string());
    } else {
        list_error = Some("R2 图床没配全（桶名 / 前缀 / 公开域名）".to_string());
    }
    Json(ApiResponse::success(R2Usage {
        enabled: cfg.enabled,
        configured: cfg.active(),
        credentials: creds.is_some(),
        creds_source: creds.as_ref().map(|c| {
            if c.image_token {
                "R2_IMAGE_*（图库专用令牌）".to_string()
            } else {
                "R2_*（部署令牌）".to_string()
            }
        }),
        bucket: cfg.bucket,
        prefix: cfg.prefix,
        public_base: cfg.public_base,
        quota_gb: gib(cfg.quota_bytes),
        limit_bytes: cfg.quota_bytes,
        used_bytes,
        list_error,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `target` 的三态 + **非法值必须能被认出来**（调用方据此报错而不是按缺省处理）。
    #[test]
    fn upload_target_parse() {
        assert_eq!(UploadTarget::parse(None), Some(UploadTarget::FollowPanel));
        assert_eq!(
            UploadTarget::parse(Some("")),
            Some(UploadTarget::FollowPanel)
        );
        assert_eq!(
            UploadTarget::parse(Some(" local ")),
            Some(UploadTarget::Local)
        );
        assert_eq!(UploadTarget::parse(Some("r2")), Some(UploadTarget::R2));
        assert_eq!(
            UploadTarget::parse(Some("LOCAL")),
            None,
            "大小写不宽容：认不出就报错"
        );
        assert_eq!(UploadTarget::parse(Some("server")), None);
        assert_eq!(UploadTarget::parse(Some("r2 ")), Some(UploadTarget::R2));
    }

    #[test]
    fn ext_matches_content_rules() {
        assert!(ext_matches_content("a.png", "png"));
        assert!(ext_matches_content("a.PNG", "png"), "大小写不敏感");
        assert!(ext_matches_content("a.jpg", "jpg"));
        assert!(
            ext_matches_content("a.jpeg", "jpg"),
            "jpeg 与 jpg 是同一个东西"
        );
        assert!(ext_matches_content("a.JPEG", "jpg"));
        assert!(!ext_matches_content("a.png", "jpg"));
        assert!(!ext_matches_content("a.webp", "png"));
        assert!(!ext_matches_content("a", "png"), "没有后缀 ⇒ 不相容");
    }

    #[test]
    fn normalize_file_name_rewrites_only_on_mismatch() {
        assert_eq!(normalize_file_name("photo.png", "png"), "photo.png");
        assert_eq!(normalize_file_name("photo.JPEG", "jpg"), "photo.JPEG");
        assert_eq!(normalize_file_name("photo.png", "jpg"), "photo.jpg");
        assert_eq!(normalize_file_name("photo.html", "png"), "photo.png");
        assert_eq!(normalize_file_name("noext", "png"), "noext.png");
        // 名字退化的情况不许产出 ".png" 这种无名文件
        assert_eq!(normalize_file_name(".png", "jpg"), "image.jpg");
        assert_eq!(normalize_file_name("", "png"), "image.png");
    }

    /// 出图侧的 content-type 只认白名单里的后缀；**`svg` 必须落到 `octet-stream`**
    /// （它由本站同源直出，当 `image/svg+xml` 出图就是一条同源 XSS）。
    #[test]
    fn guess_content_type_has_no_svg() {
        assert_eq!(guess_content_type("a.png"), "image/png");
        assert_eq!(guess_content_type("a.JPG"), "image/jpeg");
        assert_eq!(guess_content_type("a.jpeg"), "image/jpeg");
        assert_eq!(guess_content_type("a.svg"), "application/octet-stream");
        assert_eq!(guess_content_type("a.html"), "application/octet-stream");
        assert_eq!(guess_content_type("a"), "application/octet-stream");
    }

    #[test]
    fn immutable_keys_keep_generation_identity_and_fresh_objects_separate() {
        let first = object_name("", "png");
        let second = object_name("", "png");
        assert_ne!(first, second);
        assert!(uuid::Uuid::parse_str(first.strip_suffix(".png").unwrap()).is_ok());
        let prefix = generation_prefix("job-a", b"output-a");
        assert_eq!(prefix, generation_prefix("job-a", b"output-a"));
        assert_ne!(prefix, generation_prefix("job-a", b"output-b"));
        assert_ne!(prefix, generation_prefix("job-b", b"output-a"));
        let generated = object_name(&prefix, "png");
        assert!(generated.starts_with(&prefix));
        assert!(generated.len() < 255);
        assert!(generated.is_ascii());
        assert_ne!(generated, object_name(&prefix, "png"));
    }

    #[tokio::test]
    async fn writing_an_existing_local_object_never_truncates_its_bytes() {
        let dir = std::env::temp_dir().join(format!("saudade-upload-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        fs::write(dir.join("existing.png"), b"existing image")
            .await
            .unwrap();
        assert!(write_local(&dir, "existing.png", b"replacement")
            .await
            .is_err());
        assert_eq!(
            fs::read(dir.join("existing.png")).await.unwrap(),
            b"existing image"
        );
        let fresh = object_name("", "png");
        assert!(write_local(&dir, &fresh, b"fresh image").await.is_ok());
        assert_eq!(fs::read(dir.join(fresh)).await.unwrap(), b"fresh image");
        fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn image_urls_enforce_the_database_byte_budget_before_storage_io() {
        assert!(validate_url(&"x".repeat(2048)).is_ok());
        assert!(validate_url(&"x".repeat(2049)).is_err());
        assert!(validate_url(&"图".repeat(700)).is_err());
    }

    fn state(db: sea_orm::DatabaseConnection) -> Arc<AppState> {
        Arc::new(AppState {
            db,
            rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
            post_limiter: crate::risk::PostRateLimiter::new(),
            report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
        })
    }

    #[tokio::test]
    async fn storage_configuration_failure_is_not_a_local_fallback_or_disabled_fact() {
        let database = || {
            sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_errors([DbErr::Custom("offline".into())])
                .into_connection()
        };
        let response = try_r2_upload(
            &state(database()),
            "original.png",
            "fresh.png",
            b"bytes",
            false,
            true,
        )
        .await
        .expect("configuration failure must not fall through to local storage");
        assert_ne!(response.code, 200);
        assert!(response.data.is_empty());
        let Json(usage) = r2_usage(State(state(database()))).await;
        assert_ne!(usage.code, 200);
    }

    #[tokio::test]
    async fn a_registered_generation_is_reused_without_rewriting_storage_or_metadata() {
        let url = "/api/protect/download/generated-existing.png";
        let rows = [std::collections::BTreeMap::from([(
            "image_url",
            sea_orm::Value::from(url),
        )])];
        let db = sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([rows])
            .into_connection();
        let result = persist_generated(&state(db), "job-a", b"\x89PNG\r\n\x1a\n")
            .await
            .unwrap();
        assert_eq!(result, url);
    }
}

/// The acceptance job serializes callers; registered outputs are reused without rewriting bytes.
pub(crate) async fn persist_generated(
    state: &Arc<AppState>,
    name: &str,
    bytes: &[u8],
) -> Result<String, DbErr> {
    let ext = sniff_image_ext(bytes).ok_or_else(|| DbErr::Custom("生成结果不是有效图片".into()))?;
    if !crate::utils::image_ext_allowed(ext) || bytes.len() > IMAGE_MAX_BYTES {
        return Err(DbErr::Custom("生成图片类型或大小无效".into()));
    }
    let prefix = generation_prefix(name, bytes);
    if let Some(url) = registered_generation(state, &prefix).await? {
        return Ok(url);
    }
    let object = object_name(&prefix, ext);
    if let Some(response) = try_r2_upload(state, name, &object, bytes, false, false).await {
        return if response.code == 200 {
            Ok(response.data)
        } else {
            Err(DbErr::Custom(response.message))
        };
    }
    let url = write_local(&upload_dir(), &object, bytes).await?;
    register(state, &url, None).await?;
    Ok(url)
}
