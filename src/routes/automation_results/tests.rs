use super::*;
use sea_orm::{ColumnTrait, Database, PaginatorTrait, QueryFilter};

#[test]
fn requests_cannot_choose_recipient_or_overflow_notification() {
    assert!(serde_json::from_value::<Delivery>(serde_json::json!({
        "runId":"run", "title":"test", "content":"result", "userId":2
    }))
    .is_err());
    for (run, title, content) in [
        ("../run", "title", "body"),
        ("run", " ", "body"),
        ("run", "title", ""),
    ] {
        assert!(validate(&Delivery {
            run_id: run.into(),
            title: title.into(),
            conversation_id: None,
            schedule_id: None,
            status: completed(),
            content: content.into()
        })
        .is_err());
    }
    assert!(validate(&Delivery {
        run_id: "run".into(),
        title: "title".into(),
        conversation_id: None,
        schedule_id: None,
        status: completed(),
        content: "x".repeat(1001)
    })
    .is_err());
}

#[tokio::test]
async fn postgres_delivery_replays_atomically_and_rechecks_authority() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,password,role) VALUES ($1,'fixture','admin') RETURNING id",
        [format!("automation_{prefix}").into()])).await.unwrap().unwrap();
    let owner: i32 = row.try_get("", "id").unwrap();
    let value = Delivery {
        run_id: prefix,
        title: "定时提醒".into(),
        content: "保留\n原文😀".into(),
        conversation_id: None,
        schedule_id: None,
        status: completed(),
    };
    let first = apply(&txn, owner, &value)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    let replay = apply(&txn, owner, &value)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    assert!(!first.replayed);
    assert!(replay.replayed);
    assert_eq!(first.notification_id, replay.notification_id);
    assert_eq!(
        crate::entity::user_notification::Entity::find()
            .filter(crate::entity::user_notification::Column::UserId.eq(owner))
            .count(&txn)
            .await
            .unwrap(),
        1
    );
    let mut changed = value.clone();
    changed.content = "其他正文".into();
    assert_eq!(
        apply(&txn, owner, &changed).await.unwrap_err().0,
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
        apply(&txn, owner, &value).await.unwrap_err().0,
        StatusCode::FORBIDDEN
    );
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET role='admin',status=1 WHERE id=$1",
        [owner.into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        apply(&txn, owner, &value).await.unwrap_err().0,
        StatusCode::FORBIDDEN
    );
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn postgres_completed_work_stays_in_its_source_conversation_and_deleted_threads_stay_deleted()
{
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let uid: i32 = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",
        [format!("task_origin_{}",uuid::Uuid::new_v4().simple()).into()]))
        .await.unwrap().unwrap().try_get("", "id").unwrap();
    let mut conversations = Vec::new();
    for _ in 0..2 {
        conversations.push(
            txn.query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO conversation(user_id,title) VALUES($1,'source') RETURNING id",
                [uid.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<i32>("", "id")
            .unwrap(),
        );
    }
    let cid = conversations[0];
    let mut value = Delivery {
        run_id: uuid::Uuid::new_v4().simple().to_string(),
        title: "result".into(),
        content: "done".into(),
        conversation_id: Some(cid),
        schedule_id: Some(format!("sc_{}", "a".repeat(32))),
        status: completed(),
    };
    assert_eq!(
        apply(&txn, uid, &value)
            .await
            .unwrap_or_else(|_| panic!("delivery failed"))
            .conversation_id,
        Some(cid)
    );
    value.conversation_id = Some(conversations[1]);
    assert_eq!(
        apply(&txn, uid, &value).await.unwrap_err().0,
        StatusCode::CONFLICT
    );
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "DELETE FROM conversation WHERE id=$1",
        [cid.into()],
    ))
    .await
    .unwrap();
    value.conversation_id = Some(cid);
    assert_eq!(
        apply(&txn, uid, &value)
            .await
            .unwrap_or_else(|_| panic!("delivery failed"))
            .conversation_id,
        None
    );
    let row = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT COUNT(*)::bigint AS n FROM chat_task_result WHERE owner_id=$1",
            [uid.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "n").unwrap(), 0);
    txn.rollback().await.unwrap();
}
