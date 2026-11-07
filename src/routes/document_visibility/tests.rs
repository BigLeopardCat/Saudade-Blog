use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request as HttpRequest,
    routing::post,
    Router,
};
use sea_orm::{DatabaseBackend, DbErr, MockDatabase};
use tower::ServiceExt;

fn input(id: i32) -> Input {
    Input {
        kind: DocumentType::Note,
        id,
        revision: "a".repeat(64),
    }
}
fn row(id: i32, revision: &str) -> BTreeMap<&'static str, sea_orm::Value> {
    BTreeMap::from([("id", id.into()), ("revision", revision.to_owned().into())])
}
fn app(db: sea_orm::DatabaseConnection) -> Router {
    let state = Arc::new(AppState {
        db,
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 300, 900),
        post_limiter: crate::risk::PostRateLimiter::new(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    });
    Router::new()
        .route(
            "/api/public/documents/validate",
            post(validate).layer(axum::extract::DefaultBodyLimit::max(32768)),
        )
        .with_state(state)
}

#[test]
fn bounded_identity_deduplication_rejects_invalid_types_and_revisions() {
    assert_eq!(
        identities(&[input(19), input(19), input(20)]).unwrap(),
        vec![19, 20]
    );
    assert!(identities(&(1..=65).map(input).collect::<Vec<_>>()).is_err());
    assert!(identities(&[input(0)]).is_err());
    assert!(identities(&[Input {
        revision: "A".repeat(64),
        ..input(19)
    }])
    .is_err());
    assert!(identities(&[Input {
        revision: String::new(),
        ..input(19)
    }])
    .is_err());
    for value in [
        json!({"type":"note","id":true,"revision":"a".repeat(64)}),
        json!({"type":"note","id":19.0,"revision":"a".repeat(64)}),
        json!({"type":"note","id":2147483648u64,"revision":"a".repeat(64)}),
        json!({"type":"board","id":19,"revision":"a".repeat(64)}),
        json!({"type":"note","id":19,"revision":"a".repeat(64),"role":"admin"}),
    ] {
        assert!(serde_json::from_value::<Input>(value).is_err());
    }
}

#[tokio::test]
async fn one_sql_projection_returns_each_identity_once_and_never_hidden_text() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![row(19, &"b".repeat(64))]])
        .into_connection();
    let value = current(&db, &[19, 20, 21]).await.unwrap();
    assert_eq!(
        value,
        json!({"schemaVersion":1,"documents":[
        {"type":"note","id":19,"visible":true,"contentRevision":"b".repeat(64)},
        {"type":"note","id":20,"visible":false,"contentRevision":null},
        {"type":"note","id":21,"visible":false,"contentRevision":null}]})
    );
    let log = db.into_transaction_log();
    assert_eq!(log.len(), 1);
}

#[tokio::test]
async fn public_http_contract_is_typed_and_invalid_input_never_queries_database() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![row(19, &"b".repeat(64))]])
        .into_connection();
    let response = app(db)
        .oneshot(
            HttpRequest::post("/api/public/documents/validate")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"documents":[
            {"type":"note","id":19,"revision":"a".repeat(64)},
            {"type":"note","id":19,"revision":"a".repeat(64)},
            {"type":"note","id":20,"revision":"a".repeat(64)}]})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert_eq!(value["code"], 200);
    assert_eq!(value["data"]["schemaVersion"], 1);
    assert_eq!(value["data"]["documents"].as_array().unwrap().len(), 2);
    for docs in [
        json!([{"type":"note","id":0,"revision":"a".repeat(64)}]),
        json!([{"type":"note","id":true,"revision":"a".repeat(64)}]),
    ] {
        let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        let response = app(db)
            .oneshot(
                HttpRequest::post("/api/public/documents/validate")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"documents":docs}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_client_error());
    }
}

#[tokio::test]
async fn failure_is_not_empty_or_invisible_success_and_empty_input_does_no_io() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(current(&db, &[19]).await.is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    assert_eq!(
        current(&db, &[]).await.unwrap(),
        json!({"schemaVersion":1,"documents":[]})
    );
    assert!(db.into_transaction_log().is_empty());
}

#[tokio::test]
async fn postgres_canonical_hash_visibility_and_revocation_match_corpus_export() {
    use sea_orm::{ConnectionTrait, Database, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("SKIP document visibility PostgreSQL: TEST_PG_URL not set");
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let mut ids: Vec<i32> = Vec::new();
    let title = "文\"题\\\n🐈";
    let body = "# 标题\r\n正文\t é🐈\u{000b} ![img](/cat.png)";
    for (status, public, shadow) in [
        ("public", true, false),
        ("draft", true, false),
        ("published", false, false),
        ("public", true, true),
    ] {
        let row=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO note(title,content,status,is_public,draft_of,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,localtimestamp,localtimestamp) RETURNING id",
            vec![title.into(),body.into(),status.into(),public.into(),
                if shadow {Some(ids[0])}else{None}.into()])).await.unwrap().unwrap();
        ids.push(row.try_get("", "id").unwrap());
    }
    let value = current(&tx, &ids).await.unwrap();
    let rows = value["documents"].as_array().unwrap();
    assert_eq!(rows[0]["contentRevision"], content_revision(title, body));
    for row in &rows[1..] {
        assert_eq!(row["visible"], false);
        assert!(row["contentRevision"].is_null());
    }
    let changed = "正文发生更新，🐈不再相同。";
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET content=$1 WHERE id=$2",
        vec![changed.into(), ids[0].into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        current(&tx, &[ids[0]]).await.unwrap()["documents"][0]["contentRevision"],
        content_revision(title, changed)
    );
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET is_public=false WHERE id=$1",
        vec![ids[0].into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        current(&tx, &[ids[0]]).await.unwrap()["documents"][0],
        json!({"type":"note","id":ids[0],"visible":false,"contentRevision":null})
    );
    tx.rollback().await.unwrap();
}
