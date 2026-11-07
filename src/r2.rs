use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::Utc;
use hmac::{Hmac, KeyInit, Mac};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter};
use sha2::{Digest, Sha256};

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

/// 空请求体的 SHA-256，用于无体 S3 请求。
pub const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// R2 请求使用的 SigV4 区域与服务。
const REGION: &str = "auto";
const SERVICE: &str = "s3";

// 配置

/// 图库 R2 的配置面（不含凭据）。
#[derive(Debug, Clone, PartialEq)]
pub struct R2Config {
    /// 面板上的总开关。**只有它是 `true` 且三样都填全了才会走 R2**（见 [`Self::active`]）
    pub enabled: bool,
    pub bucket: String,
    /// 对象键命名空间，归一后两端无斜杠；空值视为未配置。
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

/// 配额那一格（GB，可以是小数）。**非正数 / 非数字 / NaN / 无穷 ⇒ 回落默认值**。
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

/// 对象键 ⇒ 存进库的公开地址（**原样、不编码**，编码发生在请求那一层）。
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

// SigV4（纯函数）

type HmacSha256 = Hmac<Sha256>;

/// SHA-256 的小写十六进制编码。
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

/// 按日期、区域和服务派生 SigV4 请求签名密钥。
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k = hmac_sha256(&k, region.as_bytes());
    let k = hmac_sha256(&k, service.as_bytes());
    hmac_sha256(&k, b"aws4_request")
}

/// SigV4 百分号编码；路径可以保留斜杠，其余按字节使用大写十六进制。
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

/// 规范请求按名称排序请求头，并归一名称大小写与头值空白。
pub fn canonical_request(
    method: &str,
    path: &str,
    query: &str,
    headers: &[(&str, String)],
    payload_hash: &str,
) -> String {
    let mut hs: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), collapse_ws(v)))
        .collect();
    hs.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = hs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = hs
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}")
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

/// 纯 SigV4 签名函数；日期、区域与服务由调用方显式传入。
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
    let mut names: Vec<String> = headers
        .iter()
        .map(|(k, _)| k.to_ascii_lowercase())
        .collect();
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

// 凭据由进程环境提供。

pub const IMAGE_ENV_KEYS: [&str; 3] = [
    "R2_IMAGE_ENDPOINT",
    "R2_IMAGE_ACCESS_KEY",
    "R2_IMAGE_SECRET_KEY",
];

/// 部署凭据作为图库专用凭据缺失时的回落来源。
pub const DEPLOY_ENV_KEYS: [&str; 3] = ["R2_ENDPOINT", "R2_ACCESS_KEY", "R2_SECRET_KEY"];

/// R2 凭据。**不进 `web_info`、不进任何接口、不进日志**。
#[derive(Debug, Clone)]
pub struct Creds {
    /// 归一后的 endpoint（无尾 `/`），例：`https://<account>.r2.cloudflarestorage.com`
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    /// 是否使用图库专用凭据，用于面板展示配置来源。
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

// 网络

/// 复用进程内 HTTP 连接池。
fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder().build().unwrap_or_else(|e| {
            tracing::warn!("[r2] HTTP 客户端构建失败，退回默认: {e}");
            reqwest::Client::new()
        })
    })
}

/// 列表、HEAD 和 DELETE 的单请求超时。
const TIMEOUT_SHORT: std::time::Duration = std::time::Duration::from_secs(15);
/// PUT 的超时（要传 body，给宽一点）。
const TIMEOUT_PUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 一次签名请求所需的头（`host` / `x-amz-content-sha256` / `x-amz-date`）。
fn signed_headers(
    creds: &Creds,
    payload_hash: &str,
    amz_date: &str,
) -> Vec<(&'static str, String)> {
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

/// 解析列表大小和分页信息；缺少必需字段或非法值时返回错误。
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
            format!(
                "<Size> 不是数字：{:?}",
                raw.chars().take(40).collect::<String>()
            )
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
        return Err(
            "IsTruncated=true 但没有 NextContinuationToken（会漏算后面的对象）".to_string(),
        );
    }
    Ok(page)
}

/// 提取原始 XML 中指定标签的内容；键中的实体不作为标签。
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

/// 为错误诊断提取首个 XML 标签，按字符截断。
fn first_tag(xml: &str) -> String {
    let t = xml.trim_start();
    let end = t.find('>').map(|i| i + 1).unwrap_or(t.len());
    t[..end].chars().take(120).collect()
}

/// 还原 XML 的五种基本实体。
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// 分页累计图库命名空间内的对象大小；失败或超过页数上限时拒绝上传。
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
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取列表响应失败：{e}"))?;
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

/// 上传失败保持错误，不切换存储目标。
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
    // 移动请求体之前先计算用于签名的摘要。
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

/// 2xx 或 404 表示删除完成，其余响应返回错误。
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

// 单测

#[cfg(test)]
mod tests;
