use super::*;
use crate::entity::{announcement, user_notification};
use sea_orm::{ColumnTrait, Database, EntityTrait, PaginatorTrait, QueryFilter};

fn change(version: String, content: &str) -> Change {
    serde_json::from_value(json!({"version":version,"intent":{
        "action":"create","fields":{"title":"原文😀","content":content}}}))
    .unwrap()
}

#[test]
fn operation_ids_and_cross_language_payloads_are_exact() {
    for id in ["", "short", &"g".repeat(64), &"A".repeat(64)] {
        assert!(validate_id(id).is_err());
    }
    assert!(validate_id(&"a".repeat(64)).is_ok());
    let first = change("a".repeat(64), " 保留\n正文 ");
    // Shared fixed-position JSON test vector, also asserted by the Python client.
    assert_eq!(
        fingerprint(&first),
        "50e3522ecbed43bdf7cff76b32fe7fbee5e9f6c1385f403060545539b38ccbe3"
    );
    assert_ne!(
        fingerprint(&first),
        fingerprint(&change("a".repeat(64), "不同正文"))
    );
}

#[tokio::test]
async fn receipt_replays_after_response_loss_and_later_deletion_without_republishing() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let owner: i32 = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",
        [format!("operation_{id}").into()])).await.unwrap().unwrap().try_get("", "id").unwrap();
    let mut original = change("a".repeat(64), "唯一公告正文");
    original.version = super::super::targets::prepare(&txn, &original.intent, false)
        .await
        .unwrap()
        .version;
    let request = Request {
        operation_id: id.repeat(2),
        change: original.clone(),
    };
    let first = apply(&txn, owner, &request)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    let aid = first.outcome.state.after.as_ref().unwrap().id.unwrap();
    let count = user_notification::Entity::find()
        .filter(user_notification::Column::AnnouncementId.eq(aid))
        .count(&txn)
        .await
        .unwrap();
    let replay = apply(&txn, owner, &request)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(replay).unwrap()
    );
    assert_eq!(
        user_notification::Entity::find()
            .filter(user_notification::Column::AnnouncementId.eq(aid))
            .count(&txn)
            .await
            .unwrap(),
        count
    );
    let lookup = stored(&txn, owner, &request.operation_id)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message))
        .unwrap();
    assert_eq!(lookup.outcome.state.after.as_ref().unwrap().id, Some(aid));
    assert!(stored(&txn, owner + 1, &request.operation_id)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message))
        .is_none());
    let different = Request {
        operation_id: request.operation_id.clone(),
        change: change(original.version.clone(), "不在批准中的内容"),
    };
    assert_eq!(
        apply(&txn, owner, &different).await.err().unwrap().0,
        StatusCode::CONFLICT
    );
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET role='user' WHERE id=$1",
        [owner.into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        apply(&txn, owner, &request).await.err().unwrap().0,
        StatusCode::FORBIDDEN
    );
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET role='admin' WHERE id=$1",
        [owner.into()],
    ))
    .await
    .unwrap();
    announcement::Entity::delete_by_id(aid)
        .exec(&txn)
        .await
        .unwrap();
    let replay = apply(&txn, owner, &request)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    assert_eq!(replay.outcome.state.after.as_ref().unwrap().id, Some(aid));
    assert!(announcement::Entity::find_by_id(aid)
        .one(&txn)
        .await
        .unwrap()
        .is_none());
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn business_failure_rolls_back_the_claim_and_receipt_together() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let owner: i32 = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",
        [format!("operation_rollback_{id}").into()])).await.unwrap().unwrap()
        .try_get("", "id").unwrap();
    let savepoint = txn.begin().await.unwrap();
    let request = Request {
        operation_id: id.repeat(2),
        change: change("0".repeat(64), "过期版本"),
    };
    assert!(apply(&savepoint, owner, &request).await.is_err());
    savepoint.rollback().await.unwrap();
    assert!(stored(&txn, owner, &request.operation_id)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message))
        .is_none());
    txn.rollback().await.unwrap();
}
