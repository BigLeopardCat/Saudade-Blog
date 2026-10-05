//! 图库的 R2 图床（20261006，用户第 3 条）—— **SigV4 自己签 + 用量闸**。
//!
//! 需求原文：「图库给配置一个 R2 存储桶路径，因为服务器存储扛不住这么多图片，带宽也不够，
//! 可以选择上传到 R2 存储桶，注意严格控制 R2 存储桶空间用量最好给个用量条，超过 9.5G
//! 直接停用上传功能，防止产生账单。」
//!
//! 真正的收益不是"存得下"（本机还有盘），是**出图带宽离开这台机器**（上行 3M，
//! `/api/protect/download/` 一直是上行大头）；用量闸是硬要求——超了要停，不是提醒。
//!
//! ── 配置分两半住 ──────────────────────────────────────────────────────────
//! · **桶名 / 前缀 / 公开域名 / 配额 / 开关** 住 `web_info`（KV 表，**不需要迁移**，
//!   面板改完即生效）。键名只在 [`R2_KEYS`] 列一次，读侧、写侧、前端都引用这一组。
//! · **凭据**（`R2_IMAGE_*`，逐项回落到 `R2_*`）只从 `.env` 读，
//!   **绝不进 `web_info`、绝不进任何面板接口**（与 `openAiToken`/`githubToken` 那批
//!   被删掉的字段同一条取舍，见 `routes/web_info.rs`）。
//!   ⚠️ `R2_BUCKET` 是**部署桶**（`scripts/deploy/*` 往它传部署包），图像代码**永不读它**
//!   —— 桶名只从 `web_info` 取。这一条最容易被人"顺手复用"。
//!   ⚠️ **`R2_*` 那对是部署令牌、不是账号级**：R2 的 API 令牌**按桶授权**，部署那枚
//!   只管 `saudade-blog`（`deploy/<sha>/…` 全在它里面）。拿它去列图片桶 ⇒ `403
//!   AccessDenied` ⇒ 用量读不出来 ⇒ fail-closed 拦下上传 —— 症状长得像代码 bug。
//!   所以图库这一路优先读**图库专用**那一组（见 [`creds_from`]）。
//!
//! ── 为什么自己签 SigV4（而不是引 SDK）──────────────────────────────────────
//! R2 兼容 S3，签名就是 AWS SigV4（region `auto`、service `s3`、签名头
//! `host;x-amz-content-sha256;x-amz-date`）。引 `aws-sdk-s3` 要拉进几十个 crate；
//! 这里只用**已经在依赖树里**的 `hmac`（jsonwebtoken 带进来的，`Cargo.lock` 里本来就有，
//! 加一行只是多一条依赖边、零新增下载）与既有 `sha2`/`hex`/`reqwest`。
//! 代价是这段密码学代码得自己看住 —— 所以签名、编码、解析全部写成**纯函数**，
//! 用 AWS 官方向量（`get-vanilla` / IAM ListUsers 两例）与 RFC 4231 钉在单测里。
//!
//! ── 上传走服务端中转（不是预签名直传）──────────────────────────────────────
//! 浏览器直传 R2 本该更省带宽，但那要前端拿凭据或走一次预签名回环，而
//! **"同一份字节重复上传 ⇒ 复用既有文件"**（20260924 用户拍板的判据，见
//! `routes/upload.rs` 头注）要在服务端比对 sha256 才能成立；图库行、去重、配额判定
//! 三件事也得在同一个事务里做完。所以：**服务端 PUT，对象键 = 内容寻址**
//! （`<前缀>/<sha256 前 16 位>/<原名>`）—— 同一份字节重传天然落在同一个键上，
//! HEAD 命中就复用，与本地盘那条判据逐字同形。
//!
//! ── 用量真值取自 R2 自己 ──────────────────────────────────────────────────
//! `ListObjectsV2` 翻页累加 `Size`。**不查 `SUM(image.size)`**：那个数只在图片从图库
//! 页上传时才是准的（文章正文插图不走图库行），而且它算的是"本站在这个桶里记过账的
//! 那些"，不是"桶里真占了多少"。账单认的是后者。
//!
//! **解析 XML 不引依赖**：S3 的响应里对象键是**实体转义**过的，原始字节里的
//! `<Size>` 只可能是真标签，所以只扫 `<Contents>` 里的 `<Size>`、`<IsTruncated>`、
//! `<NextContinuationToken>` 三个字段是安全的。**解析不出来一律 `Err`（fail-closed）**：
//! 最坏的结果是"暂时传不了图"，绝不会是"漏算用量、账单照跑"。

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::Utc;
use hmac::{Hmac, Mac};
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

/// 原文件名里不适合进 URL 路径的字符换成 `_`。
///
/// **存进库的 URL 是原样的中文名**（与本地盘那套 `/api/protect/download/20260912_封面.png`
/// 逐字同形，图库列表的 `assetDisplayName` 因此照旧显示人话）。URL 的正确性交给
/// 请求时那一层百分号编码（[`uri_encode`]），但 `#`/`?`/`%`/空格这几个字符在
/// **存下来的地址里**会改变语义（片段/查询/转义），所以在这里就换掉。
/// 换掉的只是这几个字符：汉字、`-`、`_`、`.` 全留。
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

/// 当前的 amz-date（`20150830T123600Z`，**UTC**）。日期那一半（`20150830`）在
/// [`sign_request`] 里从这串前 8 个字符取，不单独算一份——两份就是两个可能的漂移点。
fn amz_date_now() -> String {
    Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

// ══ 凭据（只从 .env 读）══════════════════════════════════════════════════════

/// 图库**专用**令牌的三个变量名（20261006 晚）。R2 的 API 令牌是**按桶授权**的，
/// 不是账号级：部署链那枚（[`DEPLOY_ENV_KEYS`]）只管部署桶，拿它列图片桶必得 `403
/// AccessDenied`。用户手里那枚图片桶令牌是独立的，就住在这一组。
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
mod tests {
    use super::*;

    fn cfg(bucket: &str, prefix: &str, base: &str) -> R2Config {
        R2Config {
            enabled: true,
            bucket: bucket.to_string(),
            prefix: prefix.to_string(),
            public_base: base.to_string(),
            quota_bytes: (DEFAULT_QUOTA_GB * GIB) as u64,
        }
    }

    // ── ① SigV4：AWS 官方测试向量 ───────────────────────────────────────────
    // 官方向量集里的 `get-vanilla`：GET / 到 example.amazonaws.com，只签 host 与
    // x-amz-date。**这三条常量（规范请求哈希、签名、以及 IAM 那条签名）在写代码之前
    // 先用一份独立实现（Python 标准库 hashlib/hmac）逐字算过一遍**，所以它们钉的是
    // 算法，不是"我们自己跑出来的结果"。
    //
    // ⚠️ 官方向量用的范围是 `us-east-1` + `service`，R2 用的是 `auto` + `s3`。
    // 签名值由这个范围参与派生 —— 所以下面显式传官方的范围，最后再单测一条
    // "网络层确实用 R2 的范围在签"（[`r2_scope_is_used`]）。把常量写死进函数体的
    // 版本会让这组向量永远对不上，而"对不上"的表现只是 CI 里一条红——比线上 403 好抓，
    // 但仍然是一次白跑。
    #[test]
    fn sigv4_aws_get_vanilla_vector() {
        let headers = vec![
            ("host", "example.amazonaws.com".to_string()),
            ("x-amz-date", "20150830T123600Z".to_string()),
        ];
        let canon = canonical_request("GET", "/", "", &headers, EMPTY_SHA256);
        assert_eq!(
            canon,
            "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\n\
             host;x-amz-date\n\
             e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(canon.as_bytes()),
            "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63"
        );
        let sig = sign_request(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "GET",
            "/",
            "",
            &headers,
            EMPTY_SHA256,
            "20150830T123600Z",
            "us-east-1",
            "service",
        );
        assert!(
            sig.authorization.ends_with(
                "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
            ),
            "官方 get-vanilla 的签名对不上：{}",
            sig.authorization
        );
        assert!(sig.authorization.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, "
        ), "{}", sig.authorization);
    }

    /// AWS 文档里那个 IAM ListUsers 例子（带查询串与 content-type 头）。
    /// 它把"规范查询串要不要排序/编码"这件事也钉住了。
    #[test]
    fn sigv4_aws_list_users_vector() {
        let headers = vec![
            (
                "content-type",
                "application/x-www-form-urlencoded; charset=utf-8".to_string(),
            ),
            ("host", "iam.amazonaws.com".to_string()),
            ("x-amz-date", "20150830T123600Z".to_string()),
        ];
        let sig = sign_request(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "GET",
            "/",
            "Action=ListUsers&Version=2010-05-08",
            &headers,
            EMPTY_SHA256,
            "20150830T123600Z",
            "us-east-1",
            "iam",
        );
        assert!(
            sig.authorization.ends_with(
                "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
            ),
            "IAM ListUsers 的签名对不上：{}",
            sig.authorization
        );
    }

    /// 头顺序 / 头名大小写 / 值两侧空白 / 值中间连续空白 —— 这四种"看着一样"的输入
    /// 在 SigV4 里必须算出同一个规范请求（不然会出现"本地算对了、服务端 403"）。
    #[test]
    fn canonical_request_normalizes_headers() {
        let a = canonical_request(
            "GET",
            "/",
            "",
            &[
                ("x-amz-date", "20150830T123600Z".to_string()),
                ("Host", "example.amazonaws.com".to_string()),
            ],
            EMPTY_SHA256,
        );
        let b = canonical_request(
            "GET",
            "/",
            "",
            &[
                ("host", "  example.amazonaws.com  ".to_string()),
                ("X-Amz-Date", "20150830T123600Z".to_string()),
            ],
            EMPTY_SHA256,
        );
        assert_eq!(a, b, "头顺序/大小写/空白不该改变规范请求");
        assert!(a.contains("\nhost:example.amazonaws.com\nx-amz-date:"));
        let c = canonical_request(
            "GET",
            "/",
            "",
            &[("a", "x   y".to_string())],
            EMPTY_SHA256,
        );
        assert!(c.contains("a:x y\n"), "值中间连续空白要折成一个：{c:?}");
    }

    /// RFC 4231 的 Case 2（HMAC-SHA256 的标准向量）：把 HMAC 这一层单独钉住。
    #[test]
    fn hmac_rfc4231_case2() {
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// 派生密钥对日期/区域/服务敏感（换一个就变）—— 这三样是签名的上下文，
    /// 写错任何一样都会 403，而 403 的消息（SignatureDoesNotMatch）不说哪里错了。
    #[test]
    fn signing_key_is_scoped() {
        let base = signing_key("secret", "20150830", "auto", "s3");
        assert_eq!(base, signing_key("secret", "20150830", "auto", "s3"));
        assert_ne!(base, signing_key("secret", "20150831", "auto", "s3"));
        assert_ne!(base, signing_key("secret", "20150830", "us-east-1", "s3"));
        assert_ne!(base, signing_key("secret", "20150830", "auto", "iam"));
        assert_ne!(base, signing_key("secret2", "20150830", "auto", "s3"));
        assert_eq!(base.len(), 32);
    }

    /// 网络层确实拿 R2 的范围在签（`auto` / `s3`）：官方向量走的是别的范围，
    /// 这条负责把"常量被谁用"这件事钉住，免得有人觉得那两条常量没人引用就删掉。
    #[test]
    fn r2_scope_is_used() {
        assert_eq!(REGION, "auto");
        assert_eq!(SERVICE, "s3");
        assert_eq!(scope("20150830", REGION, SERVICE), "20150830/auto/s3/aws4_request");
        let sig = sign_request(
            "ak",
            "sk",
            "GET",
            "/bucket/",
            "",
            &signed_headers(
                &Creds {
                    endpoint: "https://acc.r2.cloudflarestorage.com".to_string(),
                    access_key: "ak".to_string(),
                    secret_key: "sk".to_string(),
                    image_token: false,
                },
                EMPTY_SHA256,
                "20150830T123600Z",
            ),
            EMPTY_SHA256,
            "20150830T123600Z",
            REGION,
            SERVICE,
        );
        assert!(
            sig.authorization.contains("/20150830/auto/s3/aws4_request"),
            "{}",
            sig.authorization
        );
    }

    // ── ② 编码 ──────────────────────────────────────────────────────────────
    #[test]
    fn uri_encode_rules() {
        assert_eq!(uri_encode("abcXYZ019-_.~", false), "abcXYZ019-_.~");
        assert_eq!(uri_encode("a b", false), "a%20b");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
        assert_eq!(uri_encode("a/b", true), "a/b");
        assert_eq!(uri_encode("1+1=2", false), "1%2B1%3D2");
        // 中文按 UTF-8 逐字节编码（三个字节 ⇒ 三组 %XX，大写）
        assert_eq!(uri_encode("图", false), "%E5%9B%BE");
        assert_eq!(uri_encode("封面.png", true), "%E5%B0%81%E9%9D%A2.png");
        // `*` 不是 unreserved（SigV4 与 RFC 3986 一致，比 JS 的 encodeURIComponent 更严）
        assert_eq!(uri_encode("*", false), "%2A");
    }

    #[test]
    fn canonical_query_sorts_and_encodes() {
        let q = canonical_query(&[
            ("prefix".to_string(), "图库/a b".to_string()),
            ("list-type".to_string(), "2".to_string()),
        ]);
        assert_eq!(q, "list-type=2&prefix=%E5%9B%BE%E5%BA%93%2Fa%20b");
        // 同 key 不同值也要有确定顺序（这里只保证稳定有序，不是要求什么业务含义）
        assert_eq!(
            canonical_query(&[("b".to_string(), "2".to_string()), ("a".to_string(), "1".to_string())]),
            "a=1&b=2"
        );
    }

    // ── ③ 归一化 / 键 / URL ─────────────────────────────────────────────────
    #[test]
    fn normalize_prefix_and_base() {
        assert_eq!(normalize_prefix("/gallery/"), "gallery");
        assert_eq!(normalize_prefix("  gallery  "), "gallery");
        assert_eq!(normalize_prefix("/"), "");
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("a/b/"), "a/b");

        assert_eq!(
            normalize_base("https://img.example.com/"),
            Some("https://img.example.com".to_string())
        );
        assert_eq!(
            normalize_base(" http://img.example.com/blog/ "),
            Some("http://img.example.com/blog".to_string())
        );
        // 非 http(s)、只有 scheme、空串 ⇒ 都不算配好
        assert_eq!(normalize_base("img.example.com"), None);
        assert_eq!(normalize_base("ftp://img.example.com"), None);
        assert_eq!(normalize_base("https://"), None);
        assert_eq!(normalize_base(""), None);
    }

    #[test]
    fn object_key_is_content_addressed() {
        let digest = "a".repeat(64);
        assert_eq!(
            object_key("gallery", &digest, "EMQX.png"),
            format!("gallery/{}/EMQX.png", "a".repeat(16))
        );
        // 同一份字节 + 同一个名字 ⇒ 同一个键（这就是"重传复用"的立足点）
        assert_eq!(
            object_key("gallery", &digest, "EMQX.png"),
            object_key("/gallery/", &digest, "EMQX.png")
        );
        // 不同字节 ⇒ 不同键（同名也不覆盖）
        assert_ne!(
            object_key("gallery", &digest, "EMQX.png"),
            object_key("gallery", "b", "EMQX.png")
        );
        // 名字里的危险字符被换掉；路径成分被砍掉（否则会在桶里凭空多一层）
        assert_eq!(
            object_key("g", &digest, "a b#c?d%e.png"),
            format!("g/{}/a_b_c_d_e.png", "a".repeat(16))
        );
        assert_eq!(
            object_key("g", &digest, "dir/sub/evil.png"),
            format!("g/{}/evil.png", "a".repeat(16))
        );
        // 汉字留着（库里的地址要给人看）
        assert!(object_key("g", &digest, "封面.png").ends_with("/封面.png"));
        // 名字空了 / 或被换成了一串下划线 ⇒ 兜底名（对象键不许以 `/` 结尾）
        for junk in ["", "   ", "#", "///", "??"] {
            assert_eq!(
                object_key("g", &digest, junk),
                format!("g/{}/image", "a".repeat(16)),
                "{junk:?} 应落到兜底名"
            );
        }
        // 有点怪但正常的名字照留
        assert!(object_key("g", &digest, "....").ends_with("/...."));
        assert!(object_key("g", &digest, "-_-").ends_with("/-_-"));
        // 前缀留空时不留前导斜杠
        assert!(object_key("", &digest, "a.png").starts_with(&"a".repeat(16)));
    }

    #[test]
    fn public_url_and_reverse() {
        let c = cfg("img", "gallery", "https://img.example.com");
        assert_eq!(
            public_url(&c.public_base, "gallery/abc/封面.png"),
            "https://img.example.com/gallery/abc/封面.png"
        );
        assert_eq!(
            r2_key_of("https://img.example.com/gallery/abc/封面.png", &c),
            Some("gallery/abc/封面.png".to_string())
        );
        // 换过公开域名 ⇒ 认不出来（刻意的：不猜别的桶/别的键）
        assert_eq!(r2_key_of("https://old.example.com/gallery/abc/a.png", &c), None);
        // 本地那套地址也认不出来（上面没有公开域名前缀）
        assert_eq!(r2_key_of("/api/protect/download/20260912013218_a.png", &c), None);
        // 只有前缀、没有键 ⇒ None
        assert_eq!(r2_key_of("https://img.example.com/", &c), None);
        // 没配公开域名 ⇒ 什么都认不出来
        assert_eq!(
            r2_key_of("https://img.example.com/a.png", &cfg("img", "g", "")),
            None
        );
    }

    // ── ④ 配额 ──────────────────────────────────────────────────────────────
    #[test]
    fn quota_boundaries() {
        let limit = (DEFAULT_QUOTA_GB * GIB) as u64;
        assert_eq!(limit, 10_200_547_328); // 9.5 × 1024³（= 10.2 GB 十进制，别按 10^9 算）
        assert!(!quota_exceeded(0, 1000, limit));
        // 恰好等于上限 ⇒ 放行（判据是 `>`，不是 `>=`）
        assert!(!quota_exceeded(limit - 1, 1, limit));
        assert!(!quota_exceeded(limit, 0, limit));
        // 超 1 字节 ⇒ 拒
        assert!(quota_exceeded(limit, 1, limit));
        assert!(quota_exceeded(limit - 1, 2, limit));
        // 已经超了（比如配额被调小）⇒ 一律拒，哪怕这一张是 0 字节
        assert!(quota_exceeded(limit + 1, 0, limit));
        // 回绕防护：u64::MAX 附近相加不许绕成小数
        assert!(quota_exceeded(u64::MAX, 1, limit));
        assert!(quota_exceeded(u64::MAX - 1, 5, limit));
    }

    // ── ⑤ 配置解析 ──────────────────────────────────────────────────────────
    fn kv<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k: &str| {
            pairs
                .iter()
                .find(|(name, _)| *name == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn parse_config_defaults() {
        // 缺键 ⇒ 未配置（active=false ⇒ 走本地盘）
        let c = parse_config(kv(&[]));
        assert!(!c.active());
        assert_eq!(c.quota_bytes, (DEFAULT_QUOTA_GB * GIB) as u64);
        assert!(c.bucket.is_empty() && c.prefix.is_empty() && c.public_base.is_empty());
    }

    #[test]
    fn parse_config_full_and_normalized() {
        let c = parse_config(kv(&[
            ("r2ImageBucket", " my-bucket "),
            ("r2ImagePrefix", "/gallery/"),
            ("r2ImagePublicBase", "https://img.example.com/"),
            ("r2ImageQuotaGB", "9.5"),
            ("r2ImageEnabled", "true"),
        ]));
        assert!(c.active());
        assert_eq!(c.bucket, "my-bucket");
        assert_eq!(c.prefix, "gallery");
        assert_eq!(c.public_base, "https://img.example.com");
        assert_eq!(c.quota_bytes, (9.5 * GIB) as u64);
    }

    #[test]
    fn parse_config_dirty_values() {
        // 脏配额 ⇒ 回落 9.5GiB（不是 0、不是无上限）
        for bad in ["", "abc", "0", "-1", "NaN", "inf", "9,5"] {
            let c = parse_config(kv(&[("r2ImageQuotaGB", bad)]));
            assert_eq!(
                c.quota_bytes,
                (DEFAULT_QUOTA_GB * GIB) as u64,
                "配额键 {bad:?} 应回落默认值"
            );
        }
        // 合法的自定义配额照样吃
        assert_eq!(
            parse_config(kv(&[("r2ImageQuotaGB", "2")])).quota_bytes,
            2 * 1024 * 1024 * 1024
        );
        // 小数也吃
        assert_eq!(
            parse_config(kv(&[("r2ImageQuotaGB", "0.5")])).quota_bytes,
            512 * 1024 * 1024
        );
    }

    #[test]
    fn parse_config_enabled_only_true() {
        for on in ["true", " true ", "TRUE", "True"] {
            assert!(parse_config(kv(&[("r2ImageEnabled", on)])).enabled, "{on:?} 应为开");
        }
        for off in ["false", "", "1", "yes", "on", "0", "是"] {
            assert!(!parse_config(kv(&[("r2ImageEnabled", off)])).enabled, "{off:?} 应为关");
        }
    }

    #[test]
    fn active_needs_all_four() {
        let full = [
            ("r2ImageBucket", "b"),
            ("r2ImagePrefix", "p"),
            ("r2ImagePublicBase", "https://x.example.com"),
            ("r2ImageEnabled", "true"),
        ];
        assert!(parse_config(kv(&full)).active());
        // 逐一拿掉一格 ⇒ 就不算配好（回落本地盘，不存在"配一半就往上写"）
        for i in 0..4 {
            let mut v: Vec<(&str, &str)> = full.to_vec();
            v[i] = (full[i].0, if i == 3 { "false" } else { "" });
            assert!(!parse_config(kv(&v)).active(), "拿掉 {:?} 之后不该是 active", full[i].0);
        }
    }

    // ── ⑥ ListObjectsV2 解析 ────────────────────────────────────────────────
    const LIST_OK: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>bucket</Name><Prefix>gallery/</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys>
<IsTruncated>false</IsTruncated>
<Contents><Key>gallery/ab/EMQX.png</Key><LastModified>2026-10-06T00:00:00.000Z</LastModified>
<ETag>"x"</ETag><Size>1024</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>gallery/cd/封面.png</Key><Size>2048</Size></Contents>
</ListBucketResult>"#;

    #[test]
    fn parse_list_ok() {
        let p = parse_list_v2(LIST_OK).unwrap();
        assert_eq!(p.sizes, vec![1024, 2048]);
        assert!(!p.truncated);
        assert_eq!(p.next_token, None);
    }

    /// 敌意样本：**对象键里写着一串字面的 `<Size>999</Size>`**。S3 会把键里的 `<`
    /// 转义成 `&lt;`，所以原始字节里那个 `<Size>` 只可能是真标签 —— 这条用例证明
    /// "只扫标签"这个简化是安全的，也证明我们确实按原始字节在扫。
    #[test]
    fn parse_list_hostile_key_is_not_counted() {
        let xml = r#"<ListBucketResult>
<Contents><Key>gallery/ab/&lt;Size&gt;999&lt;/Size&gt;.png</Key><Size>7</Size></Contents>
</ListBucketResult>"#;
        let p = parse_list_v2(xml).unwrap();
        assert_eq!(p.sizes, vec![7], "键名里那段转义过的 <Size> 不许被当成对象大小");
    }

    #[test]
    fn parse_list_fail_closed() {
        // 不是列表响应（比如 403 的错误体）
        assert!(parse_list_v2("<Error><Code>AccessDenied</Code></Error>").is_err());
        assert!(parse_list_v2("").is_err());
        assert!(parse_list_v2("<html><body>502</body></html>").is_err());
        // 有 Error 但没开始标签
        assert!(parse_list_v2("<?xml?><Error><Code>X</Code>").is_err());
        // `<Size>` 不是数字（少算一个对象 = 低估用量）
        assert!(parse_list_v2(
            "<ListBucketResult><Contents><Size>12a</Size></Contents></ListBucketResult>"
        )
        .is_err());
        // 负数（u64 解析失败）也算坏
        assert!(parse_list_v2(
            "<ListBucketResult><Contents><Size>-5</Size></Contents></ListBucketResult>"
        )
        .is_err());
        // 被截断却没有 token ⇒ Err（否则把第一页当全部，用量被低估）
        assert!(parse_list_v2(
            "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Size>1</Size></Contents></ListBucketResult>"
        )
        .is_err());
    }

    #[test]
    fn parse_list_pagination_fields() {
        let xml = r#"<ListBucketResult><IsTruncated>true</IsTruncated>
<Contents><Size>5</Size></Contents>
<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
</ListBucketResult>"#;
        let p = parse_list_v2(xml).unwrap();
        assert!(p.truncated);
        assert_eq!(
            p.next_token.as_deref(),
            Some("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=")
        );
        // 空 `<Contents/>`（桶里没东西）⇒ 0 个对象、不报错
        let empty = parse_list_v2("<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>").unwrap();
        assert!(empty.sizes.is_empty());
        assert!(!empty.truncated);
    }

    #[test]
    fn xml_unescape_covers_five_entities() {
        assert_eq!(xml_unescape("a&amp;b&lt;c&gt;d&quot;e&apos;f"), "a&b<c>d\"e'f");
        assert_eq!(xml_unescape("&amp;lt;"), "&lt;");
    }

    // ── ⑦ 凭据 ──────────────────────────────────────────────────────────────
    #[test]
    fn creds_host_and_path() {
        let c = Creds {
            endpoint: "https://acc.r2.cloudflarestorage.com".to_string(),
            access_key: "ak".to_string(),
            secret_key: "sk".to_string(),
            image_token: false,
        };
        assert_eq!(c.host(), "acc.r2.cloudflarestorage.com");
        assert_eq!(c.path_of("my-bucket", "gallery/ab/图.png"), "/my-bucket/gallery/ab/%E5%9B%BE.png");
        // 路径里的斜杠**不编码**（编码了就成了对象名的一部分，签名也会对不上）
        assert_eq!(c.path_of("b", "a/b/c.png"), "/b/a/b/c.png");
        let no_scheme = Creds {
            endpoint: "https://x.example.com".to_string(),
            ..c.clone()
        };
        assert_eq!(no_scheme.host(), "x.example.com");
    }

    /// 图库专用令牌优先、逐项回落部署那组（20261006 晚：列桶 403 的根因是"复用了部署
    /// 令牌"，而 R2 令牌是按桶授权的）。判据全是**选没选对那一组**，不涉及任何真密钥。
    #[test]
    fn creds_prefer_image_token_with_per_key_fallback() {
        let map = |pairs: &[(&str, &str)]| {
            let kv: Vec<(String, String)> = pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            move |k: &str| kv.iter().find(|(a, _)| a == k).map(|(_, b)| b.clone())
        };

        // ① 只加了两个新变量（endpoint 回落部署那项）+ scheme 补全 + 标记为图库令牌
        let c = creds_from(map(&[
            ("R2_IMAGE_ACCESS_KEY", "img-ak"),
            ("R2_IMAGE_SECRET_KEY", "img-sk"),
            ("R2_ENDPOINT", "acc.r2.cloudflarestorage.com"),
        ]))
        .expect("三项齐备");
        assert_eq!((c.access_key.as_str(), c.secret_key.as_str()), ("img-ak", "img-sk"));
        assert_eq!(c.endpoint, "https://acc.r2.cloudflarestorage.com");
        assert!(c.image_token);

        // ② 一个都不加 ⇒ 完全走部署那组（**行为与从前逐字节相同**）
        let c = creds_from(map(&[
            ("R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com"),
            ("R2_ACCESS_KEY", "d-ak"),
            ("R2_SECRET_KEY", "d-sk"),
        ]))
        .expect("部署那组齐备");
        assert_eq!(c.access_key, "d-ak");
        assert!(!c.image_token);

        // ③ 图库那组显式给 endpoint ⇒ 用它（换成别的账号也配得出来），尾斜杠照旧归一
        let c = creds_from(map(&[
            ("R2_IMAGE_ENDPOINT", "https://img.example.com/"),
            ("R2_IMAGE_ACCESS_KEY", "i"),
            ("R2_IMAGE_SECRET_KEY", "s"),
            ("R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com"),
        ]))
        .expect("两组都在时图库组赢");
        assert_eq!(c.endpoint, "https://img.example.com");

        // ④ 空串 = 没填（不能把空串当"给了个空值"用）
        let c = creds_from(map(&[
            ("R2_IMAGE_ACCESS_KEY", "  "),
            ("R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com"),
            ("R2_ACCESS_KEY", "d-ak"),
            ("R2_SECRET_KEY", "d-sk"),
        ]))
        .expect("空格回落部署那组");
        assert_eq!(c.access_key, "d-ak");
        assert!(!c.image_token);

        // ⑤ 缺一格（两个来源都没有 secret）⇒ None = 没配 R2，回落到本地盘
        assert!(creds_from(map(&[
            ("R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com"),
            ("R2_ACCESS_KEY", "d-ak"),
        ]))
        .is_none());
    }
}
