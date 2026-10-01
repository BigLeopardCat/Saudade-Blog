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

/// ⚠️ **旧格式密码哈希（SHA-256，无盐、单轮）**——20260917 起密码已改用
/// [`hash_password`]（Argon2id）。这个函数现在只留给两类历史用途：
///   ① 兼容旧用户名的哈希存储（`web_info` 把用户名也哈希过，登录的兼容分支按它查）；
///   ② 校验 20260917 之前写入的密码哈希（见 [`verify_password`]）。
/// **新代码不要再用它存密码。**
pub fn encrypt_password(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let result = hasher.finalize();
    hex::encode(result)
}

/// 密码哈希：Argon2id，PHC 字符串（自带算法、参数、随机盐），每行一个独立盐。
///
/// 为什么换：旧格式是**无盐单轮 SHA-256**——彩虹表直接命中、同密码哈希相同
/// （撞库时一眼看出哪些账号同密码）、GPU 每秒可试几十亿次。Argon2id 是 OWASP
/// 当前的推荐档，内存硬（默认 19MiB）+ 时间可调，把离线爆破成本抬到不可行。
pub fn hash_password(input: &str) -> String {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(input.as_bytes(), &salt)
        .expect("argon2 哈希失败（参数合法、盐已生成）")
        .to_string()
}

/// 校验密码：**同时认新格式与旧格式**（旧格式只在登录成功后被惰性升级，见 auth.rs）。
pub fn verify_password(input: &str, stored: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    if stored.starts_with("$argon2") {
        return PasswordHash::new(stored)
            .map(|h| argon2::Argon2::default().verify_password(input.as_bytes(), &h).is_ok())
            .unwrap_or(false);
    }
    // 旧格式：确定性 SHA-256 十六进制——用常数时间比较（虽然这里的比较对象是
    // 服务端算出来的，泄漏面很小，但没理由留一个非常数时间的比对）
    let got = encrypt_password(input);
    got.len() == stored.len()
        && got.bytes().zip(stored.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// 这个存储的哈希是否需要在登录成功后升级成 Argon2id。
pub fn needs_rehash(stored: &str) -> bool {
    !stored.starts_with("$argon2")
}

pub fn upload_dir() -> PathBuf {
    if let Ok(dir) = env::var("UPLOAD_DIR") {
        return PathBuf::from(dir);
    }

    match env::current_dir() {
        Ok(dir) => dir.join("uploads"),
        Err(_) => PathBuf::from("uploads"),
    }
}

/// 本站地址，形如 `https://example.com`，**无尾斜杠**（调用方直接 `{site}/article/1` 拼）。
///
/// 20261001 开源前准备：此前两处各自写死 `https://saudade.site` ——
/// sitemap 的 `<loc>` 前缀（[`crate::routes::sitemap`]）与 CORS 默认白名单
/// （[`crate::routes::create_router`]）。别人部署时一个会把爬虫指向别人的站、
/// 一个会让自己的前端跨域被拒。现在统一读 `SITE_URL`。
///
/// **缺省值是中性占位 `http://localhost:3000`，不是任何真实域名**：没配时宁可产出一个
/// 明显没配好的地址（爬虫会忽略它），也不要静默指向项目作者的站点——那种错很难被发现，
/// 而它会把别人的文章挂到作者域名下。线上在 `.env` 里显式设 `SITE_URL`。
///
/// 不缓存：调用点只有"进程启动一次"和"每次抓 sitemap"两种，一次 getenv 的开销可忽略，
/// 而缓存（`OnceLock`）会让测试里改环境变量失效。
pub fn site_url() -> String {
    env::var("SITE_URL")
        .unwrap_or_else(|_| "http://localhost:3000".to_string())
        .trim_end_matches('/')
        .to_string()
}
