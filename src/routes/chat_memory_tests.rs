use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, TransactionTrait};

fn revision(count: i64, through_id: Option<i32>) -> Revision {
    Revision {
        message_count: count,
        through_id,
    }
}

#[tokio::test]
async fn confirmations_and_short_threads_never_schedule_or_save_summaries() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    assert!(!due(&db, 7, 42, revision(502, None), None).await.unwrap());
    assert!(!due(&db, 7, 42, revision(20, Some(20)), None).await.unwrap());
    assert!(due(&db, 7, 42, revision(502, Some(1000)), None)
        .await
        .unwrap());
    save(&db, 7, 42, "ignored", revision(502, None))
        .await
        .unwrap();
    save(&db, 7, 42, "  ", revision(502, Some(1000)))
        .await
        .unwrap();
    assert!(db.into_transaction_log().is_empty());
}

#[tokio::test]
async fn postgres_summary_progress_survives_retention_and_rejects_stale_writes() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    // Fixtures and every mutation remain in this transaction and roll back.
    let row = txn.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO conversation(user_id,title) VALUES(2147483647,'summary rollback probe') RETURNING id",
        [])).await.unwrap().unwrap();
    let cid: i32 = row.try_get("", "id").unwrap();
    let uid = i32::MAX;
    let mut ids = Vec::new();
    for _ in 0..22 {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO chat_history(user_id,conversation_id,role,content) \
             VALUES($1,$2,'user','memory rollback probe') RETURNING id",
                vec![uid.into(), cid.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        ids.push(row.try_get::<i32>("", "id").unwrap());
    }
    save(&txn, uid, cid, "newer", revision(502, Some(ids[11])))
        .await
        .unwrap();
    save(&txn, uid, cid, "older", revision(502, Some(ids[1])))
        .await
        .unwrap();
    save(&txn, uid, cid, "duplicate", revision(502, Some(ids[11])))
        .await
        .unwrap();
    save(
        &txn,
        uid - 1,
        cid,
        "wrong owner",
        revision(502, Some(ids[21])),
    )
    .await
    .unwrap();
    let stored = chat_summary::Entity::find()
        .filter(chat_summary::Column::ConversationId.eq(cid))
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.summary, "newer");
    assert_eq!(stored.covered_through_id, ids[11]);
    assert!(
        !due(&txn, uid, cid, revision(502, Some(ids[20])), Some(&stored))
            .await
            .unwrap()
    );
    assert!(
        due(&txn, uid, cid, revision(502, Some(ids[21])), Some(&stored))
            .await
            .unwrap()
    );
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM chat_history WHERE conversation_id=$1 AND id<=$2",
        vec![cid.into(), ids[11].into()],
    ))
    .await
    .unwrap();
    assert!(
        due(&txn, uid, cid, revision(502, Some(ids[21])), Some(&stored))
            .await
            .unwrap()
    );
    save(&txn, uid, cid, "latest", revision(502, Some(ids[21])))
        .await
        .unwrap();
    let latest = chat_summary::Entity::find_by_id(stored.id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest.summary, "latest");
    assert!(
        !due(&txn, uid, cid, revision(502, Some(ids[21])), Some(&latest))
            .await
            .unwrap()
    );
    txn.rollback().await.unwrap();
}
