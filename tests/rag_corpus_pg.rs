//! Public RAG export: run against an explicitly supplied disposable TEST_PG_URL.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use saudade_blog::{
    create_router, rate_limiter::LoginRateLimiter, risk::PostRateLimiter, AppState,
};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement, TransactionTrait};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
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

async fn fixture_continuation(
    app: &Router,
    previous: &Value,
    expected_status: StatusCode,
) -> Value {
    let revision = previous["data"]["revision"].as_str().unwrap();
    let (status, response) = get(
        app,
        &format!("/api/public/rag/corpus?limit=10&after=910000100&revision={revision}"),
    )
    .await;
    assert_eq!(status, expected_status, "{response}");
    response
}

async fn fixture_snapshot(app: &Router) -> Value {
    let (status, head) = get(app, "/api/public/rag/corpus?limit=1").await;
    assert_eq!(status, StatusCode::OK, "{head}");
    fixture_continuation(app, &head, StatusCode::OK).await
}

fn document(snapshot: &Value, id: i32) -> Option<&Value> {
    snapshot["data"]["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
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
        "DELETE FROM note WHERE id BETWEEN 910000101 AND 910000110",
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
    assert_eq!(first["data"]["schema_version"], 1);
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
        assert_eq!(next["data"]["total"], first["data"]["total"]);
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

    let baseline = fixture_continuation(&app, &first, StatusCode::OK).await;
    writer
        .execute_unprepared(
            "UPDATE note SET description='metadata only', status='published', \
             updated_at=updated_at + INTERVAL '1 day' WHERE id=910000101",
        )
        .await
        .unwrap();
    assert_eq!(
        fixture_continuation(&app, &baseline, StatusCode::OK).await,
        baseline,
    );
    writer
        .execute_unprepared(
            "UPDATE note SET title='private edit', content='private body' WHERE id=910000103",
        )
        .await
        .unwrap();
    assert_eq!(
        fixture_continuation(&app, &baseline, StatusCode::OK).await,
        baseline,
    );

    let tx = writer.begin().await.unwrap();
    tx.execute_unprepared(
        "UPDATE note SET title='uncommitted', content='pending' WHERE id=910000101",
    )
    .await
    .unwrap();
    tx.execute_unprepared("UPDATE note SET is_public=false WHERE id=910000109")
        .await
        .unwrap();
    let during_write = tokio::time::timeout(
        Duration::from_secs(5),
        fixture_continuation(&app, &baseline, StatusCode::OK),
    )
    .await
    .expect("a corpus reader can use the committed snapshot during a write");
    assert_eq!(during_write, baseline);
    tx.rollback().await.unwrap();
    assert_eq!(
        fixture_continuation(&app, &baseline, StatusCode::OK).await,
        baseline,
    );

    let mut snapshot = baseline;
    for (sql, title, content) in [
        (
            "UPDATE note SET content='Omega' WHERE id=910000101",
            "one",
            "Omega",
        ),
        (
            "UPDATE note SET title='uno' WHERE id=910000101",
            "uno",
            "Omega",
        ),
    ] {
        writer.execute_unprepared(sql).await.unwrap();
        let previous_revision = snapshot["data"]["revision"].as_str().unwrap();
        let (status, conflict) = get(
            &app,
            &format!("/api/public/rag/corpus?limit=2&after=910000101&revision={previous_revision}"),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
        assert_eq!(conflict["message"], "corpus_revision_changed");
        let edited = fixture_snapshot(&app).await;
        assert_eq!(edited["data"]["total"], snapshot["data"]["total"]);
        let before = document(&snapshot, 910000101).unwrap();
        let after = document(&edited, 910000101).unwrap();
        assert_eq!(after["title"], title);
        assert_eq!(after["content"], content);
        assert_ne!(before["revision"], after["revision"]);
        let expected_revision = hex::encode(Sha256::digest(
            serde_json::to_vec(&(title, content)).unwrap(),
        ));
        assert_eq!(after["revision"], expected_revision);
        assert_eq!(
            document(&edited, 910000102).unwrap(),
            document(&snapshot, 910000102).unwrap(),
        );
        snapshot = edited;
    }

    writer
        .execute_unprepared("UPDATE note SET is_public=false WHERE id=910000102")
        .await
        .unwrap();
    fixture_continuation(&app, &snapshot, StatusCode::CONFLICT).await;
    let revoked = fixture_snapshot(&app).await;
    let public_total = revoked["data"]["total"].as_u64().unwrap();
    assert_eq!(
        public_total + 1,
        snapshot["data"]["total"].as_u64().unwrap()
    );
    assert!(document(&revoked, 910000102).is_none());
    let (status, _) = get(&app, "/api/public/notes/910000102").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    if let Ok(path) = std::env::var("RAG_CORPUS_CONTRACT_OUT") {
        let (status, export) = get(&app, "/api/public/rag/corpus?limit=100").await;
        assert_eq!(status, StatusCode::OK, "{export}");
        std::fs::write(path, serde_json::to_vec(&export).unwrap()).unwrap();
    }

    writer
        .execute_unprepared("UPDATE note SET is_public=true WHERE id=910000105")
        .await
        .unwrap();
    fixture_continuation(&app, &revoked, StatusCode::CONFLICT).await;
    let published = fixture_snapshot(&app).await;
    assert_eq!(published["data"]["total"], public_total + 1);
    let published_document = document(&published, 910000105).unwrap();

    writer
        .execute_unprepared("UPDATE note SET id=910000110 WHERE id=910000105")
        .await
        .unwrap();
    fixture_continuation(&app, &published, StatusCode::CONFLICT).await;
    let moved = fixture_snapshot(&app).await;
    assert_eq!(moved["data"]["total"], published["data"]["total"]);
    assert!(document(&moved, 910000105).is_none());
    assert_eq!(
        document(&moved, 910000110).unwrap()["revision"],
        published_document["revision"],
    );

    writer
        .execute_unprepared("DELETE FROM note WHERE id=910000110")
        .await
        .unwrap();
    fixture_continuation(&app, &moved, StatusCode::CONFLICT).await;
    let deleted = fixture_snapshot(&app).await;
    assert_eq!(deleted["data"]["total"], public_total);
    assert_eq!(deleted["data"]["documents"], revoked["data"]["documents"]);

    writer
        .execute_unprepared("UPDATE note SET draft_of=910000102 WHERE id=910000109")
        .await
        .unwrap();
    fixture_continuation(&app, &deleted, StatusCode::CONFLICT).await;
    let shadowed = fixture_snapshot(&app).await;
    assert_eq!(shadowed["data"]["total"], public_total - 1);
    assert!(document(&shadowed, 910000109).is_none());

    writer
        .execute_unprepared("UPDATE note SET draft_of=NULL WHERE id=910000109")
        .await
        .unwrap();
    fixture_continuation(&app, &shadowed, StatusCode::CONFLICT).await;
    let restored = fixture_snapshot(&app).await;
    assert_eq!(restored["data"]["total"], public_total);
    assert_eq!(restored["data"]["documents"], deleted["data"]["documents"]);
}
