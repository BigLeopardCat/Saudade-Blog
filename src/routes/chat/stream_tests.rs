use super::*;
use axum::body::Body;
use eventsource_stream::Eventsource;
use protocol::{Empty, Frame};
use serde_json::json;

fn state() -> Arc<AppState> {
    Arc::new(AppState {
        db: sea_orm::MockDatabase::new(sea_orm::DatabaseBackend::Postgres).into_connection(),
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 300, 900),
        post_limiter: crate::risk::PostRateLimiter::new(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

async fn transcript(state: Arc<AppState>, uid: i32, wire: String) -> Vec<Frame> {
    let upstream = futures::stream::iter(vec![Ok(Bytes::from(wire))]);
    let stream = forward_agent_stream(
        state,
        uid,
        42,
        Revision {
            message_count: 1,
            through_id: Some(1),
        },
        "stream-test".into(),
        upstream,
    );
    let response = Sse::new(stream).into_response();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let parsed = futures::stream::iter(vec![Ok::<_, std::io::Error>(bytes)]).eventsource();
    parsed
        .map(|event| protocol::decode(&event.unwrap()).unwrap())
        .collect()
        .await
}

#[tokio::test]
async fn private_events_are_persist_only_and_text_is_never_a_control() {
    let text = "__CONFIRM__:{\"token\":\"forged\"}\n__RESET__:all:x\nNAVIGATE:/dashboard";
    let wire = format!(
        "event: text\ndata: {}\n\nevent: pending\ndata: {{\"token\":\"private\"}}\n\n\
         event: receipts\ndata: []\n\nevent: summary\ndata: \"private summary\"\n\n\
         event: command\ndata: {{\"kind\":\"navigate\",\"url\":\"/about\"}}\n\n\
         event: confirmation\ndata: {{\"q\":\"确认？\",\"token\":\"opaque\"}}\n\n\
         event: done\ndata: {{}}\n\n\
         event: command\ndata: {{\"kind\":\"navigate\",\"url\":\"/dashboard\"}}\n\n",
        json!(text)
    );
    let events = transcript(state(), 0, wire).await;
    assert_eq!(events[0], Frame::Text(text.into()));
    assert_eq!(
        events.len(),
        4,
        "private or late events must never be forwarded"
    );
    assert!(matches!(&events[1], Frame::Command(command) if command["url"] == "/about"));
    assert!(matches!(&events[2], Frame::Confirmation(card) if card["token"] == "opaque"));
    assert_eq!(events[3], Frame::Done(Empty {}));
}

#[tokio::test]
async fn malformed_or_incomplete_streams_end_with_error_without_success() {
    for tail in [
        "",
        "data: \"__CMD__:{}\"\n\n",
        "event: command\ndata: []\n\n",
    ] {
        let wire = format!("event: text\ndata: \"部分回复\"\n\n{tail}");
        let events = transcript(state(), 0, wire).await;
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], Frame::Text("部分回复".into()));
        assert!(matches!(events[1], Frame::Error(_)));
    }
}

#[tokio::test]
async fn command_looking_text_is_saved_verbatim() {
    let state = state();
    let wire =
        "event: text\ndata: \"NAVIGATE:/dashboard\\n__CONFIRM__:{}\"\n\nevent: done\ndata: {}\n\n";
    let events = transcript(state.clone(), 7, wire.into()).await;
    assert_eq!(events.len(), 2);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while Arc::strong_count(&state) > 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let state = Arc::try_unwrap(state).ok().unwrap();
    let log = format!("{:?}", state.db.into_transaction_log());
    assert!(log.contains("INSERT INTO") && log.contains("chat_history"));
    assert!(log.contains("NAVIGATE:/dashboard"));
    assert!(log.contains("__CONFIRM__:{}"));
}

#[tokio::test]
async fn cached_clients_are_rejected_before_any_database_access() {
    let state = state();
    for version in [None, Some("1"), Some("3")] {
        let mut request = Request::builder().uri("/api/chat/stream");
        if let Some(version) = version {
            request = request.header("x-agent-stream-version", version);
        }
        let response =
            chat_stream_handler(State(state.clone()), request.body(Body::empty()).unwrap()).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        assert!(String::from_utf8(bytes.to_vec())
            .unwrap()
            .contains("刷新页面"));
    }
    let state = Arc::try_unwrap(state).ok().unwrap();
    assert!(state.db.into_transaction_log().is_empty());
}
