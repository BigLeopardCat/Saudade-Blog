use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;

fn draft() -> Draft {
    Draft {
        prompt: "画一幅山景，留白适合作为文章封面".into(),
        model: "gpt-image-2".into(),
        size: "1536x1024".into(),
        quality: "high".into(),
        reference_ids: vec![],
    }
}
#[test]
fn validates_price_and_reference_parameters_before_any_network() {
    let models = vec!["gpt-image-2".into()];
    assert!(draft().validate(&models).is_ok());
    let mut input = draft();
    input.reference_ids = vec![1, 1];
    assert!(input.validate(&models).is_err());
    input = draft();
    input.model = "unapproved-model".into();
    assert!(input.validate(&models).is_err());
    input = draft();
    input.quality = "unlimited".into();
    assert!(input.validate(&models).is_err());
    input = draft();
    input.prompt = " ".into();
    assert!(input.validate(&models).is_err());
}
#[test]
fn provider_receives_exact_approved_prompt_and_only_frozen_references() {
    let input = draft();
    let request = Request {
        provider: "https://api.openai.com/v1".into(),
        prompt: input.prompt.clone(),
        model: input.model,
        size: input.size,
        quality: input.quality,
        references: vec![],
    };
    let body = provider::payload(&request, &[]);
    assert_eq!(body["prompt"], input.prompt);
    assert_eq!(body["n"], 1);
    assert!(body.get("images").is_none());
    let body = provider::payload(&request, &[("image/png".into(), vec![1, 2, 3])]);
    assert_eq!(body["images"][0]["image_url"], "data:image/png;base64,AQID");
}
#[test]
fn malformed_provider_results_are_never_accepted_as_images() {
    assert!(provider::decode(br#"{"data":[{"url":"https://elsewhere/image.png"}]}"#).is_err());
    assert!(provider::decode(br#"{"data":[{"b64_json":"%%%"}]}"#).is_err());
    assert!(provider::decode(
        &serde_json::to_vec(&json!({"data":[{"b64_json":STANDARD.encode(b"not an image") }]}))
            .unwrap()
    )
    .is_err());
    assert!(serde_json::from_value::<Approval>(json!({"version":"a","prompt":"bypass"})).is_err());
}
#[tokio::test]
async fn job_ownership_and_versions_are_required_for_review() {
    use crate::rate_limiter::LoginRateLimiter;
    use sea_orm::{MockDatabase, MockExecResult};
    // A private job belonging to another actor must be absent before any mutation.
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<std::collections::BTreeMap<String, Value>>::new()])
        .append_exec_results([MockExecResult {
            last_insert_id: 0,
            rows_affected: 0,
        }])
        .into_connection();
    let state = AppState {
        db,
        rate_limiter: LoginRateLimiter::new(1, 60, 60),
        post_limiter: crate::risk::PostRateLimiter::default(),
        report_limiter: LoginRateLimiter::new(1, 60, 60),
    };
    assert!(
        jobs::read(&state, 99, "00000000-0000-0000-0000-000000000001")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn paid_provider_request_is_single_attempt_and_exact() {
    use axum::{extract::State, routing::post, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let count = Arc::new(AtomicUsize::new(0));
    async fn provider(
        State(count): State<Arc<AtomicUsize>>,
        Json(body): Json<JsonValue>,
    ) -> impl IntoResponse {
        count.fetch_add(1, Ordering::SeqCst);
        assert_eq!(body["n"], 1);
        assert_eq!(body["prompt"], "approved prompt");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":{"message":"not copied to UI"}})),
        )
    }
    let router = Router::new()
        .route("/images/generations", post(provider))
        .with_state(count.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let request = Request {
        provider: "https://api.openai.com/v1".into(),
        prompt: "approved prompt".into(),
        model: "fixture".into(),
        size: "1024x1024".into(),
        quality: "high".into(),
        references: vec![],
    };
    let config = settings::Settings {
        key: "test-only".into(),
        base,
        models: vec!["fixture".into()],
    };
    let error = provider::generate(config, &request, &[]).await.unwrap_err();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(!error.contains("not copied to UI"));
    server.abort();
}
