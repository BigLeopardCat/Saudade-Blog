use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, MockExecResult, TransactionTrait, Value};
use serde_json::json;
use std::collections::BTreeMap;

const ID: &str = "00000000-0000-0000-0000-000000000001";
const REQUEST_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn changed(rows_affected: u64) -> MockExecResult {
    MockExecResult {
        last_insert_id: 0,
        rows_affected,
    }
}

fn current(status: &str, hash: Option<String>) -> BTreeMap<String, Value> {
    [
        ("status".into(), status.into()),
        ("output_hash".into(), hash.into()),
    ]
    .into_iter()
    .collect()
}

#[tokio::test(start_paused = true)]
async fn transient_database_failure_retries_only_identical_result_persistence() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_errors([error("database temporarily disconnected")])
        .append_exec_results([changed(1)])
        .into_connection();
    assert_eq!(
        save(
            &db,
            ID,
            7,
            REQUEST_HASH,
            IMAGE,
            &json!({"total_tokens": 10})
        )
        .await
        .unwrap(),
        Saved::Review
    );
    let log = db.into_transaction_log();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0], log[1]);
}

#[tokio::test(start_paused = true)]
async fn persistent_failure_exhausts_three_attempts_without_claiming_review() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_errors([error("first"), error("second"), error("third")])
        .into_connection();
    assert!(save(&db, ID, 7, REQUEST_HASH, IMAGE, &json!({}))
        .await
        .is_err());
    assert_eq!(db.into_transaction_log().len(), SAVE_ATTEMPTS);
}

#[tokio::test(start_paused = true)]
async fn zero_changed_rows_preserve_concurrent_rejection_without_retry() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([changed(0)])
        .append_query_results([[current("rejected", None)]])
        .into_connection();
    assert_eq!(
        save(&db, ID, 7, REQUEST_HASH, IMAGE, &json!({}))
            .await
            .unwrap(),
        Saved::Superseded
    );
    assert_eq!(db.into_transaction_log().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn ambiguous_commit_is_recognized_without_overwriting_accepted_output() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_errors([error("response lost after commit")])
        .append_exec_results([changed(0)])
        .append_query_results([[current("accepted", Some(digest(IMAGE)))]])
        .into_connection();
    assert_eq!(
        save(&db, ID, 7, REQUEST_HASH, IMAGE, &json!({}))
            .await
            .unwrap(),
        Saved::AlreadyStored
    );
    assert_eq!(db.into_transaction_log().len(), 3);
}

#[tokio::test]
async fn postgres_repeated_save_preserves_owner_request_review_and_accepted_state() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let owner = tx.query_one(stmt(
        "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",
        vec![uuid::Uuid::new_v4().simple().to_string().into()],
    )).await.unwrap().unwrap().try_get::<i32>("", "id").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(stmt("INSERT INTO image_generation(id,owner_id,request,request_hash,status) VALUES($1::uuid,$2,'{}',$3,'generating')",
        vec![id.clone().into(), owner.into(), REQUEST_HASH.into()])).await.unwrap();
    let usage = json!({"total_tokens": 10});
    assert_eq!(
        save(&tx, &id, owner + 1, REQUEST_HASH, IMAGE, &usage)
            .await
            .unwrap(),
        Saved::Superseded
    );
    assert_eq!(
        save(&tx, &id, owner, &"b".repeat(64), IMAGE, &usage)
            .await
            .unwrap(),
        Saved::Superseded
    );
    assert_eq!(
        save(&tx, &id, owner, REQUEST_HASH, IMAGE, &usage)
            .await
            .unwrap(),
        Saved::Review
    );
    assert_eq!(
        save(
            &tx,
            &id,
            owner,
            REQUEST_HASH,
            IMAGE,
            &json!({"changed": true})
        )
        .await
        .unwrap(),
        Saved::AlreadyStored
    );
    let before = tx
        .query_one(stmt(
            "SELECT output,usage FROM image_generation WHERE id::text=$1",
            vec![id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before.try_get::<Vec<u8>>("", "output").unwrap(), IMAGE);
    assert_eq!(before.try_get::<JsonValue>("", "usage").unwrap(), usage);
    tx.execute(stmt(
        "UPDATE image_generation SET status='accepted',output=NULL WHERE id::text=$1",
        vec![id.clone().into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        save(&tx, &id, owner, REQUEST_HASH, IMAGE, &usage)
            .await
            .unwrap(),
        Saved::AlreadyStored
    );
    assert_eq!(
        save(&tx, &id, owner, REQUEST_HASH, b"different result", &usage)
            .await
            .unwrap(),
        Saved::Superseded
    );
    unknown(
        &tx,
        &id,
        owner,
        REQUEST_HASH,
        "must not overwrite acceptance",
    )
    .await
    .unwrap();
    let accepted = tx
        .query_one(stmt(
            "SELECT status,output,error FROM image_generation WHERE id::text=$1",
            vec![id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        accepted.try_get::<String>("", "status").unwrap(),
        "accepted"
    );
    assert!(accepted
        .try_get::<Option<Vec<u8>>>("", "output")
        .unwrap()
        .is_none());
    assert!(accepted
        .try_get::<Option<String>>("", "error")
        .unwrap()
        .is_none());
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn successful_provider_is_called_once_while_result_storage_retries() {
    use super::super::{provider, settings, Request};
    use axum::{extract::State, routing::post, Json, Router};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let count = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route("/images/generations", post(
        |State(count): State<Arc<AtomicUsize>>| async move {
            count.fetch_add(1, Ordering::SeqCst);
            Json(json!({"data": [{"b64_json": STANDARD.encode(IMAGE)}], "usage": {"total_tokens": 10}}))
        },
    )).with_state(count.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let request = Request {
        provider: base.clone(),
        prompt: "approved prompt".into(),
        model: "fixture".into(),
        size: "1024x1024".into(),
        quality: "high".into(),
        references: vec![],
    };
    let config = settings::Settings {
        key: "synthetic".into(),
        base,
        models: vec!["fixture".into()],
        proxy: None,
    };
    let (bytes, usage) = provider::generate(config, &request, &[]).await.unwrap();
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_errors([error("save interrupted")])
        .append_exec_results([changed(1)])
        .into_connection();
    let saved = save(&db, ID, 7, REQUEST_HASH, &bytes, &usage).await;
    server.abort();
    assert_eq!(saved.unwrap(), Saved::Review);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(db.into_transaction_log().len(), 2);
}
