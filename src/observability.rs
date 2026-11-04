//! HTTP correlation and lifecycle logging through Tower HTTP and tracing-subscriber.

use axum::{
    extract::{MatchedPath, Request},
    middleware::{self, Next},
    response::Response,
    Router,
};
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::{DefaultOnEos, DefaultOnFailure, DefaultOnRequest, DefaultOnResponse, TraceLayer},
};
use tracing::Level;
use tracing_subscriber::{fmt::format::FmtSpan, EnvFilter};

pub fn init() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,sea_orm=warn,hyper=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_timer(tracing_subscriber::fmt::time::ChronoLocal::new(
            "%Y-%m-%dT%H:%M:%S%.3f%z".to_owned(),
        ))
        .with_ansi(false)
        .with_span_events(FmtSpan::CLOSE)
        .init();
}

pub fn http(router: Router) -> Router {
    router
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request| {
                    let request_id = request
                        .headers()
                        .get("x-request-id")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("-");
                    let route = request
                        .extensions()
                        .get::<MatchedPath>()
                        .map(MatchedPath::as_str)
                        .unwrap_or("<unmatched>");
                    tracing::info_span!("http.request", service = "saudade-blog",
                        pid = std::process::id(), request_id, method = %request.method(), route)
                })
                .on_request(DefaultOnRequest::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO))
                .on_eos(DefaultOnEos::new().level(Level::INFO))
                .on_failure(DefaultOnFailure::new().level(Level::ERROR)),
        )
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(middleware::from_fn(normalize_request_id))
}

pub fn agent_stream_failed(
    request_id: &str,
    user_id: i32,
    conversation_id: i32,
    error: &eventsource_stream::EventStreamError<reqwest::Error>,
) {
    use eventsource_stream::EventStreamError;
    let (error_kind, timeout, body) = match error {
        EventStreamError::Transport(error) => ("transport", error.is_timeout(), error.is_body()),
        EventStreamError::Utf8(_) => ("invalid_utf8", false, false),
        EventStreamError::Parser(_) => ("invalid_event_stream", false, false),
    };
    tracing::warn!(
        request_id,
        user_id,
        conversation_id,
        error_kind,
        timeout,
        body,
        phase = "upstream_stream",
        "Agent SSE transport failed"
    );
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

async fn normalize_request_id(mut request: Request, next: Next) -> Response {
    let valid = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .is_some_and(valid_request_id);
    if !valid {
        request.headers_mut().remove("x-request-id");
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::StatusCode, routing::get};
    use tower::ServiceExt;

    #[tokio::test]
    async fn correlation_is_preserved_or_replaced_and_returned_on_errors() {
        for (provided, preserved) in [("r-valid_123", true), ("unsafe/id", false), ("", false)] {
            let app = http(Router::new().route("/denied", get(|| async { StatusCode::FORBIDDEN })));
            let response = app
                .oneshot(
                    Request::builder()
                        .uri("/denied?secret=not_logged")
                        .header("x-request-id", provided)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            let actual = response
                .headers()
                .get("x-request-id")
                .unwrap()
                .to_str()
                .unwrap();
            assert!(valid_request_id(actual));
            assert_eq!(actual == provided, preserved);
        }
    }

    #[test]
    fn request_id_bounds_reject_control_characters_paths_and_oversized_values() {
        for value in ["\nforged", "../path", "with space", &"x".repeat(129)] {
            assert!(!valid_request_id(value));
        }
    }

    #[derive(Clone)]
    struct LogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn trace_records_route_status_and_stream_completion_without_request_secrets() {
        use tracing::instrument::WithSubscriber;
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_span_events(FmtSpan::CLOSE)
            .with_writer(move || LogWriter(writer.clone()))
            .finish();
        let dispatch = tracing::Dispatch::new(subscriber);
        let app = http(Router::new().route("/items/{id}", get(|| async { "ok" })));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/items/7?token=QUERY_CANARY")
                    .header("x-request-id", "r-log-fixture")
                    .header("authorization", "TOKEN_CANARY")
                    .body(Body::from("BODY_CANARY"))
                    .unwrap(),
            )
            .with_subscriber(dispatch.clone())
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .with_subscriber(dispatch)
            .await
            .unwrap();
        assert_eq!(body, "ok");
        let output = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        assert!(output.contains("r-log-fixture") && output.contains("/items/{id}"));
        assert!(output.contains("status=200") && output.contains("end of stream"));
        assert!(!output.contains("CANARY"));
    }

    #[tokio::test]
    async fn stream_diagnostics_classify_failures_without_formatting_private_error_content() {
        let error = reqwest::Client::new()
            .get("file:///STREAM_URL_CANARY")
            .send()
            .await
            .unwrap_err();
        assert!(error.to_string().contains("STREAM_URL_CANARY"));
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer(move || LogWriter(writer.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            agent_stream_failed(
                "r-stream-fixture",
                7,
                42,
                &eventsource_stream::EventStreamError::Transport(error),
            );
            let invalid = String::from_utf8(vec![b'x', 0xff]).unwrap_err();
            agent_stream_failed(
                "r-stream-fixture",
                7,
                42,
                &eventsource_stream::EventStreamError::Utf8(invalid),
            );
        });
        let output = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        assert!(output.contains("r-stream-fixture") && output.contains("upstream_stream"));
        assert!(output.contains("transport") && output.contains("invalid_utf8"));
        assert!(!output.contains("STREAM_URL_CANARY"));
    }
}
