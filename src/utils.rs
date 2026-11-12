use serde::Serialize;
use sha2::{Sha256, Digest};
use std::path::PathBuf;
use std::env;

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub code: i32,
    pub message: String,
    pub data: T,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            code: 200,
            message: "ok".to_string(),
            data,
        }
    }

    pub fn error(msg: &str) -> Self where T: Default {
         Self {
            code: 500,
            message: msg.to_string(),
            data: T::default(),
        }
    }
}

#[derive(Serialize)]
pub struct ApiResponsePage<T> {
    #[serde(flatten)]
    pub base: ApiResponse<T>,
    /// 满足筛选条件的**总条数**（不是本页条数）。分页时必有，不分页时没有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
}

impl<T> ApiResponsePage<T> {
    /// `total` 给 `None` = 这一次没分页（响应里不会出现这个键）。
    pub fn success(data: T, total: Option<i64>) -> Self {
        Self { base: ApiResponse::success(data), total }
    }

    pub fn error(msg: &str) -> Self
    where
        T: Default,
    {
        Self { base: ApiResponse::error(msg), total: None }
    }
}

pub fn encrypt_password(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let result = hasher.finalize();
    hex::encode(result)
}

/// Argon2id 密码哈希，PHC 字符串携带参数和独立随机盐。
pub fn hash_password(input: &str) -> String {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(input.as_bytes(), &salt)
        .expect("argon2 哈希失败（参数合法、盐已生成）")
        .to_string()
}

/// Argon2 是 CPU/内存密集操作：不占用 Tokio I/O 线程，也不允许无限排队。
async fn password_work<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, &'static str> {
    static SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
    let permit = SLOTS.clone().try_acquire_owned()
        .map_err(|_| "密码服务繁忙，请稍后再试")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    }).await.map_err(|_| "密码服务暂时不可用，请稍后再试")
}

pub async fn hash_password_async(input: String) -> Result<String, &'static str> {
    password_work(move || hash_password(&input)).await
}

pub async fn verify_password_async(input: String, stored: String) -> Result<bool, &'static str> {
    password_work(move || verify_password(&input, &stored)).await
}

/// 校验 Argon2id 或 SHA-256 格式；登录成功后升级 SHA-256 哈希。
pub fn verify_password(input: &str, stored: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    if stored.starts_with("$argon2") {
        return PasswordHash::new(stored)
            .map(|h| argon2::Argon2::default().verify_password(input.as_bytes(), &h).is_ok())
            .unwrap_or(false);
    }
    // SHA-256 哈希使用常数时间比较。
    let got = encrypt_password(input);
    got.len() == stored.len()
        && got.bytes().zip(stored.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// 这个存储的哈希是否需要在登录成功后升级成 Argon2id。
pub fn needs_rehash(stored: &str) -> bool {
    !stored.starts_with("$argon2")
}

pub const PASSWORD_MIN_CHARS: usize = 8;
pub const PASSWORD_MAX_CHARS: usize = 128;

/// 口令不合格时给出**给用户看的那句话**，合格返回 `None`。
///
/// 三个入口（本人改密码 / 找回密码 / 管理员改密码）共用这一个函数 —— 再抄一份
/// 就会再漂一次，而漂的方向恰好是"中文口令比英文口令短"这种看不出来的地方。
pub fn password_reject(pw: &str) -> Option<&'static str> {
    let n = pw.chars().count();
    if n < PASSWORD_MIN_CHARS {
        return Some("密码至少 8 位");
    }
    if n > PASSWORD_MAX_CHARS {
        return Some("密码过长（最多 128 位）");
    }
    None
}

/// 用户名字符数上限。**建号是管理员专用入口**，所以这个数只需要挡住"手滑贴进来一段
pub const USERNAME_MAX_CHARS: usize = 32;

/// 账号名不合格时给出那句话，合格返回 `None`。**入参是已经 `trim()` 过的值**——
/// 判据与落库必须看同一个串，否则「' ' 通过检查然后被存成空串」这种事就会发生。
pub fn username_reject(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("用户名不能为空");
    }
    if name.chars().count() > USERNAME_MAX_CHARS {
        return Some("用户名过长（最多 32 个字符）");
    }
    None
}

/// Local media defaults to ./uploads; production sets a persistent UPLOAD_DIR outside releases.
pub fn upload_dir() -> PathBuf {
    if let Ok(dir) = env::var("UPLOAD_DIR") {
        return PathBuf::from(dir);
    }

    match env::current_dir() {
        Ok(dir) => dir.join("uploads"),
        Err(_) => PathBuf::from("uploads"),
    }
}


/// 允许的图片后缀。**`svg` 故意不在里面**：SVG 能携带脚本，而
/// `/api/protect/download/` 是**同源公开直出** —— 一张"图"就成了一条同源 XSS 的入口
/// （同族判断见 [`sniff_image_ext`] 的头注）。要放 SVG 得先把它挪到另一个域上出图。
pub const ALLOWED_IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];

/// 给人看的名单（拒绝文案里要用，别在别处手拼一份）。
pub const ALLOWED_IMAGE_EXTS_TEXT: &str = "png / jpg / jpeg / gif / webp / avif / bmp / ico";

/// 这个名字的后缀在不在白名单里（大小写不敏感）。**只看名字**，内容另由
/// [`sniff_image_ext`] 认——两条都要过：内容对而名字是 `.html` 的，会被 `ServeDir`
/// 按后缀当成 HTML 出图；名字对而内容是 HTML 的，则是伪装。
pub fn image_ext_ok(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => image_ext_allowed(ext),
        None => false,
    }
}

/// 裸后缀（**不带点**）在不在白名单里。给"后缀已经单独拿到了"的调用方用 ——
/// 头像那条路就是：`ext` 是 `sniff_image_ext` 认出来的，没有文件名可拆。
pub fn image_ext_allowed(ext: &str) -> bool {
    ALLOWED_IMAGE_EXTS.iter().any(|a| a.eq_ignore_ascii_case(ext))
}

/// 这条**请求路径**能不能当图片出图（`/api/protect/download/` 那条中间件的判据）。
/// 目录路径、无后缀、`.html`、`a.png.html` 全落进 false 那一侧。
pub fn is_image_path(path: &str) -> bool {
    image_ext_ok(path.rsplit('/').next().unwrap_or(path))
}

pub fn sniff_image_ext(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 3 && data[0..3] == [0xFF, 0xD8, 0xFF] {
        return Some("jpg");
    }
    if data.len() >= 8 && data[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("png");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    if data.len() >= 6 && (&data[0..6] == b"GIF87a" || &data[0..6] == b"GIF89a") {
        return Some("gif");
    }
    if data.len() >= 2 && &data[0..2] == b"BM" {
        return Some("bmp");
    }
    if data.len() >= 4 && data[0..4] == [0x00, 0x00, 0x01, 0x00] {
        return Some("ico");
    }
    // ISO-BMFF：`....ftyp<品牌>`（avif / avis 同族）
    if data.len() >= 12 && &data[4..8] == b"ftyp" && (&data[8..12] == b"avif" || &data[8..12] == b"avis")
    {
        return Some("avif");
    }
    None
}

pub fn site_url() -> String {
    env::var("SITE_URL")
        .unwrap_or_else(|_| "http://localhost:3000".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// 读取可选 IoT 功能开关，默认关闭，供 sitemap 使用。
/// 真值接受 1/true/yes/on，与 Agent 配置保持一致；nginx 路由由 iot/toggle.sh 管理。
pub fn iot_enabled() -> bool {
    matches!(
        env::var("IOT_ENABLED").unwrap_or_default().trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 后缀白名单的边界。**这几条都是真出过事或差一步出事的位置**：
    /// `a.png.html`（后缀是 html 不是 png）、无后缀、大小写、目录路径。
    #[test]
    fn image_ext_ok_boundaries() {
        assert!(image_ext_ok("a.png"));
        assert!(image_ext_ok("a.PNG"), "大小写不敏感（Windows 拖进来的文件名常是大写）");
        assert!(image_ext_ok("a.jpeg"));
        assert!(image_ext_ok("20260912013218_EMQX.png"), "带时间戳前缀的落盘名");

        assert!(!image_ext_ok("a.png.html"), "后缀只认最后一段");
        assert!(!image_ext_ok("a.html"));
        assert!(!image_ext_ok("a.svg"), "SVG 故意不在白名单里（同源直出会带脚本）");
        assert!(!image_ext_ok("README"), "无后缀");
        // `.png`（只有后缀、没有名字）**算合格**：`rsplit_once` 切出空名 + png，而这族
        // 名字进不了库 —— 落盘名一律是 `{时间戳}_{原名}`，前面永远有别的东西。
        assert!(image_ext_ok(".png"));
        assert!(!image_ext_ok("a."), "空后缀");
        assert!(!image_ext_ok(""), "空串");
    }

    #[test]
    fn password_reject_counts_chars_not_bytes() {
        // 英文：8 个 ASCII 恰好合格
        assert_eq!(password_reject("1234567"), Some("密码至少 8 位"));
        assert_eq!(password_reject("12345678"), None);

        // 密码长度按字符数校验。
        assert_eq!(password_reject("一二三"), Some("密码至少 8 位"));
        // 单个多字节字符仍不满足最小长度。
        assert_eq!(password_reject("密"), Some("密码至少 8 位"));

        // 8 个汉字合格（32 字节）
        assert_eq!(password_reject("一二三四五六七八"), None);

        // 上限：128 字符合格、129 超限。两侧都用 ASCII，避免把字节数混进来。
        assert_eq!(password_reject(&"a".repeat(128)), None);
        assert_eq!(password_reject(&"a".repeat(129)), Some("密码过长（最多 128 位）"));
        // 上限也按字符算：129 个汉字是 387 字节，仍该拦
        assert_eq!(password_reject(&"密".repeat(129)), Some("密码过长（最多 128 位）"));

        // 空串走的是"太短"，不是"过长"
        assert_eq!(password_reject(""), Some("密码至少 8 位"));
    }

    /// 账号名判据。**入参约定是已 `trim()` 的值**（调用方负责），所以这里不测空格。
    #[test]
    fn username_reject_boundaries() {
        assert_eq!(username_reject(""), Some("用户名不能为空"));
        assert_eq!(username_reject("sora"), None);
        // 长度按**字符**算：32 个汉字合格、33 个超限（若按字节算，11 个汉字就超了）
        assert_eq!(username_reject(&"名".repeat(32)), None);
        assert_eq!(username_reject(&"名".repeat(33)), Some("用户名过长（最多 32 个字符）"));
        assert_eq!(username_reject(&"a".repeat(33)), Some("用户名过长（最多 32 个字符）"));
    }

    #[test]
    fn is_image_path_uses_last_segment() {
        assert!(is_image_path("/api/protect/download/20260912013218_EMQX.png"));
        assert!(is_image_path("/api/protect/download/avatars/1_20261006120000.PNG"));
        assert!(is_image_path("a.png"), "裸相对路径也要认");

        assert!(!is_image_path("/api/protect/download/"));
        assert!(!is_image_path("/api/protect/download/avatars"), "目录本身不是图片");
        assert!(!is_image_path("/api/protect/download/evil.html"));
        assert!(!is_image_path("/api/protect/download/a.png/index.html"), "看最后一段");
    }

    /// 认字节头而不是名字。**认不出就拒绝**（SVG/HTML 都落在这侧）。
    #[test]
    fn sniff_image_ext_by_magic_bytes() {
        assert_eq!(sniff_image_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(
            sniff_image_ext(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00]),
            Some("png")
        );
        assert_eq!(sniff_image_ext(b"GIF89a...."), Some("gif"));
        assert_eq!(sniff_image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_image_ext(b"BM\x00\x00"), Some("bmp"));
        assert_eq!(sniff_image_ext(&[0x00, 0x00, 0x01, 0x00, 0x01]), Some("ico"));
        assert_eq!(sniff_image_ext(b"\x00\x00\x00\x20ftypavif...."), Some("avif"));

        assert_eq!(sniff_image_ext(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(sniff_image_ext(b"<html><script>alert(1)</script>"), None);
        assert_eq!(sniff_image_ext(b""), None, "空文件不认");
        assert_eq!(sniff_image_ext(b"PK\x03\x04"), None, "zip 不认");
    }

    /// 名字与内容**两条都要过**：内容是 PNG 但名字是 `.html` 的，`ServeDir` 会按后缀
    /// 当 HTML 出图 ⇒ 白名单这一侧必须拦下（反过来是伪装，由 sniff 拦）。
    #[test]
    fn both_sides_must_agree() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00];
        assert!(sniff_image_ext(&png).is_some() && !image_ext_ok("x.html"));
    }
}
