use super::super::{notifications, visibility};
use super::*;
use sea_orm::{Database, DatabaseBackend, PaginatorTrait, Statement, TransactionTrait};

#[test]
fn deletion_folder_is_explicit_and_rejects_unknown_values() {
    assert!(serde_json::from_str::<DeleteMessageQuery>(r#"{"folder":"inbox"}"#).is_ok());
    assert!(serde_json::from_str::<DeleteMessageQuery>(r#"{"folder":"outbox"}"#).is_ok());
    assert!(serde_json::from_str::<DeleteMessageQuery>(r#"{"folder":"all"}"#).is_err());
    assert!(serde_json::from_str::<DeleteMessageQuery>(r#"{"userId":42}"#).is_err());
}

#[tokio::test]
async fn personal_deletion_preserves_peers_counts_and_latest_announcement_barrier() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url)
        .await
        .expect("TEST_PG_URL connection");
    let txn = db.begin().await.unwrap();
    let mut users = Vec::new();
    for _ in 0..3 {
        let name = format!("removal_it_{}", uuid::Uuid::new_v4().simple());
        let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,$2,'user') RETURNING id",
            vec![name.into(), uuid::Uuid::new_v4().to_string().into()])).await.unwrap().unwrap();
        users.push(row.try_get::<i32>("", "id").unwrap());
    }
    let (sender, recipient, outsider) = (users[0], users[1], users[2]);
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO user_message(from_user_id,to_user_id,content,is_read) VALUES ($1,$2,'contract',false) RETURNING id",
        vec![sender.into(), recipient.into()])).await.unwrap().unwrap();
    let message_id: i32 = row.try_get("", "id").unwrap();
    remove_message(&txn, outsider, message_id, Folder::Inbox)
        .await
        .unwrap();
    remove_message(&txn, outsider, message_id, Folder::Outbox)
        .await
        .unwrap();
    let row = user_message::Entity::find_by_id(message_id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert!(row.sender_deleted_at.is_none() && row.recipient_deleted_at.is_none());
    remove_message(&txn, sender, message_id, Folder::Outbox)
        .await
        .unwrap();
    assert_eq!(
        user_message::Entity::find()
            .filter(visibility::inbox(recipient))
            .count(&txn)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        user_message::Entity::find()
            .filter(visibility::outbox(sender))
            .count(&txn)
            .await
            .unwrap(),
        0
    );
    remove_message(&txn, recipient, message_id, Folder::Inbox)
        .await
        .unwrap();
    let removed = user_message::Entity::find_by_id(message_id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    remove_message(&txn, recipient, message_id, Folder::Inbox)
        .await
        .unwrap();
    let repeated = user_message::Entity::find_by_id(message_id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(removed.recipient_deleted_at, repeated.recipient_deleted_at);
    assert!(!repeated.is_read);
    assert_eq!(
        user_message::Entity::find()
            .filter(visibility::message(recipient))
            .count(&txn)
            .await
            .unwrap(),
        0
    );

    let mut latest = 0;
    for day in [1, 2] {
        let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO user_notification(user_id,type,title,is_read,created_at) VALUES ($1,'announcement','contract',false,$2) RETURNING id",
            vec![recipient.into(), chrono::NaiveDate::from_ymd_opt(2026,1,day).unwrap().and_hms_opt(0,0,0).unwrap().into()])).await.unwrap().unwrap();
        latest = row.try_get("", "id").unwrap();
    }
    assert!(notifications::pending(&txn, recipient)
        .await
        .unwrap()
        .is_some());
    remove_notification(&txn, outsider, latest).await.unwrap();
    assert!(notifications::pending(&txn, recipient)
        .await
        .unwrap()
        .is_some());
    remove_notification(&txn, recipient, latest).await.unwrap();
    assert!(notifications::pending(&txn, recipient)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        user_notification::Entity::find()
            .filter(visibility::notifications(recipient))
            .count(&txn)
            .await
            .unwrap(),
        1
    );

    // The participant can remove a self-addressed message from each folder independently.
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO user_message(from_user_id,to_user_id,content,is_read) VALUES ($1,$1,'self',false) RETURNING id",
        vec![recipient.into()])).await.unwrap().unwrap();
    let self_id: i32 = row.try_get("", "id").unwrap();
    remove_message(&txn, recipient, self_id, Folder::Inbox)
        .await
        .unwrap();
    assert_eq!(
        user_message::Entity::find()
            .filter(visibility::outbox(recipient))
            .count(&txn)
            .await
            .unwrap(),
        1
    );
    remove_message(&txn, recipient, self_id, Folder::Outbox)
        .await
        .unwrap();
    assert_eq!(
        user_message::Entity::find()
            .filter(visibility::message(recipient))
            .count(&txn)
            .await
            .unwrap(),
        0
    );
    txn.rollback().await.unwrap();
}
