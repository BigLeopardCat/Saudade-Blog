use super::*;
use sea_orm::{Database, TransactionTrait};

#[test]
fn completion_references_cannot_carry_execution_claims_or_path_components() {
    let event = TaskEvent {
        run_id: "run_1".into(),
        version: "a".repeat(64),
    };
    assert!(event.valid());
    assert_eq!(event.turn_id().len(), 69);
    for bad in ["../run", "run/other", "%61", ""] {
        assert!(!TaskEvent {
            run_id: bad.into(),
            ..event.clone()
        }
        .valid());
    }
    assert!(serde_json::from_value::<TaskEvent>(serde_json::json!({
        "run_id":"run", "version":"a".repeat(64), "status":"completed"
    }))
    .is_err());
}

#[tokio::test]
async fn postgres_unread_is_owner_and_version_bound_and_requires_a_reported_message() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let uid: i32 = txn.query_one(stmt(
        "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",
        vec![format!("completion_{}",uuid::Uuid::new_v4().simple()).into()])).await.unwrap().unwrap()
        .try_get("", "id").unwrap();
    let cid: i32 = txn
        .query_one(stmt(
            "INSERT INTO conversation(user_id,title) VALUES($1,'result') RETURNING id",
            vec![uid.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "id")
        .unwrap();
    txn.execute(stmt(
        "INSERT INTO chat_task_result(owner_id,run_id,conversation_id,schedule_id,\
        title,content,status,event_version) VALUES($1,'run',$2,$3,'task','done','completed',$4)",
        vec![
            uid.into(),
            cid.into(),
            format!("sc_{}", "a".repeat(32)).into(),
            "b".repeat(64).into(),
        ],
    ))
    .await
    .unwrap();
    assert!(
        task_result(&txn, uid, cid, "run")
            .await
            .unwrap()
            .unwrap()
            .report_pending
    );
    assert!(task_result(&txn, uid + 1, cid, "run")
        .await
        .unwrap()
        .is_none());
    let mut request = ReadRequest {
        conversation_id: cid,
        events: vec![ReadEvent {
            kind: Kind::Task,
            id: "run".into(),
            version: "b".repeat(64),
        }],
    };
    assert_eq!(
        acknowledge(&txn, uid, &request)
            .await
            .unwrap_or_else(|_| panic!("ack failed"))
            .marked,
        0
    );
    txn.execute(stmt(
        "UPDATE chat_task_result SET reported_version=event_version WHERE owner_id=$1",
        vec![uid.into()],
    ))
    .await
    .unwrap();
    request.events[0].version = "c".repeat(64);
    assert_eq!(
        acknowledge(&txn, uid, &request)
            .await
            .unwrap_or_else(|_| panic!("ack failed"))
            .marked,
        0
    );
    request.events[0].version = "b".repeat(64);
    assert_eq!(
        acknowledge(&txn, uid, &request)
            .await
            .unwrap_or_else(|_| panic!("ack failed"))
            .marked,
        1
    );
    assert_eq!(
        acknowledge(&txn, uid, &request)
            .await
            .unwrap_or_else(|_| panic!("ack failed"))
            .marked,
        0
    );
    txn.rollback().await.unwrap();
}
