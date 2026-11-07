//! Streaming has separate connection, response-header and event-idle deadlines.
use std::{sync::OnceLock, time::Duration};
pub(super) const IDLE: Duration = Duration::from_secs(120);
pub(super) fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("chat HTTP client configuration")
    })
}
pub(super) async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    tokio::time::timeout(Duration::from_secs(15), request.send())
        .await
        .map_err(|_| "agent response headers timed out".to_owned())?
        .map_err(|e| e.to_string())
}
