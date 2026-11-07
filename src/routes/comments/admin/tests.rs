use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, Statement, TransactionTrait, Value};
use serde_json::json;
use std::collections::BTreeMap;

fn query(value: serde_json::Value) -> CommentAdminQuery {
    serde_json::from_value(value).unwrap()
}

#[test]
fn default_window_is_bounded_and_invalid_queries_are_rejected() {
    assert_eq!(window(&query(json!({}))).unwrap(), (20, 0));
    assert_eq!(
        window(&query(json!({"page": 51, "page_size": 10}))).unwrap(),
        (10, 500)
    );
    assert_eq!(window(&query(json!({"page_size": 900}))).unwrap(), (200, 0));
    assert!(window(&query(json!({"page":u64::MAX,"page_size":200}))).is_err());
    assert!(window(&query(json!({"q":"猫".repeat(121)}))).is_err());
    for value in [
        json!({"sort":"random"}),
        json!({"status":"all"}),
        json!({"page":-1}),
    ] {
        assert!(serde_json::from_value::<CommentAdminQuery>(value).is_err());
    }
}

#[test]
fn server_filters_cover_title_identity_deletion_and_total_order() {
    let statement = comment_admin_filter(&query(
        json!({"q":"A%_","deleted":false,"status":"pending","sort":"asc"}),
    ))
    .build(DatabaseBackend::Postgres);
    let sql = statement.sql;
    assert!(sql.contains("username") && sql.contains("nickname") && sql.contains("title"));
    assert!(sql.contains("is_deleted") && sql.contains("approved"));
    assert!(sql.contains("\"created_at\" ASC, \"note_comment\".\"id\" ASC"));
    assert!(statement
        .values
        .unwrap()
        .0
        .contains(&Value::from("%A\\%\\_%")));
    let sql = comment_admin_filter(&query(json!({"deleted":true})))
        .build(DatabaseBackend::Postgres)
        .sql;
    assert!(sql.contains("\"is_deleted\" <>") && sql.contains("\"id\" DESC"));
}

#[tokio::test]
async fn count_or_enrichment_failures_do_not_become_empty_or_anonymous_results() {
    let q = query(json!({}));
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("count unavailable".into())])
        .into_connection();
    assert!(read_page(&db, &q, 10, 0).await.is_err());
    let count = BTreeMap::from([("num_items".to_owned(), Value::from(1i64))]);
    let row: note_comment::Model = serde_json::from_value(json!({
        "id":1,"note_id":1,"user_id":1,"content":"body","root_id":null,"parent_id":null,
        "reply_to_uid":null,"approved":0,"ai_result":null,"ai_reason":null,"reject_reason":null,
        "is_deleted":0,"created_at":"2020-01-01T00:00:00","updated_at":"2020-01-01T00:00:00"
    }))
    .unwrap();
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![count]])
        .append_query_results([vec![row]])
        .append_query_errors([DbErr::Custom("author lookup unavailable".into())])
        .into_connection();
    assert!(read_page(&db, &q, 10, 0).await.is_err());
}

#[tokio::test]
async fn postgres_501st_comment_is_reachable_and_filter_totals_match_pages() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let unique = format!("comments_page_{}", uuid::Uuid::new_v4().simple());
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,$2,'user') RETURNING id",
        vec![unique.clone().into(), uuid::Uuid::new_v4().to_string().into()])).await.unwrap().unwrap();
    let uid: i32 = row.try_get("", "id").unwrap();
    let title = format!("{unique} A%_ title");
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note (title,content,created_at,updated_at) VALUES ($1,'',localtimestamp,localtimestamp) RETURNING id",
        vec![title.clone().into()])).await.unwrap().unwrap();
    let note_id: i32 = row.try_get("", "id").unwrap();
    txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note_comment (note_id,user_id,content,approved,is_deleted,created_at,updated_at) \
         SELECT $1,$2,'isolated body',CASE WHEN n=1 THEN 0 ELSE 1 END,0,'2020-01-01','2020-01-01' FROM generate_series(1,501) AS n",
        vec![note_id.into(),uid.into()])).await.unwrap();
    txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note_comment (note_id,user_id,content,approved,is_deleted) VALUES ($1,$2,'deleted body',0,1)",
        vec![note_id.into(),uid.into()])).await.unwrap();
    let all = query(json!({"note_id":note_id,"deleted":false}));
    let (last, total) = read_page(&txn, &all, 10, 500).await.unwrap();
    assert_eq!(total, 501);
    assert_eq!(last.len(), 1);
    assert_eq!(last[0].approved, 0);
    assert_eq!(last[0].note_title, title);
    assert_eq!(last[0].username, unique);
    let (first, _) = read_page(&txn, &all, 10, 0).await.unwrap();
    assert!(first.windows(2).all(|pair| pair[0].id > pair[1].id));
    assert!(first.iter().all(|row| row.id != last[0].id));
    for (filter, count) in [
        (
            json!({"note_id":note_id,"status":"pending","deleted":false}),
            1,
        ),
        (
            json!({"note_id":note_id,"status":"passed","deleted":false}),
            500,
        ),
        (json!({"note_id":note_id,"deleted":true}), 1),
        (json!({"note_id":note_id,"q":"A%_"}), 502),
        (json!({"note_id":note_id,"q":unique.to_uppercase()}), 502),
        (json!({"note_id":note_id,"q":"no matching content"}), 0),
    ] {
        let q = query(filter);
        let (items, total) = read_page(&txn, &q, 10, 0).await.unwrap();
        assert_eq!(total, count);
        assert_eq!(items.len(), (count as usize).min(10));
    }
    let (ascending, _) = read_page(
        &txn,
        &query(json!({"note_id":note_id,"deleted":false,"sort":"asc"})),
        10,
        0,
    )
    .await
    .unwrap();
    assert_eq!(ascending[0].id, last[0].id);
    assert!(ascending.windows(2).all(|pair| pair[0].id < pair[1].id));
    txn.rollback().await.unwrap();
}
