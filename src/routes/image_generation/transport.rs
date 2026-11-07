//! An explicit provider-only proxy; reference downloads use a separate direct client.
use std::time::Duration;

pub fn proxy_url(value: &str) -> Result<Option<reqwest::Url>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let invalid = || "OPENAI_IMAGE_PROXY_URL 必须是 HTTP 或 HTTPS 代理地址".to_owned();
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(Some(url))
}

pub fn client(proxy: Option<&reqwest::Url>) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(240));
    if let Some(url) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(url.clone())?);
    }
    builder.build()
}

#[cfg(test)]
mod tests;
