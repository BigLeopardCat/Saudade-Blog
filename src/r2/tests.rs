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

// 固定 SigV4 测试向量；日期、区域和服务显式指定。
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
    assert!(
        sig.authorization.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, "
        ),
        "{}",
        sig.authorization
    );
}

/// IAM ListUsers 签名向量包含查询串与 content-type。
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

/// 请求头排序、大小写与空白归一保持签名一致。
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
    let c = canonical_request("GET", "/", "", &[("a", "x   y".to_string())], EMPTY_SHA256);
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

/// RFC 4231 Case 6：长于 SHA-256 块大小的密钥必须先哈希，覆盖 digest 迁移边界。
#[test]
fn hmac_rfc4231_long_key() {
    assert_eq!(
        hex::encode(hmac_sha256(
            &[0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        )),
        "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
    );
}

/// 派生密钥绑定日期、区域和服务。
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

/// 网络请求使用 R2 的 auto/s3 签名范围。
#[test]
fn r2_scope_is_used() {
    assert_eq!(REGION, "auto");
    assert_eq!(SERVICE, "s3");
    assert_eq!(
        scope("20150830", REGION, SERVICE),
        "20150830/auto/s3/aws4_request"
    );
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

// ② 编码
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
        canonical_query(&[
            ("b".to_string(), "2".to_string()),
            ("a".to_string(), "1".to_string())
        ]),
        "a=1&b=2"
    );
}

// ③ 归一化 / 键 / URL
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

// ④ 配额
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

// ⑤ 配置解析
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

// ⑥ ListObjectsV2 解析
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

/// 对象键中的 XML 实体不能伪造 Size 标签。
#[test]
fn parse_list_hostile_key_is_not_counted() {
    let xml = r#"<ListBucketResult>
<Contents><Key>gallery/ab/&lt;Size&gt;999&lt;/Size&gt;.png</Key><Size>7</Size></Contents>
</ListBucketResult>"#;
    let p = parse_list_v2(xml).unwrap();
    assert_eq!(
        p.sizes,
        vec![7],
        "键名里那段转义过的 <Size> 不许被当成对象大小"
    );
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
    let empty =
        parse_list_v2("<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>").unwrap();
    assert!(empty.sizes.is_empty());
    assert!(!empty.truncated);
}

#[test]
fn xml_unescape_covers_five_entities() {
    assert_eq!(
        xml_unescape("a&amp;b&lt;c&gt;d&quot;e&apos;f"),
        "a&b<c>d\"e'f"
    );
    assert_eq!(xml_unescape("&amp;lt;"), "&lt;");
}

// ⑦ 凭据
#[test]
fn creds_host_and_path() {
    let c = Creds {
        endpoint: "https://acc.r2.cloudflarestorage.com".to_string(),
        access_key: "ak".to_string(),
        secret_key: "sk".to_string(),
        image_token: false,
    };
    assert_eq!(c.host(), "acc.r2.cloudflarestorage.com");
    assert_eq!(
        c.path_of("my-bucket", "gallery/ab/图.png"),
        "/my-bucket/gallery/ab/%E5%9B%BE.png"
    );
    // 路径里的斜杠**不编码**（编码了就成了对象名的一部分，签名也会对不上）
    assert_eq!(c.path_of("b", "a/b/c.png"), "/b/a/b/c.png");
    let no_scheme = Creds {
        endpoint: "https://x.example.com".to_string(),
        ..c.clone()
    };
    assert_eq!(no_scheme.host(), "x.example.com");
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
