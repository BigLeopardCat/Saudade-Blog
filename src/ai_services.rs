//! Optional AI service endpoints. Blog publishing and manual review do not require an agent.

const DEFAULT_AGENT_CHAT_URL: &str = "http://127.0.0.1:8010/chat";

pub(crate) fn agent_chat_url() -> String {
    std::env::var("AGENT_URL").unwrap_or_else(|_| DEFAULT_AGENT_CHAT_URL.into())
}

pub(crate) fn agent_ready_endpoint(configured: Option<&str>) -> Option<String> {
    endpoint(
        None,
        Some(configured.unwrap_or(DEFAULT_AGENT_CHAT_URL)),
        "/ready",
    )
}

pub(crate) fn review_endpoint() -> Option<String> {
    let explicit = std::env::var("AI_REVIEW_URL").ok();
    let agent = std::env::var("AGENT_URL").ok();
    endpoint(explicit.as_deref(), agent.as_deref(), "/review")
}

pub(crate) fn graph_endpoint(path: &str) -> Option<String> {
    let explicit = std::env::var("GRAPH_SERVICE_URL").ok();
    let agent = std::env::var("AGENT_URL").ok();
    endpoint(explicit.as_deref(), agent.as_deref(), path)
}

pub(crate) fn agent_base_url() -> String {
    let raw = agent_chat_url();
    let value = raw.trim_end_matches('/');
    value
        .strip_suffix("/chat/stream")
        .or_else(|| value.strip_suffix("/chat"))
        .unwrap_or(value)
        .trim_end_matches('/')
        .to_string()
}

fn endpoint(explicit: Option<&str>, agent: Option<&str>, path: &str) -> Option<String> {
    // An explicitly blank override disables the integration, including the agent fallback.
    if let Some(value) = explicit {
        let value = value.trim().trim_end_matches('/');
        return (!value.is_empty()).then(|| {
            if path == "/review" {
                value.to_string()
            } else {
                format!("{value}{path}")
            }
        });
    }
    let value = agent?.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let base = value
        .strip_suffix("/chat/stream")
        .or_else(|| value.strip_suffix("/chat"))
        .unwrap_or(value)
        .trim_end_matches('/');
    Some(format!("{base}{path}"))
}

#[cfg(test)]
mod tests {
    use super::{agent_ready_endpoint, endpoint};

    #[test]
    fn diagnostics_uses_the_chat_default_but_respects_explicit_disable() {
        assert_eq!(
            agent_ready_endpoint(None),
            Some("http://127.0.0.1:8010/ready".into())
        );
        assert_eq!(agent_ready_endpoint(Some(" ")), None);
        for url in [
            "http://agent/chat",
            "http://agent/chat/stream/",
            "http://agent/",
        ] {
            assert_eq!(
                agent_ready_endpoint(Some(url)),
                Some("http://agent/ready".into())
            );
        }
    }

    #[test]
    fn absent_or_disabled_services_do_not_require_an_agent() {
        assert_eq!(endpoint(None, None, "/review"), None);
        assert_eq!(endpoint(None, Some(" "), "/review"), None);
        assert_eq!(
            endpoint(Some(" "), Some("http://agent/chat"), "/review"),
            None
        );
    }

    #[test]
    fn independent_services_override_agent_routing() {
        assert_eq!(
            endpoint(
                Some("http://moderator/v1/review/"),
                Some("http://agent/chat"),
                "/review"
            ),
            Some("http://moderator/v1/review".into())
        );
        assert_eq!(
            endpoint(Some("http://retrieval/"), None, "/graph/query"),
            Some("http://retrieval/graph/query".into())
        );
        for url in [
            "http://agent/chat",
            "http://agent/chat/stream/",
            "http://agent/",
        ] {
            assert_eq!(
                endpoint(None, Some(url), "/review"),
                Some("http://agent/review".into())
            );
        }
    }
}
