use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, Statement, TransactionTrait};
use serde_json::json;

#[test]
fn only_supported_state_fields_enter_the_endpoint() {
    assert!(serde_json::from_value::<Change>(
        json!({"version":"a".repeat(64),"content":"overwrite","status":"public"})
    )
    .is_err());
    let args = serde_json::from_value(json!({"version":"a".repeat(64),"isTop":2})).unwrap();
    assert!(validate(1, &args).is_err());
    let args = serde_json::from_value(json!({"version":"a".repeat(64)})).unwrap();
    assert!(validate(1, &args).is_err());
    assert!(
        serde_json::from_value::<Change>(json!({"version":"a".repeat(64),"isTop":true})).is_err()
    );
}

#[tokio::test]
async fn failed_reads_do_not_produce_a_target() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(read(&db, 7, false).await.is_err());
}

#[tokio::test]
async fn postgres_changes_are_guarded_and_never_edit_content_or_author() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let prefix = format!("state_{}", uuid::Uuid::new_v4().simple());
    let row=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) \
         VALUES($1,'content must survive','published',true,localtimestamp,localtimestamp) RETURNING id",
        vec![prefix.into()])).await.unwrap().unwrap();
    let id: i32 = row.try_get("", "id").unwrap();
    let shadow=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,draft_of,created_at,updated_at) \
         VALUES('shadow','draft survives','draft',false,$1,localtimestamp,localtimestamp) RETURNING id",vec![id.into()])).await.unwrap().unwrap();
    let shadow: i32 = shadow.try_get("", "id").unwrap();
    assert!(read(&txn, shadow, false).await.is_err());
    let original = read(&txn, id, false).await.unwrap();
    assert!(!serde_json::to_string(&original)
        .unwrap()
        .contains("content must survive"));
    let no_op = Change {
        version: original.version.clone(),
        status: Some(Status::Public),
        is_top: None,
    };
    let no_op = apply(&txn, id, &no_op).await.unwrap();
    assert!(!no_op.changed);
    assert_eq!(no_op.state.version, original.version);
    let change = Change {
        version: original.version.clone(),
        status: Some(Status::Private),
        is_top: Some(1),
    };
    let outcome = apply(&txn, id, &change).await.unwrap();
    assert!(outcome.changed);
    assert!(!outcome.state.is_public);
    assert_eq!(outcome.state.status.as_deref(), Some("private"));
    assert_eq!(outcome.state.is_top, Some(1));
    assert!(apply(&txn, id, &change).await.is_err());
    let actual = note::Entity::find_by_id(id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual.content, "content must survive");
    assert_eq!(actual.user_id, None);
    assert!(note::Entity::find_by_id(shadow)
        .one(&txn)
        .await
        .unwrap()
        .is_some());
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET content='changed without timestamp' WHERE id=$1",
        vec![id.into()],
    ))
    .await
    .unwrap();
    let stale = Change {
        version: outcome.state.version,
        status: Some(Status::Public),
        is_top: None,
    };
    assert!(apply(&txn, id, &stale).await.is_err());
    txn.rollback().await.unwrap();
}
