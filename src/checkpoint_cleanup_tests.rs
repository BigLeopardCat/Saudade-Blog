use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::delete,
    Json, Router,
};
use sea_orm::{Database, TransactionTrait};
use serde_json::json;

#[tokio::test]
async fn delivery_requires_verified_deletion_and_always_sends_identity() {
    async fn endpoint(
        State(body): State<serde_json::Value>,
        headers: HeaderMap,
    ) -> Json<serde_json::Value> {
        assert!(
            headers
                .get("X-Agent-Assertion")
                .unwrap()
                .to_str()
                .unwrap()
                .split('.')
                .count()
                == 3
        );
        Json(body)
    }
    for (body, expected) in [
        (json!({"deleted":true}), Ok(())),
        (
            json!({"deleted":false,"why":"still_readable"}),
            Err("deletion_unverified"),
        ),
        (json!({"success":true}), Err("deletion_unverified")),
    ] {
        let router = Router::new()
            .route("/checkpoint/42", delete(endpoint))
            .with_state(body);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let job = Job {
            conversation_id: 42,
            user_id: 7,
            attempts: 1,
            turn_id: String::new(),
        };
        assert_eq!(
            request(&client(), &base, &job, "test.signed.assertion").await,
            expected
        );
        server.abort();
    }
    let router = Router::new().fallback(|| async { StatusCode::SERVICE_UNAVAILABLE });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    assert_eq!(
        request(
            &client(),
            &base,
            &Job {
                conversation_id: 42,
                user_id: 7,
                attempts: 1,
                turn_id: String::new()
            },
            "test.signed.assertion"
        )
        .await,
        Err("http_status")
    );
    server.abort();
}

#[tokio::test]
async fn postgres_delete_enqueues_atomically_and_retries_without_stale_acknowledgements() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let row=txn.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO conversation(user_id,title) VALUES(2147483647,'cleanup rollback probe') RETURNING id",[])).await.unwrap().unwrap();
    let cid: i32 = row.try_get("", "id").unwrap();
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO chat_history(user_id,conversation_id,role,content) VALUES(2147483647,$1,'user','cascade probe')",
        vec![cid.into()])).await.unwrap();
    let ids = crate::routes::conversation::purge_conversation_data(
        &txn,
        crate::routes::conversation::ConvScope::ConversationId(cid),
    )
    .await
    .unwrap();
    assert_eq!(ids, vec![cid]);
    let deleted = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id FROM chat_history WHERE conversation_id=$1",
            vec![cid.into()],
        ))
        .await
        .unwrap();
    assert!(deleted.is_none());
    let late = txn.begin().await.unwrap();
    assert!(late.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO chat_history(user_id,conversation_id,role,content) VALUES(2147483647,$1,'assistant','late probe')",
        vec![cid.into()])).await.is_err());
    late.rollback().await.unwrap();
    let first = claim_matching(&txn, Some(cid), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.user_id, i32::MAX);
    assert!(claim_matching(&txn, Some(cid), None)
        .await
        .unwrap()
        .is_none());
    finish(&txn, &first, Err("transport")).await.unwrap();
    assert!(claim_matching(&txn, Some(cid), None)
        .await
        .unwrap()
        .is_none());
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE agent_checkpoint_cleanup SET next_attempt_at=CURRENT_TIMESTAMP WHERE conversation_id=$1",vec![cid.into()])).await.unwrap();
    let second = claim_matching(&txn, Some(cid), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.attempts, first.attempts + 1);
    finish(&txn, &first, Ok(())).await.unwrap();
    let remaining = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT attempts FROM agent_checkpoint_cleanup WHERE conversation_id=$1",
            vec![cid.into()],
        ))
        .await
        .unwrap();
    assert!(remaining.is_some());
    finish(&txn, &second, Ok(())).await.unwrap();
    let remaining = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT attempts FROM agent_checkpoint_cleanup WHERE conversation_id=$1",
            vec![cid.into()],
        ))
        .await
        .unwrap();
    assert!(remaining.is_none());
    txn.rollback().await.unwrap();
    let remaining = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT conversation_id FROM agent_checkpoint_cleanup WHERE conversation_id=$1",
            vec![cid.into()],
        ))
        .await
        .unwrap();
    assert!(remaining.is_none());
}

#[tokio::test]
async fn turn_delivery_uses_stable_identity_and_requires_an_explicit_ack() {
    use axum::routing::post;
    async fn endpoint(
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert!(headers.contains_key("X-Agent-Assertion"));
        assert_eq!(body, json!({"uid":7,"turn_id":"turn-2"}));
        assert!(body.get("text").is_none());
        Json(json!({"dropped":true}))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/checkpoint/42/drop_turn", post(endpoint)),
        )
        .await
        .unwrap()
    });
    let job = Job {
        conversation_id: 42,
        user_id: 7,
        attempts: 1,
        turn_id: "turn-2".into(),
    };
    assert_eq!(
        request(&client(), &base, &job, "signed.assertion.fixture").await,
        Ok(())
    );
    server.abort();
}

#[tokio::test]
async fn postgres_turn_retry_retains_acknowledged_fence_and_rejects_stale_ack() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let row=txn.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO conversation(user_id,title) VALUES(2147483647,'turn outbox fixture') RETURNING id",[]))
        .await.unwrap().unwrap();
    let cid: i32 = row.try_get("", "id").unwrap();
    enqueue_turn(&txn, cid, 7, "turn-2").await.unwrap();
    enqueue_turn(&txn, cid, 7, "turn-2").await.unwrap();
    let first = claim_matching(&txn, Some(cid), Some("turn-2"))
        .await
        .unwrap()
        .unwrap();
    finish(&txn, &first, Err("transport")).await.unwrap();
    assert!(has_pending_turn(&txn, cid).await.unwrap());
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE agent_checkpoint_cleanup SET next_attempt_at=CURRENT_TIMESTAMP WHERE conversation_id=$1",
        vec![cid.into()])).await.unwrap();
    let second = claim_matching(&txn, Some(cid), Some("turn-2"))
        .await
        .unwrap()
        .unwrap();
    finish(&txn, &first, Ok(())).await.unwrap();
    assert!(has_pending_turn(&txn, cid).await.unwrap());
    finish(&txn, &second, Ok(())).await.unwrap();
    assert!(!has_pending_turn(&txn, cid).await.unwrap());
    assert!(turn_discarded(&txn, cid, "turn-2").await.unwrap());
    assert!(claim_matching(&txn, Some(cid), Some("turn-2"))
        .await
        .unwrap()
        .is_none());
    txn.rollback().await.unwrap();
}
