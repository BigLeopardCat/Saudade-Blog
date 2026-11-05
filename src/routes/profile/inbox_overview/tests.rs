use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase};

#[tokio::test]
async fn failed_inbox_read_is_not_an_empty_inbox() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(read(&db, 7, 5).await.is_err());
}

#[tokio::test]
async fn postgres_overview_is_owned_unread_bounded_and_does_not_mark_read() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let mut users = Vec::new();
    for _ in 0..2 {
        let row=tx.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','user') RETURNING id",
            [uuid::Uuid::new_v4().simple().to_string().into()])).await.unwrap().unwrap();
        users.push(row.try_get::<i32>("", "id").unwrap());
    }
    for uid in &users {
        for index in 0..7 {
            tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
                "INSERT INTO user_notification(user_id,type,title,content,is_read,deleted_at,created_at) \
                 VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN localtimestamp ELSE NULL END,localtimestamp)",
                [(*uid).into(),(if index%2==0 {"announcement"} else {"system"}).into(),
                 "题".repeat(250).into(),"BODY_MUST_NOT_TRANSFER".repeat(100).into(),
                 (index==5).into(),(index==6).into()])).await.unwrap();
            tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
                "INSERT INTO user_message(from_user_id,to_user_id,title,content,is_read,recipient_deleted_at,created_at) \
                 VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN localtimestamp ELSE NULL END,localtimestamp)",
                [users[1].into(),(*uid).into(),"信".repeat(250).into(),
                 "BODY_MUST_NOT_TRANSFER".repeat(100).into(),(index==5).into(),(index==6).into()])).await.unwrap();
        }
    }
    let result = read(&tx, users[0], 3).await.unwrap();
    assert_eq!(
        (result.notifications, result.messages, result.total),
        (5, 5, 10)
    );
    assert_eq!(
        (result.notification_items.len(), result.message_items.len()),
        (3, 3)
    );
    assert!(result.notifications_has_more && result.messages_has_more && result.unread_only);
    for item in result
        .notification_items
        .iter()
        .chain(result.message_items.iter())
    {
        assert_eq!(item["isRead"], false);
        assert_eq!(item["titleTruncated"], true);
        assert_eq!(item["title"].as_str().unwrap().chars().count(), 160);
        assert!(item.get("content").is_none());
    }
    assert!(
        !serde_json::to_string(&result)
            .unwrap()
            .contains("BODY_MUST_NOT_TRANSFER")
    );
    assert_eq!(read(&tx, users[0], 10).await.unwrap().total, 10);
    tx.rollback().await.unwrap();
}
