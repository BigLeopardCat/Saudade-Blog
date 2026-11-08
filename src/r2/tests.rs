use super::*;

#[tokio::test]
async fn config_lookup_distinguishes_missing_settings_from_database_failure() {
    use sea_orm::{DatabaseBackend, MockDatabase};

    let empty = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<crate::entity::web_info::Model>::new()])
        .into_connection();
    assert_eq!(load_config(&empty).await.unwrap(), R2Config::default());

    let failed = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("fixture database unavailable".into())])
        .into_connection();
    assert!(load_config(&failed).await.is_err());
}

fn cfg(bucket: &str, prefix: &str, base: &str) -> R2Config {
    R2Config {
        enabled: true,
        bucket: bucket.to_string(),
        prefix: prefix.to_string(),
        public_base: base.to_string(),
        quota_bytes: (DEFAULT_QUOTA_GB * GIB) as u64,
    }
}

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
fn file_names_preserve_unicode_and_remove_path_controls() {
    assert_eq!(sanitize_file_name("a b#c?d%e.png"), "a_b_c_d_e.png");
    assert_eq!(sanitize_file_name("dir/sub/evil.png"), "evil.png");
    assert_eq!(sanitize_file_name("封面.png"), "封面.png");
    for junk in ["", "   ", "#", "///", "??"] {
        assert_eq!(sanitize_file_name(junk), "image", "{junk:?}");
    }
    assert_eq!(sanitize_file_name("...."), "....");
    assert_eq!(sanitize_file_name("-_-"), "-_-");
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
    assert_eq!(
        r2_key_of("https://old.example.com/gallery/abc/a.png", &c),
        None
    );
    // 本地文件地址不匹配 R2 的公开地址。
    assert_eq!(
        r2_key_of("/api/protect/download/20260912013218_a.png", &c),
        None
    );
    // 只有前缀、没有键 ⇒ None
    assert_eq!(r2_key_of("https://img.example.com/", &c), None);
    // 没配公开域名 ⇒ 什么都认不出来
    assert_eq!(
        r2_key_of("https://img.example.com/a.png", &cfg("img", "g", "")),
        None
    );
}

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
        assert!(
            parse_config(kv(&[("r2ImageEnabled", on)])).enabled,
            "{on:?} 应为开"
        );
    }
    for off in ["false", "", "1", "yes", "on", "0", "是"] {
        assert!(
            !parse_config(kv(&[("r2ImageEnabled", off)])).enabled,
            "{off:?} 应为关"
        );
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
        assert!(
            !parse_config(kv(&v)).active(),
            "拿掉 {:?} 之后不该是 active",
            full[i].0
        );
    }
}

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
    assert_eq!(
        (c.access_key.as_str(), c.secret_key.as_str()),
        ("img-ak", "img-sk")
    );
    assert_eq!(c.endpoint, "https://acc.r2.cloudflarestorage.com");
    assert!(c.image_token);

    let c = creds_from(map(&[
        ("R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com"),
        ("R2_ACCESS_KEY", "d-ak"),
        ("R2_SECRET_KEY", "d-sk"),
    ]))
    .expect("部署那组齐备");
    assert_eq!(c.access_key, "d-ak");
    assert!(!c.image_token);

    // 图库专用 endpoint 优先，尾斜杠归一。
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
