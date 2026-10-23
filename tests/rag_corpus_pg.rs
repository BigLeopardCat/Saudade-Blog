//! Public RAG export: run against an explicitly supplied disposable TEST_PG_URL.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use saudade_blog::{
    create_router, rate_limiter::LoginRateLimiter, risk::PostRateLimiter, AppState,
};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use serde_json::Value;
use tower::ServiceExt;

async fn get(app: &Router, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 2_000_000)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn corpus_pagination_is_complete_public_and_revision_bound() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("TEST_PG_URL unset: disposable PostgreSQL integration not run");
        return;
    };
    let db = Database::connect(&url)
        .await
        .expect("test database must be reachable");
    db.execute(Statement::from_string(
        DbBackend::Postgres,
        "DELETE FROM note WHERE id BETWEEN 910000101 AND 910000109",
    ))
    .await
    .unwrap();
    db.execute(Statement::from_string(
        DbBackend::Postgres,
        r#"
        INSERT INTO note(id,title,content,status,is_public,draft_of,created_at,updated_at)
        VALUES
        (910000101,'one','Alpha','public',true,NULL,NOW(),NOW()),
        (910000102,'two','Beta','published',true,NULL,NOW(),NOW()),
        (910000103,'private','secret','private',false,NULL,NOW(),NOW()),
        (910000104,'draft','secret','draft',false,NULL,NOW(),NOW()),
        (910000105,'hidden','secret','public',false,NULL,NOW(),NOW()),
        (910000106,'unknown','secret','private',false,NULL,NOW(),NOW()),
        (910000107,'shadow','secret','public',true,910000101,NOW(),NOW()),
        (910000108,'null','secret','draft',false,NULL,NOW(),NOW()),
        (910000109,'three','Gamma','public',true,NULL,NOW(),NOW())
    "#,
    ))
    .await
    .unwrap();
    // The deployed CHECK also rejects malformed legacy states before they can
    // enter any public export. Exercise that boundary without weakening the schema.
    for status in ["unexpected", ""] {
        let invalid = format!(
            "INSERT INTO note(id,title,content,status,is_public,created_at,updated_at) \
            VALUES(910000110,'invalid','secret','{status}',true,NOW(),NOW())"
        );
        assert!(db
            .execute(Statement::from_string(DbBackend::Postgres, invalid))
            .await
            .is_err());
    }
    let writer = Database::connect(&url).await.unwrap();
    let app = create_router(AppState {
        db,
        rate_limiter: LoginRateLimiter::new(5, 60, 300),
        post_limiter: PostRateLimiter::new(),
        report_limiter: LoginRateLimiter::new(120, 60, 300),
    });
    let (status, first) = get(&app, "/api/public/rag/corpus?limit=2").await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let revision = first["data"]["revision"].as_str().unwrap().to_owned();
    let total = first["data"]["total"].as_u64().unwrap() as usize;
    let mut rows = first["data"]["documents"].as_array().unwrap().clone();
    let mut cursor = first["data"]["next_cursor"].as_i64();
    while let Some(after) = cursor {
        let (status, next) = get(
            &app,
            &format!("/api/public/rag/corpus?limit=2&after={after}&revision={revision}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{next}");
        assert_eq!(next["data"]["revision"], revision);
        rows.extend(next["data"]["documents"].as_array().unwrap().clone());
        cursor = next["data"]["next_cursor"].as_i64();
    }
    assert_eq!(rows.len(), total);
    let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    let fixture_ids: Vec<i64> = ids
        .into_iter()
        .filter(|id| (910000101..=910000109).contains(id))
        .collect();
    assert_eq!(fixture_ids, [910000101, 910000102, 910000109]);
    assert!(rows
        .iter()
        .any(|r| r["id"] == 910000101 && r["content"] == "Alpha"));
    assert!(rows
        .iter()
        .all(|r| r["revision"].as_str().unwrap().len() == 64));
    // Same id/count/timestamp; a body edit alone must invalidate the snapshot.
    writer
        .execute(Statement::from_string(
            DbBackend::Postgres,
            "UPDATE note SET content='Edited' WHERE id=910000101",
        ))
        .await
        .unwrap();
    let (status, _) = get(
        &app,
        &format!("/api/public/rag/corpus?limit=2&after=910000101&revision={revision}"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Revocation is immediately reflected in the authoritative source.
    writer
        .execute(Statement::from_string(
            DbBackend::Postgres,
            "UPDATE note SET is_public=false WHERE id=910000102",
        ))
        .await
        .unwrap();
    let (status, snapshot) = get(&app, "/api/public/rag/corpus?limit=100").await;
    assert_eq!(status, StatusCode::OK);
    assert!(snapshot["data"]["documents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["id"] != 910000102));
    let (status, _) = get(&app, "/api/public/notes/910000102").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    if let Ok(path) = std::env::var("RAG_CORPUS_CONTRACT_OUT") {
        std::fs::write(path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    }
}
