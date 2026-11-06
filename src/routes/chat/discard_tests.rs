use super::*;
use sea_orm::{ActiveModelTrait, Database, DbBackend, Set, Statement};

async fn fixture<C: ConnectionTrait>(db: &C) -> (i32, i32) {
    let name = format!("discard_{}", uuid::Uuid::new_v4().simple());
    let owner = crate::entity::user::ActiveModel {
        username: Set(name.clone()),
        nickname: Set(name.clone()),
        password: Set("fixture".into()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let conversation = conversation::ActiveModel {
        user_id: Set(owner.id),
        title: Set(Some(name)),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    (owner.id, conversation.id)
}

#[tokio::test]
async fn postgres_retry_keeps_previous_identical_turn_and_blocks_late_projections() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let (uid, cid) = fixture(&txn).await;
    let first = chat_context::append_user(&txn, uid, cid, Some("user"), "first", "继续")
        .await
        .unwrap()
        .unwrap();
    chat_context::append_user(&txn, uid, cid, Some("user"), "second", "继续")
        .await
        .unwrap()
        .unwrap();
    for _ in 0..2 {
        assert_eq!(
            discard(&txn, uid, cid, "second").await.unwrap(),
            Discarded::Queued
        );
        let remaining = chat_history::Entity::find()
            .filter(chat_history::Column::ConversationId.eq(cid))
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(
            remaining.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![first]
        );
    }
    assert!(crate::checkpoint_cleanup::has_pending_turn(&txn, cid)
        .await
        .unwrap());
    assert!(
        chat_context::append_user(&txn, uid, cid, Some("user"), "third", "新请求")
            .await
            .unwrap()
            .is_none()
    );
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE agent_checkpoint_cleanup SET delivered_at=CURRENT_TIMESTAMP WHERE conversation_id=$1",
        vec![cid.into()])).await.unwrap();
    assert!(!crate::checkpoint_cleanup::has_pending_turn(&txn, cid)
        .await
        .unwrap());
    assert!(
        chat_context::append_user(&txn, uid, cid, Some("user"), "second", "迟到原请求")
            .await
            .unwrap()
            .is_none()
    );
    assert!(super::super::persistence::save_assistant_reply(
        &txn,
        uid,
        cid,
        Some("user".into()),
        "second",
        "迟到回复".into()
    )
    .await
    .is_err());
    assert!(super::super::task_inputs::save(
        &txn,
        uid,
        cid,
        "user",
        "second",
        "second",
        &serde_json::json!({"id":"late","text":"迟到补充","status":"applied"})
    )
    .await
    .is_err());
    assert!(
        chat_context::append_user(&txn, uid, cid, Some("user"), "third", "新请求")
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        discard(&txn, uid, cid, "first").await.unwrap(),
        Discarded::NotLast
    );
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn postgres_absent_target_is_fenced_before_original_delivery() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let (uid, cid) = fixture(&txn).await;
    assert_eq!(
        discard(&txn, uid, cid, "late").await.unwrap(),
        Discarded::Queued
    );
    assert!(
        chat_context::append_user(&txn, uid, cid, Some("user"), "late", "迟到请求")
            .await
            .unwrap()
            .is_none()
    );
    assert!(crate::checkpoint_cleanup::turn_discarded(&txn, cid, "late")
        .await
        .unwrap());
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn postgres_discard_and_new_request_serialize_on_the_conversation() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    for _ in 0..4 {
        let (uid, cid) = fixture(&db).await;
        chat_context::append_user(&db, uid, cid, Some("user"), "old", "继续")
            .await
            .unwrap()
            .unwrap();
        let (removed, new) = tokio::join!(
            discard(&db, uid, cid, "old"),
            chat_context::append_user(&db, uid, cid, Some("user"), "new", "继续")
        );
        match (removed.unwrap(), new.unwrap()) {
            (Discarded::Queued, None) | (Discarded::NotLast, Some(_)) => {}
            unexpected => panic!("inconsistent concurrent outcome: {unexpected:?}"),
        }
        txn_cleanup(&db, uid, cid).await;
    }
}

async fn txn_cleanup(db: &DatabaseConnection, uid: i32, cid: i32) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM agent_checkpoint_cleanup WHERE conversation_id=$1",
        vec![cid.into()],
    ))
    .await
    .unwrap();
    conversation::Entity::delete_by_id(cid)
        .exec(db)
        .await
        .unwrap();
    crate::entity::user::Entity::delete_by_id(uid)
        .exec(db)
        .await
        .unwrap();
}
