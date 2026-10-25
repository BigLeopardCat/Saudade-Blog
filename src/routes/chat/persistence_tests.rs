use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, MockExecResult, Statement};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{oneshot, Notify};

fn revision() -> Revision {
    Revision {
        message_count: 1,
        through_id: None,
    }
}

#[tokio::test]
async fn visible_reply_requires_a_successful_insert() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    assert!(
        save_assistant_reply(&db, 7, 42, "reply".into(), None, revision())
            .await
            .is_err()
    );
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("INSERT INTO") && log.contains("chat_history"));
}

#[tokio::test]
async fn summary_failure_does_not_erase_a_committed_reply() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([MockExecResult {
            last_insert_id: 1,
            rows_affected: 1,
        }])
        .into_connection();
    let revision = Revision {
        message_count: 21,
        through_id: Some(21),
    };
    save_assistant_reply(&db, 7, 42, "reply".into(), Some("summary".into()), revision)
        .await
        .unwrap();
    let log = db.into_transaction_log();
    assert_eq!(log.len(), 2);
    assert!(format!("{:?}", log[0]).contains("chat_history"));
    assert!(format!("{:?}", log[1]).contains("chat_summary"));
}

#[tokio::test]
async fn persistence_waits_for_commit_but_survives_waiter_cancellation() {
    let started = Arc::new(Notify::new());
    let (release, released) = oneshot::channel();
    let (completed, committed) = oneshot::channel();
    let signal = started.clone();
    let waiter = tokio::spawn(async move {
        run("cancelled-client", async move {
            signal.notify_one();
            released.await.unwrap();
            completed.send(()).unwrap();
            Ok(())
        })
        .await
    });
    started.notified().await;
    assert!(
        !waiter.is_finished(),
        "completion must await its persistence task"
    );
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), committed)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn write_and_task_failures_are_observed() {
    assert!(run("write-error", async {
        Err(DbErr::Custom("fixture".into()))
    })
    .await
    .is_err());
    assert!(run("task-error", async { panic!("fixture") })
        .await
        .is_err());
}

#[tokio::test]
async fn receipt_batch_rolls_back_if_a_later_row_fails() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([MockExecResult {
            last_insert_id: 1,
            rows_affected: 1,
        }])
        .into_connection();
    let rows = [json!({"tool":"one"}), json!({"tool":"two"})];
    assert!(save_execution_log(&db, 7, 42, &rows).await.is_err());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("ROLLBACK") && !log.contains("COMMIT"));
}

#[tokio::test]
async fn postgres_receipt_batches_are_atomic_and_survive_reply_failure() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO conversation(user_id,title) VALUES(2147483647,'completion rollback probe') RETURNING id",
        [])).await.unwrap().unwrap();
    let cid: i32 = row.try_get("", "id").unwrap();
    let uid = i32::MAX;
    let good = json!({"tool":"fixture", "action":"executed", "args":{"id":7}});
    let invalid = json!({"tool":"fixture", "action":"invalid\u{0}text"});
    assert!(save_execution_log(&txn, uid, cid, &[good.clone(), invalid])
        .await
        .is_err());
    assert!(execution_log::Entity::find()
        .filter(execution_log::Column::ConversationId.eq(cid))
        .all(&txn)
        .await
        .unwrap()
        .is_empty());
    save_execution_log(&txn, uid, cid, &[good.clone()])
        .await
        .unwrap();
    // The reply is not part of the business-receipt transaction.
    let failed_reply = txn.begin().await.unwrap();
    assert!(save_assistant_reply(
        &failed_reply,
        uid,
        cid,
        "invalid\0reply".into(),
        None,
        revision()
    )
    .await
    .is_err());
    failed_reply.rollback().await.unwrap();
    let records = execution_log::Entity::find()
        .filter(execution_log::Column::ConversationId.eq(cid))
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(records[0].payload.as_deref().unwrap()).unwrap(),
        good
    );
    txn.rollback().await.unwrap();
}
