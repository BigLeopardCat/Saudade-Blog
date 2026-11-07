//! Validate configuration before accepting traffic or connecting to the database.
pub fn validate(value: Option<&str>) -> Result<(), &'static str> {
    let key = value.ok_or("missing signing key")?;
    let lower = key.to_ascii_lowercase();
    if key.trim() != key
        || key.len() < 32
        || key.chars().all(char::is_whitespace)
        || [
            "请换成",
            "改成你的",
            "change-me",
            "changeme",
            "change_this",
            "your-secret",
            "your_jwt_secret",
        ]
        .iter()
        .any(|v| lower.contains(v))
    {
        return Err("invalid signing key");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_missing_short_whitespace_and_published_templates() {
        for key in [
            None,
            Some(""),
            Some("short"),
            Some("                                "),
            Some("请换成一串随机字符"),
            Some("change-me-to-a-private-random-secret"),
            Some(" your-secret-key-with-more-than-32-bytes"),
        ] {
            assert!(validate(key).is_err());
        }
        assert!(validate(Some("f18c4218cf7e40888958d8cfc85e2419")).is_ok());
        assert!(validate(Some("私有测试密钥仅用于测试勿复用")).is_ok());
    }
}
