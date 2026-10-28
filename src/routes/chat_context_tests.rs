use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, MockExecResult};

fn message(id: i32, role: &str) -> chat_history::Model {
    chat_history::Model {
        id, user_id: 7, conversation_id: 42, role: role.into(),
        source_role: Some("user".into()), content: format!("message {id}"),
        created_at: chrono::Local::now().naive_local(),
    }
}

fn archived(role: Option<&str>) -> chat_summary::Model {
    chat_summary::Model {
        id: 1, user_id: 7, conversation_id: 42, summary: "ARCHIVED_CANARY".into(),
        message_count: 20, lock_version: 0, covered_through_id: 35,
        source_role: role.map(str::to_owned), updated_at: chrono::Local::now().naive_local(),
    }
}

fn exec(rows_affected: u64) -> MockExecResult {
    MockExecResult { last_insert_id: 0, rows_affected }
}

#[tokio::test]
async fn unknown_sources_are_not_relabelled_or_read() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    for role in [None, Some(""), Some("unknown")] {
        let snapshot = load_bootstrap(&db, 7, 42, role, Some(90)).await.unwrap();
        assert!(snapshot.history.is_empty() && snapshot.summary.is_empty());
        assert!(snapshot.history_scope.is_none() && snapshot.summary_scope.is_none());
    }
    assert!(db.into_transaction_log().is_empty());
}

#[tokio::test]
async fn bootstrap_is_scoped_recent_and_read_only() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![archived(Some("user"))]])
        .append_query_results([vec![message(39, "assistant"), message(38, "user")]])
        .into_connection();
    let snapshot = load_bootstrap(&db, 7, 42, Some("user"), Some(40)).await.unwrap();
    assert_eq!(snapshot.history[0].content, "message 38");
    assert_eq!(snapshot.history[1].content, "message 39");
    assert_eq!(snapshot.summary, "ARCHIVED_CANARY");
    assert_eq!(snapshot.summary_scope.unwrap().role, "user");
    let log = db.into_transaction_log();
    assert_eq!(log.len(), 2, "bootstrap must not query a backlog or schedule summary work");
    let sql = format!("{log:?}");
    assert!(sql.contains("source_role") && sql.contains("LIMIT"));
    assert!(!sql.contains("INSERT") && !sql.contains("DELETE"));
    let json = serde_json::to_value(snapshot.history).unwrap();
    assert!(json.is_array());
}

#[tokio::test]
async fn role_change_cannot_import_a_different_roles_archive() {
    for role in [None, Some("admin")] {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![archived(role)]])
            .append_query_results([Vec::<chat_history::Model>::new()])
            .into_connection();
        let snapshot = load_bootstrap(&db, 7, 42, Some("user"), None).await.unwrap();
        assert!(snapshot.summary.is_empty() && snapshot.summary_scope.is_none());
    }
}

#[tokio::test]
async fn discard_and_archive_invalidation_are_one_transaction() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([exec(2), exec(1)]).into_connection();
    discard(&db, 7, 42, 15).await.unwrap();
    let sql = format!("{:?}", db.into_transaction_log());
    assert!(sql.contains("BEGIN") && sql.contains("COMMIT"));
    assert!(sql.contains("DELETE FROM") && sql.contains("UPDATE chat_summary"));
    assert!(sql.contains("covered_through_id >= $3"));
    assert!(!sql.contains("INSERT INTO chat_summary"));
}

#[tokio::test]
async fn failed_archive_invalidation_rolls_back_raw_history_deletion() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([exec(2)]).into_connection();
    assert!(discard(&db, 7, 42, 15).await.is_err());
    let sql = format!("{:?}", db.into_transaction_log());
    assert!(sql.contains("ROLLBACK") && !sql.contains("COMMIT"));
}

#[tokio::test]
async fn invalid_discard_boundaries_do_not_write() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    for boundary in [0, -1] {
        assert!(discard(&db, 7, 42, boundary).await.is_err());
    }
    assert!(db.into_transaction_log().is_empty());
}

#[tokio::test]
async fn postgres_discard_preserves_unaffected_archive_and_invalidates_deleted_coverage() {
    let Ok(url) = std::env::var("TEST_PG_URL") else { return; };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let row = txn.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO conversation(user_id,title) VALUES(2147483647,'context rollback probe') RETURNING id",
        [])).await.unwrap().unwrap();
    let cid: i32 = row.try_get("", "id").unwrap();
    let uid = i32::MAX;
    let mut ids = Vec::new();
    for index in 0..6 {
        let row = txn.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO chat_history(user_id,conversation_id,role,content,source_role) \
             VALUES($1,$2,$3,'rollback probe','user') RETURNING id",
            vec![uid.into(), cid.into(), (if index % 2 == 0 { "user" } else { "assistant" }).into()],
        )).await.unwrap().unwrap();
        ids.push(row.try_get::<i32>("", "id").unwrap());
    }
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO chat_summary(user_id,conversation_id,summary,message_count,covered_through_id,source_role) \
         VALUES($1,$2,'archive',4,$3,'user')", vec![uid.into(), cid.into(), ids[3].into()],
    )).await.unwrap();
    discard(&txn, uid, cid, ids[4]).await.unwrap();
    let preserved = chat_summary::Entity::find().filter(chat_summary::Column::ConversationId.eq(cid))
        .one(&txn).await.unwrap().unwrap();
    assert_eq!(preserved.summary, "archive");
    assert_eq!(preserved.covered_through_id, ids[3]);
    discard(&txn, uid, cid, ids[2]).await.unwrap();
    let invalidated = chat_summary::Entity::find().filter(chat_summary::Column::ConversationId.eq(cid))
        .one(&txn).await.unwrap().unwrap();
    assert!(invalidated.summary.is_empty() && invalidated.source_role.is_none());
    let remaining = chat_history::Entity::find().filter(chat_history::Column::ConversationId.eq(cid))
        .all(&txn).await.unwrap();
    assert_eq!(remaining.len(), 2);
    txn.rollback().await.unwrap();
}
