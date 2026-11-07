//! Canonical public route locations shared by site metadata and search engines.
use reqwest::Url;

pub(super) fn site_base() -> Option<Url> {
    Url::parse(&crate::utils::site_url())
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
}

pub(super) fn page_url(site: &Url, segments: &[&str]) -> String {
    let mut url = site.clone();
    url.set_query(None);
    url.set_fragment(None);
    // Route locations share the sitemap's origin-rooted path and per-segment escaping.
    url.path_segments_mut()
        .expect("validated site URL")
        .clear()
        .extend(segments);
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn article_locations_use_the_configured_origin_and_existing_rooted_routes() {
        let site = Url::parse("https://example.test:8443/blog/?ref=test#section").unwrap();
        assert_eq!(
            page_url(&site, &["article", "42"]),
            "https://example.test:8443/article/42"
        );
        assert_eq!(
            page_url(&site, &["category", "Rust / 中文"]),
            "https://example.test:8443/category/Rust%20%2F%20%E4%B8%AD%E6%96%87"
        );
        assert_eq!(
            site.as_str(),
            "https://example.test:8443/blog/?ref=test#section"
        );
    }
}
