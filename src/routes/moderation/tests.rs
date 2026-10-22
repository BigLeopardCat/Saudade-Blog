use super::*;
use sea_orm::{
    Database, DatabaseBackend, MockDatabase, PaginatorTrait, QueryTrait, Statement,
    TransactionTrait,
};
use serde_json::json;

#[test]
fn review_filters_are_closed_and_page_offsets_cannot_overflow() {
    for (name, value) in [("pending", 0), ("passed", 1), ("rejected", 2)] {
        assert_eq!(
            serde_json::from_value::<ReviewStatus>(json!(name))
                .unwrap()
                .approved(),
            value
        );
    }
    assert!(serde_json::from_value::<ReviewStatus>(json!("invented")).is_err());
    assert!(serde_json::from_value::<AiDecision>(json!("pending")).is_err());
    assert_eq!(page_window(None, None).unwrap(), None);
    assert_eq!(page_window(Some(2), Some(5)).unwrap(), Some((5, 5)));
    assert_eq!(page_window(Some(0), Some(0)).unwrap(), Some((1, 0)));
    assert_eq!(page_window(None, Some(999)).unwrap(), Some((200, 0)));
    assert!(page_window(Some(u64::MAX), Some(200)).is_err());
}

#[test]
fn shared_filters_include_status_identity_and_stable_ordering() {
    let query = serde_json::from_value(json!({"status":"pending", "q":"A%_", "id":42,
                                            "ai_result":"reject"}))
    .unwrap();
    let sql = super::super::talks::board_admin_filter(&query)
        .build(DatabaseBackend::Postgres)
        .to_string();
    assert!(sql.contains("ILIKE") && sql.contains("approved") && sql.contains("ai_result"));
    assert!(sql.contains("ORDER BY") && sql.contains("created_at") && sql.contains("id"));
    let statement =
        super::super::talks::board_admin_filter(&query).build(DatabaseBackend::Postgres);
    let pattern: sea_orm::Value = "%A\\%\\_%".to_string().into();
    assert!(statement.values.unwrap().0.contains(&pattern));
    let query =
        serde_json::from_value(json!({"status":"passed", "q":"actor", "note_id":19})).unwrap();
    let sql = super::super::comments::comment_admin_filter(&query)
        .build(DatabaseBackend::Postgres)
        .to_string();
    assert!(sql.contains("username") && sql.contains("nickname") && sql.contains("note_id"));
}

#[tokio::test]
async fn aggregate_failure_remains_unknown_and_does_not_fetch_content() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline database failure".into())])
        .into_connection();
    assert!(summary(&db).await.is_err());
    let sql = format!("{:?}", db.into_transaction_log());
    assert!(sql.contains("COUNT") && sql.contains("GROUP BY"));
    assert!(!sql.contains("content"));
}

#[tokio::test]
async fn postgres_review_counts_and_pages_use_the_same_filtered_rows() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let name = format!("moderation_it_{}", uuid::Uuid::new_v4().simple());
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,$2,'user') RETURNING id",
        vec![name.clone().into(), uuid::Uuid::new_v4().to_string().into()])).await.unwrap().unwrap();
    let uid: i32 = row.try_get("", "id").unwrap();
    let before = summary(&txn).await.unwrap();
    for _ in 0..7 {
        txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO talk (title,content,cat,v,author,user_id,src,approved,ai_result,created_at,updated_at) \
             VALUES ('test','isolated body','愿',0,'display only',$1,'board',0,'reject',localtimestamp,localtimestamp)",
            vec![uid.into()])).await.unwrap();
    }
    // A non-board talk must not enter board totals.
    txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO talk (title,content,cat,v,author,user_id,src,approved,created_at,updated_at) \
         VALUES ('test','unrelated body','愿',0,'display only',$1,'talk',1,localtimestamp,localtimestamp)",
        vec![uid.into()])).await.unwrap();
    let after = summary(&txn).await.unwrap();
    assert_eq!(after.total, before.total + 7);
    assert_eq!(after.pending, before.pending + 7);
    assert_eq!(after.ai_rejected, before.ai_rejected + 7);
    assert_eq!(after.rejected, before.rejected);
    let board = serde_json::from_value(json!({"status":"pending", "ai_result":"reject",
                                            "q":name.to_uppercase()}))
    .unwrap();
    assert_eq!(
        super::super::talks::board_admin_filter(&board)
            .count(&txn)
            .await
            .unwrap(),
        7
    );
    let first = super::super::talks::board_admin_filter(&board)
        .limit(5)
        .all(&txn)
        .await
        .unwrap();
    let second = super::super::talks::board_admin_filter(&board)
        .limit(5)
        .offset(5)
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(first.len(), 5);
    assert_eq!(second.len(), 2);
    assert!(first.iter().all(|a| second.iter().all(|b| a.id != b.id)));
    let row = txn.query_one(Statement::from_string(DatabaseBackend::Postgres,
        "INSERT INTO note (title,content,created_at,updated_at) VALUES ('test','',localtimestamp,localtimestamp) RETURNING id".to_string()))
        .await.unwrap().unwrap();
    let note_id: i32 = row.try_get("", "id").unwrap();
    for _ in 0..7 {
        txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO note_comment (note_id,user_id,content,approved,is_deleted) VALUES ($1,$2,'body without author name',0,0)",
            vec![note_id.into(), uid.into()])).await.unwrap();
    }
    let comment = serde_json::from_value(
        json!({"status":"pending", "q":name.to_uppercase(), "note_id":note_id}),
    )
    .unwrap();
    assert_eq!(
        super::super::comments::comment_admin_filter(&comment)
            .count(&txn)
            .await
            .unwrap(),
        7
    );
    assert_eq!(
        super::super::comments::comment_admin_filter(&comment)
            .limit(5)
            .offset(5)
            .all(&txn)
            .await
            .unwrap()
            .len(),
        2
    );
    txn.rollback().await.unwrap();
}
