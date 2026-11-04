use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::Utc;
use hmac::{Hmac, KeyInit, Mac};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use sha2::{Digest, Sha256};

/// R2 图床的五个配置键（`web_info` KV）。**只在这里列一次**：读取、写入、前端设置
/// 卡都引用这一组，谁都不许手抄字面量（抄错一个字符的症状是"面板里填了但没生效"）。
pub const R2_KEYS: [&str; 5] = [
    "r2ImageBucket",
    "r2ImagePrefix",
    "r2ImagePublicBase",
    "r2ImageQuotaGB",
    "r2ImageEnabled",
];

/// 配额兜底值（GiB）。键缺席/填坏都落在这里——**不是 0、也不是无上限**：
/// 0 会让上传当场全停，无上限等于把"防账单"这件事交给运气。
pub const DEFAULT_QUOTA_GB: f64 = 9.5;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// 空 body 的 sha256（S3 的集合请求/无体请求都用它）。写死是惯例：
/// 它是常量，不该每次上传都重算一遍。
pub const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// R2 的签名范围。**R2 不看 region 的值**（它只做 SigV4 的形状校验），但这一串会参与
/// 密钥派生 ⇒ 必须与"服务端按同一串重算"一致才可能对上；`auto` 是 Cloudflare 文档给的写法。
const REGION: &str = "auto";
const SERVICE: &str = "s3";

// ══ 配置 ════════════════════════════════════════════════════════════════════

/// 图库 R2 的配置面（不含凭据）。
#[derive(Debug, Clone, PartialEq)]
pub struct R2Config {
    /// 面板上的总开关。**只有它是 `true` 且三样都填全了才会走 R2**（见 [`Self::active`]）
    pub enabled: bool,
    pub bucket: String,
    /// 对象键前缀（归一后两端无 `/`）。**留空视为未配置**：前缀是这套图床的命名空间，
    /// 留空等于与同桶里的别的用途（部署包、别的项目）混在一层，误配一次就互相踩。
    pub prefix: String,
    /// 公开访问域名（归一后无尾 `/`，必须 `http(s)://`）。
    pub public_base: String,
    /// 配额（字节）。上限定在这里、判据在 [`quota_exceeded`]，**都不要在别处再写一份**。
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
    /// 这次上传该不该走 R2。**四样齐备才算配好**：开关开着、桶名/前缀/公开域名都填了。
    /// 任何一样缺 ⇒ 回落本地盘（**与今天逐字节相同**），不存在"配了一半就往上写"。
    pub fn active(&self) -> bool {
        self.enabled
            && !self.bucket.is_empty()
            && !self.prefix.is_empty()
            && !self.public_base.is_empty()
    }

}

/// 从 KV 读到的原始字符串解析出配置。**纯函数**（不碰库、不碰环境），
/// 所以三条取值规则可以被单测逐格钉住：
///
///   · **缺键** ⇒ 出厂状态：开关关着、桶名/前缀/域名空 ⇒ [`R2Config::active`] 为假
///     （**未配置就是"照旧走本地盘"**，不是"报错"）；
///   · **填错** ⇒ 该字段按空/默认处理（脏配额回落 [`DEFAULT_QUOTA_GB`]）；
///     一个填错的键不该让上传当场全停，也不该意外把配额顶成无上限；
///   · **开关只认 `true`**：`1`/`yes`/`on`/`True` 一律算关。这个开关是**我们自己的
///     面板**在写（不是人工编辑的配置文件），严格反而更安全——它管的是"要不要往外
///     写文件"，含糊的取值会让"我以为关了"变成"其实一直开着"。
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

/// 配额那一格（GB，可以是小数）。**非正数 / 非数字 / NaN / 无穷 ⇒ 回落默认值**。
fn parse_quota_bytes(raw: &str, fallback: u64) -> u64 {
    match raw.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && v > 0.0 => (v * GIB) as u64,
        _ => fallback,
    }
}

/// 从库里读一次配置（图库页的用量接口与每次上传各一次，一条 `SELECT`）。
/// 读库失败 ⇒ 全默认（**未配置**）⇒ 走本地盘：故障时宁可"图还在本机"，
/// 也不要"配置读不到就当它是开着的、往一个不知道哪个桶里写"。
pub async fn load_config(db: &DatabaseConnection) -> R2Config {
    let rows = crate::entity::web_info::Entity::find()
        .filter(crate::entity::web_info::Column::KeyName.is_in(R2_KEYS.to_vec()))
        .all(db)
        .await
        .unwrap_or_default();
    let map: HashMap<String, String> = rows.into_iter().map(|r| (r.key_name, r.value)).collect();
    parse_config(|k| map.get(k).cloned())
}

// ══ 归一化 / 键 / URL（纯函数）═══════════════════════════════════════════════

/// 前缀归一：去两端空白与 `/`。`"/gallery/"` ⇒ `"gallery"`。
pub fn normalize_prefix(raw: &str) -> String {
    raw.trim().trim_matches('/').trim().to_string()
}

/// 公开域名归一：必须是 `http(s)://`（别的 scheme 一律 `None` —— 存进库的就是
/// 浏览器要直开的地址，`ftp://` 之类只会变成一条打不开的图），去掉尾 `/`。
/// 域名里带路径是允许的（`https://img.example.com/blog`）。
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

/// 对象键 = `<前缀>/<sha256 前 16 位>/<归一后的原名>`。
///
/// 内容寻址的理由见模块头注：同一份字节 + 同名 ⇒ 同一个键 ⇒ HEAD 命中即复用，
/// 与本地盘那条"字节相同就复用"的判据同形；哈希前缀同时把"不同内容同名"分开。
/// 取前 16 位（64 bit）是取舍：再长对象键难看且没必要，再短在几十万张图上就开始
/// 有碰撞余地 —— 而碰撞的表现是**一张图覆盖另一张**，不是报错。
pub fn object_key(prefix: &str, digest_hex: &str, file_name: &str) -> String {
    let short: String = digest_hex.chars().take(16).collect();
    let name = sanitize_file_name(file_name);
    let p = normalize_prefix(prefix);
    if p.is_empty() {
        format!("{short}/{name}")
    } else {
        format!("{p}/{short}/{name}")
    }
}

pub fn sanitize_file_name(raw: &str) -> String {
    // 先砍掉路径成分（`field.file_name()` 通常已经只有名字，但 `/` 一旦漏进来
    // 就会在桶里凭空多出一层目录）
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
    // 太长的主键名（>120 字符）截断：桶里的键没有长度上限，但人读不了、日志也放不下
    let trimmed: String = out.chars().take(120).collect();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        "image".to_string()
    } else {
        trimmed
    }
}

/// 对象键 ⇒ 存进库的公开地址（**原样、不编码**，编码发生在请求那一层）。
pub fn public_url(base: &str, key: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), key)
}

/// 存进库的地址 ⇒ 对象键。**判据是"前缀逐字相同"**：换了公开域名之后，存量地址
/// 与当前配置对不上（`None`）—— 这是刻意的，见 `routes/upload.rs` 里删除路径的
/// 处理（宁可什么都不删、如实报出来，也不能按猜测去别的桶里删）。
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

/// 超限判据：`used + incoming > limit`。
///
/// **严格大于**：恰好等于上限放行（"9.5G 就是 9.5G"，把等号判成超限会让面板上的
/// 用量条与上传按钮互相打架——条子显示 100%，按钮却已经灰了）。
/// `saturating_add`：两个 u64 相加在极端值上会回绕成小数，那会把"早就爆了"读成
/// "还很空"，是整个模块里唯一能导致账单的那类错误。
pub fn quota_exceeded(used: u64, incoming: u64, limit: u64) -> bool {
    used.saturating_add(incoming) > limit
}

// ══ SigV4（纯函数）══════════════════════════════════════════════════════════

type HmacSha256 = Hmac<Sha256>;

/// SHA-256 的十六进制小写（与 `routes/upload.rs::sha256_hex` 同一条，但那份是私有函数；
/// 两边算的都是"内容的指纹"，语义相同）。
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

/// HMAC-SHA256（RFC 2104）。`key` 任意长度 —— HMAC 自己会短则填零、长则先哈希。
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

/// SigV4 的签名密钥链：`HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`。
/// 用它的意义是：派生的密钥只对那一天的、那一个区域与服务的请求有效，日密钥泄露
/// 不等于长期凭据泄露（这是 SigV4 相对"直接把 secret 当 HMAC 密钥"的全部增量）。
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k = hmac_sha256(&k, region.as_bytes());
    let k = hmac_sha256(&k, service.as_bytes());
    hmac_sha256(&k, b"aws4_request")
}

/// SigV4 的百分号编码：只有 `A-Za-z0-9-_.~` 原样，其余逐字节 `%XX`（**大写**十六进制）。
/// `keep_slash` 给路径用（`/` 是分隔符，编码了就变成对象名的一部分，签名会与
/// 服务端算出来的不一致 ⇒ 403）。
pub fn uri_encode(raw: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.as_bytes() {
        let c = *b as char;
        let unreserved = c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~');
        if unreserved || (keep_slash && *b == b'/') {
            out.push(c);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

/// 规范请求（canonical request）。`headers` 会在这里**按名排序、名转小写、值做空白归一**
/// —— 调用方只管传，顺序与大小写错了就是 403（SigV4 规定的四种"看起来一样但签名不同"
/// 的输入：头顺序、头名大小写、值两侧空白、值中间连续空白）。
pub fn canonical_request(method: &str, path: &str, query: &str, headers: &[(&str, String)], payload_hash: &str) -> String {
    let mut hs: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), collapse_ws(v)))
        .collect();
    hs.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = hs
        .iter()
        .map(|(k, v)| format!("{k}:{v}\n"))
        .collect();
    let signed_headers = hs
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    format!(
        "{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
}

/// 头值的空白归一：去两端、中间连续空白折成一个空格（SigV4 规范要求）。
fn collapse_ws(v: &str) -> String {
    v.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 待签字符串（string to sign）。
pub fn string_to_sign(amz_date: &str, scope: &str, canonical_hash: &str) -> String {
    format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{canonical_hash}")
}

/// 请求的凭据范围（`<日期>/<区域>/<服务>/aws4_request`）。
pub fn scope(date: &str, region: &str, service: &str) -> String {
    format!("{date}/{region}/{service}/aws4_request")
}

/// 一次请求的签名结果（`Authorization` 头的值）。
pub struct Signature {
    pub authorization: String,
}

/// 签一次请求。**纯函数**（`amz_date` / region / service 全由调用方给）⇒
/// AWS 的官方向量能原样进单测。
///
/// ⚠️ region/service **是参数而不是常量**，理由不是"以后可能换"：官方那两组测试向量
/// 用的是 `us-east-1` + `service`／`iam`，R2 用的是 `auto` + `s3` —— 签名值由这个
/// 范围参与派生，任何一组常量写进函数体，另一组的向量就永远对不上（第一版就是这么
/// 写的：向量看着"验证过了"，其实签出来是另一串）。常量只留在 [`REGION`]/[`SERVICE`]，
/// 由网络层显式传进来。
#[allow(clippy::too_many_arguments)]
pub fn sign_request(
    access_key: &str,
    secret_key: &str,
    method: &str,
    path: &str,
    query: &str,
    headers: &[(&str, String)],
    payload_hash: &str,
    amz_date: &str,
    region: &str,
    service: &str,
) -> Signature {
    let date = &amz_date[..8]; // YYYYMMDDTHHMMSSZ
    let canonical = canonical_request(method, path, query, headers, payload_hash);
    let chash = sha256_hex(canonical.as_bytes());
    // 参与签名的头名（排序后的小写列表）必须与规范请求里那一行**逐字相同**
    let mut names: Vec<String> = headers.iter().map(|(k, _)| k.to_ascii_lowercase()).collect();
    names.sort();
    let signed_headers = names.join(";");
    let sc = scope(date, region, service);
    let sts = string_to_sign(amz_date, &sc, &chash);
    let key = signing_key(secret_key, date, region, service);
    let sig = hex::encode(hmac_sha256(&key, sts.as_bytes()));
    Signature {
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={access_key}/{sc}, SignedHeaders={signed_headers}, Signature={sig}"
        ),
    }
}

fn amz_date_now() -> String {
    Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

// ══ 凭据（只从 .env 读）══════════════════════════════════════════════════════

pub const IMAGE_ENV_KEYS: [&str; 3] = [
    "R2_IMAGE_ENDPOINT",
    "R2_IMAGE_ACCESS_KEY",
    "R2_IMAGE_SECRET_KEY",
];

/// 部署链那组（`scripts/deploy/upload_to_r2.py` 与 `deploy_from_r2.sh` 读的同一组）。
/// 图库里它只作回落 —— **别把图片桶加进它**（那等于让部署令牌多担一份权限，见文件头）。
pub const DEPLOY_ENV_KEYS: [&str; 3] = ["R2_ENDPOINT", "R2_ACCESS_KEY", "R2_SECRET_KEY"];

/// R2 凭据。**不进 `web_info`、不进任何接口、不进日志**。
#[derive(Debug, Clone)]
pub struct Creds {
    /// 归一后的 endpoint（无尾 `/`），例：`https://<account>.r2.cloudflarestorage.com`
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    /// 这对凭据里有没有「图库专用」的成分（三项里任意一项取自 `R2_IMAGE_*`）。
    /// **只用于面板上那行"凭据来源"**：配错令牌时一眼看出用的是哪一对，
    /// 不必再去猜"列桶为什么 403"。
    pub image_token: bool,
}

impl Creds {
    /// endpoint 里的主机名（SigV4 的 `host` 头与 `Host` 都是它）。
    fn host(&self) -> &str {
        let rest = self
            .endpoint
            .splitn(2, "://")
            .nth(1)
            .unwrap_or(self.endpoint.as_str());
        rest.split('/').next().unwrap_or(rest)
    }

    /// 对象请求的 path（**path-style**：`/<桶>/<键>`，键已百分号编码）。
    fn path_of(&self, bucket: &str, key: &str) -> String {
        format!("/{}/{}", bucket, uri_encode(key, true))
    }
}

/// 从"取变量"的闭包解析凭据（纯函数 —— 单测直接喂一个 map，不碰进程环境）。
///
/// **逐项回落**：每项先看 `R2_IMAGE_<X>`，缺席或空串则用 `R2_<X>`。于是 `.env` 只加
/// `R2_IMAGE_ACCESS_KEY` / `R2_IMAGE_SECRET_KEY` 两行就能生效（endpoint 同一个账号、
/// 照旧回落），**一个都不加 ⇒ 与从前逐字节相同**（部署那组照旧）。
///
/// **三项全无 ⇒ `None`**（= 没配 R2 ⇒ 走本地盘）。endpoint 补 scheme：R2 控制台给的
/// 那串不带 `https://`，手抄时也常被漏掉。
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

    // 混搭的令牌对（一半图库、一半部署）几乎一定是配置事故：签出来的名对不上，
    // 失败长相（SignatureDoesNotMatch）与"密钥抄错"分不开。当场喊一声。
    if ak_image != sk_image {
        tracing::warn!(
            "[r2] 凭据混搭：access key 来自 {}，secret 来自 {} —— 请成对配置（否则签名必失败）",
            if ak_image { IMAGE_ENV_KEYS[1] } else { DEPLOY_ENV_KEYS[1] },
            if sk_image { IMAGE_ENV_KEYS[2] } else { DEPLOY_ENV_KEYS[2] },
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

// ══ 网络 ════════════════════════════════════════════════════════════════════

/// 进程内单例（与 `routes/talks.rs::review_http` 同一形态）：每次请求新建 client
/// 等于每次重建连接池、放弃 keep-alive。**不动 `AppState`**（一个静态就够了，
/// 加字段会把"每个用到 state 的地方都要改"这件事扩散出去）。
fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder().build().unwrap_or_else(|e| {
            tracing::warn!("[r2] HTTP 客户端构建失败，退回默认: {e}");
            reqwest::Client::new()
        })
    })
}

/// 列表/HEAD/DELETE 的超时。**每次请求都设**（挪进 builder 会变成全局默认值，
/// 语义不同，见 `routes/talks.rs` 同款注释）。
const TIMEOUT_SHORT: std::time::Duration = std::time::Duration::from_secs(15);
/// PUT 的超时（要传 body，给宽一点）。
const TIMEOUT_PUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 一次签名请求所需的头（`host` / `x-amz-content-sha256` / `x-amz-date`）。
fn signed_headers(creds: &Creds, payload_hash: &str, amz_date: &str) -> Vec<(&'static str, String)> {
    vec![
        ("host", creds.host().to_string()),
        ("x-amz-content-sha256", payload_hash.to_string()),
        ("x-amz-date", amz_date.to_string()),
    ]
}

/// 发出一个已签名的请求，返回响应（不做状态码判定）。
async fn send(
    creds: &Creds,
    method: reqwest::Method,
    url: String,
    path: &str,
    query: &str,
    payload_hash: &str,
    body: Option<Vec<u8>>,
    content_type: Option<&str>,
    timeout: std::time::Duration,
) -> Result<reqwest::Response, String> {
    let amz_date = amz_date_now();
    let headers = signed_headers(creds, payload_hash, &amz_date);
    let sig = sign_request(
        &creds.access_key,
        &creds.secret_key,
        method.as_str(),
        path,
        query,
        &headers,
        payload_hash,
        &amz_date,
        REGION,
        SERVICE,
    );
    let mut req = http()
        .request(method, url)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", amz_date)
        .header("authorization", sig.authorization)
        .timeout(timeout);
    if let Some(ct) = content_type {
        req = req.header("content-type", ct);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    req.send().await.map_err(|e| format!("请求失败：{e}"))
}

/// 把响应体读成短文本（错误信息用；**不把整个 XML 塞进日志**）。
async fn brief_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let cut: String = text.chars().take(300).collect();
    format!("HTTP {} {}", status.as_u16(), cut.trim())
}

/// ListObjectsV2 的一页。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListPage {
    /// 这一页里每个对象的 `Size`
    pub sizes: Vec<u64>,
    pub truncated: bool,
    pub next_token: Option<String>,
}

/// 解析 ListObjectsV2 的响应。**只认三个字段**，任何一处读不出来 ⇒ `Err`
/// （fail-closed：宁可"暂时传不了图"，绝不"漏算用量"）。理由见模块头注。
///
/// 会被判红的形状（都有单测）：
///   · 响应里没有 `ListBucketResult`（多半是 `<Error>`）⇒ Err；
///   · `<Size>` 的内容不是数字 ⇒ Err（跳过一个就等于少算一个对象）；
///   · `IsTruncated=true` 却没有 `NextContinuationToken` ⇒ Err
///     （少了它就会把第一页当成全部，用量被低估 —— 这正是"账单"那类事故的形状）。
pub fn parse_list_v2(xml: &str) -> Result<ListPage, String> {
    if !xml.contains("<ListBucketResult") {
        return Err(format!("不是 ListObjectsV2 的响应：{}", first_tag(xml)));
    }
    if xml.contains("<Error>") && !xml.contains("</ListBucketResult>") {
        return Err(format!("R2 返回了错误：{}", first_tag(xml)));
    }
    let mut page = ListPage::default();
    for raw in all_tags(xml, "Size") {
        let v = raw.trim().parse::<u64>().map_err(|_| {
            format!("<Size> 不是数字：{:?}", raw.chars().take(40).collect::<String>())
        })?;
        page.sizes.push(v);
    }
    page.truncated = all_tags(xml, "IsTruncated")
        .first()
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    page.next_token = all_tags(xml, "NextContinuationToken")
        .first()
        .map(|v| xml_unescape(v.trim()));
    if page.truncated && page.next_token.as_deref().unwrap_or("").is_empty() {
        return Err("IsTruncated=true 但没有 NextContinuationToken（会漏算后面的对象）".to_string());
    }
    Ok(page)
}

/// 取一个标签的全部内容（`<Size>123</Size>` ⇒ `["123"]`）。
/// **只看原始字节里的标签**：S3 会把对象键里的 `<`/`&` 实体转义，所以键名里
/// 写不出一个真的 `<Size>` 标签（敌意样本见单测）。
fn all_tags<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        match after.find(&close) {
            Some(j) => {
                out.push(&after[..j]);
                rest = &after[j + close.len()..];
            }
            None => break, // 有开无闭 = 截断的响应，交给调用方（不猜内容）
        }
    }
    out
}

/// 响应里第一个标签名（错误信息用，别把整段 XML 打进日志）。
///
/// ⚠️ 按**字符**截断而不是按字节：`&t[..120]` 在 120 号字节正好落在一个汉字的
/// 中间时会 panic —— 而这个函数只在"服务端返回了非预期内容"时才跑，那正是
/// 最容易被塞进一段中文错误页的时刻。少写一个 `chars()` 就是"错误信息本身引发 500"。
fn first_tag(xml: &str) -> String {
    let t = xml.trim_start();
    let end = t.find('>').map(|i| i + 1).unwrap_or(t.len());
    t[..end].chars().take(120).collect()
}

/// 解开 XML 的五个实体（S3 的续传 token 是 base64，可能带 `+`/`=`，一般不转义；
/// 但键名里出现 `&amp;` 是常态，token 里真出现也要能还原成原文才敢回传）。
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// 桶里**所有**对象的大小之和（翻页累加）。前缀只算这套图床自己那一层。
///
/// 失败 ⇒ `Err`（**fail-closed**，调用方必须拒绝本次上传）。翻页带上限：
/// 每页 1000 个，200 页就是 20 万个对象——远超本机规模，超过就报错而不是继续翻
/// （真正的死循环发生在"服务端一直说 truncated"这种病态情况下）。
pub async fn list_used_bytes(creds: &Creds, bucket: &str, prefix: &str) -> Result<u64, String> {
    let path = format!("/{bucket}");
    let mut total: u64 = 0;
    let mut token: Option<String> = None;
    for _ in 0..200 {
        let mut q: Vec<(String, String)> = vec![
            ("list-type".to_string(), "2".to_string()),
            ("max-keys".to_string(), "1000".to_string()),
        ];
        if !prefix.is_empty() {
            q.push(("prefix".to_string(), prefix.to_string()));
        }
        if let Some(t) = token.clone() {
            q.push(("continuation-token".to_string(), t));
        }
        let query = canonical_query(&q);
        let url = format!("{}{}?{}", creds.endpoint, path, query);
        let resp = send(
            creds,
            reqwest::Method::GET,
            url,
            &path,
            &query,
            EMPTY_SHA256,
            None,
            None,
            TIMEOUT_SHORT,
        )
        .await?;
        if !resp.status().is_success() {
            return Err(format!("列桶失败：{}", brief_body(resp).await));
        }
        let body = resp.text().await.map_err(|e| format!("读取列表响应失败：{e}"))?;
        let page = parse_list_v2(&body)?;
        total = total.saturating_add(page.sizes.iter().sum::<u64>());
        if !page.truncated {
            return Ok(total);
        }
        token = page.next_token;
        if token.is_none() {
            // parse_list_v2 已经把这种情况判成 Err；这里是双保险
            return Err("列表被截断但拿不到续传 token".to_string());
        }
    }
    Err("列桶翻页超过 200 页（用量读数不可信，已放弃）".to_string())
}

/// 规范查询串：按 key 排序 + 百分号编码（SigV4 要求，服务端会按同一规则重算）。
fn canonical_query(pairs: &[(String, String)]) -> String {
    let mut v: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, val)| (uri_encode(k, false), uri_encode(val, false)))
        .collect();
    v.sort();
    v.iter()
        .map(|(k, val)| format!("{k}={val}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// 对象是否存在。`404` ⇒ `false`（不存在）；`200` ⇒ `true`；其余 ⇒ `Err`
/// （**不许把 403/超时当成"不存在"**：那会导致"明明有却重新 PUT 一份"）。
pub async fn head_object(creds: &Creds, bucket: &str, key: &str) -> Result<bool, String> {
    let path = creds.path_of(bucket, key);
    let url = format!("{}{}", creds.endpoint, path);
    let resp = send(
        creds,
        reqwest::Method::HEAD,
        url,
        &path,
        "",
        EMPTY_SHA256,
        None,
        None,
        TIMEOUT_SHORT,
    )
    .await?;
    match resp.status().as_u16() {
        200..=299 => Ok(true),
        404 => Ok(false),
        _ => Err(format!("HEAD 失败：{}", brief_body(resp).await)),
    }
}

/// 上传对象。**失败就是失败**：调用方不许回落本地盘（见 `routes/upload.rs`），
/// 否则"面板上写着存 R2、图其实在本机盘上"这件事没人看得出来。
pub async fn put_object(
    creds: &Creds,
    bucket: &str,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let path = creds.path_of(bucket, key);
    let url = format!("{}{}", creds.endpoint, path);
    let hash = sha256_hex(&body);
    // ⚠️ body 在这里被移动进请求；payload_hash 必须先算好（签名要它）
    let resp = send(
        creds,
        reqwest::Method::PUT,
        url,
        &path,
        "",
        &hash,
        Some(body),
        Some(content_type),
        TIMEOUT_PUT,
    )
    .await?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("上传失败：{}", brief_body(resp).await))
    }
}

/// 删除对象。**`404` 也算成功**（对象本来就不在 = 目的已达成），
/// 其余非 2xx ⇒ `Err`（调用方据此**不删库里的行**）。
pub async fn delete_object(creds: &Creds, bucket: &str, key: &str) -> Result<(), String> {
    let path = creds.path_of(bucket, key);
    let url = format!("{}{}", creds.endpoint, path);
    let resp = send(
        creds,
        reqwest::Method::DELETE,
        url,
        &path,
        "",
        EMPTY_SHA256,
        None,
        None,
        TIMEOUT_SHORT,
    )
    .await?;
    match resp.status().as_u16() {
        200..=299 | 404 => Ok(()),
        _ => Err(format!("删除失败：{}", brief_body(resp).await)),
    }
}

// ══ 单测 ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests;
