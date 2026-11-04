use serde::Serialize;
use std::time::Duration;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub configured: bool,
    pub models: Vec<String>,
    pub default_model: String,
}

pub struct Settings {
    pub key: String,
    pub base: String,
    pub models: Vec<String>,
}

impl Settings {
    pub fn load() -> Result<Self, String> {
        let key = std::env::var("OPENAI_IMAGE_API_KEY").unwrap_or_default();
        let base = std::env::var("OPENAI_IMAGE_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".into());
        let parsed = reqwest::Url::parse(&base).map_err(|_| "生图服务地址无效")?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("生图服务必须使用无凭据的 HTTPS 地址".into());
        }
        let models: Vec<String> = std::env::var("OPENAI_IMAGE_MODELS")
            .unwrap_or_else(|_| "gpt-image-2.5-sunburst,gpt-image-2.5-flare,gpt-image-2".into())
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if key.trim().is_empty() || models.is_empty() || models.len() > 12 {
            return Err("尚未配置生图服务密钥或模型列表".into());
        }
        Ok(Self {
            key,
            base: base.trim_end_matches('/').into(),
            models,
        })
    }

    pub fn client() -> Result<reqwest::Client, reqwest::Error> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(240))
            .build()
    }
}
