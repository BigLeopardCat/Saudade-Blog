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
            content: content.into()
        })
        .is_err());
    }
    assert!(validate(&Delivery {
        run_id: "run".into(),
        title: "title".into(),
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
