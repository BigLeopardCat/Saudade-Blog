use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, QueryTrait, Statement, TransactionTrait};

#[test]
fn notification_selection_is_bounded_and_unambiguous() {
    for ids in ["", "0", "-1", "true", "1,invalid"] {
        assert!(StateQuery {
            ids: Some(ids.into()),
            unread_only: false
        }
        .selected()
        .is_err());
    }
    assert!(StateQuery {
        ids: Some("1".into()),
        unread_only: true
    }
    .selected()
    .is_err());
    assert!(ListQuery {
        page_size: Some(101),
        ..Default::default()
    }
    .window()
    .is_err());
    assert!(ListQuery {
        query: Some(" ".into()),
        ..Default::default()
    }
    .window()
    .is_err());
    assert_eq!(
        StateQuery {
            ids: Some("2,1,2".into()),
            unread_only: false
        }
        .selected()
        .unwrap(),
        Some(vec![1, 2])
    );
    let sql = projected(user_notification::Entity::find(), Content::None)
        .build(DatabaseBackend::Postgres)
        .sql;
    assert!(
        !sql.contains("\"user_notification\".\"content\"") && sql.contains("'' AS \"content\"")
    );
    let sql = projected(user_notification::Entity::find(), Content::Detail)
        .build(DatabaseBackend::Postgres)
        .sql;
    assert!(sql.contains("2000") && !sql.contains("*"));
}

#[tokio::test]
async fn notification_query_failure_is_not_a_zero_count() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("unavailable".into())])
        .into_connection();
    assert!(read_state(&db, 7, &StateQuery::default()).await.is_err());
}

#[tokio::test]
async fn postgres_filters_before_paging_and_fixed_ids_reach_old_owned_notifications() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let mut users = Vec::new();
    for _ in 0..2 {
        users.push(tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','user') RETURNING id",
            [uuid::Uuid::new_v4().simple().to_string().into()])).await.unwrap().unwrap().try_get::<i32>("","id").unwrap());
    }
    let mut ids = Vec::new();
    for index in 0..125 {
        ids.push(
            tx.query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO user_notification(user_id,type,title,content,is_read,created_at) \
             VALUES($1,'system',$2,$3,false,localtimestamp) RETURNING id",
                [
                    users[0].into(),
                    (if index == 0 { "old needle" } else { "recent" }).into(),
                    "BODY_CANARY".repeat(500).into(),
                ],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<i32>("", "id")
            .unwrap(),
        );
    }
    let page = read(
        &tx,
        users[0],
        &ListQuery {
            page_size: Some(2),
            content: Content::None,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!((page.total, page.unread, page.items.len()), (125, 125, 2));
    assert!(page.has_more && page.items.iter().all(|item| item.content.is_empty()));
    let matched = read(
        &tx,
        users[0],
        &ListQuery {
            query: Some("NEEDLE".into()),
            content: Content::Preview,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!((matched.total, matched.items[0].id), (1, ids[0]));
    assert_eq!(matched.items[0].content.chars().count(), 240);
    assert!(matched.items[0].content_truncated);
    let selected = StateQuery {
        ids: Some(ids[0].to_string()),
        unread_only: false,
    };
    assert_eq!(
        read_state(&tx, users[0], &selected).await.unwrap().items[0].id,
        ids[0]
    );
    assert!(read_state(&tx, users[1], &selected)
        .await
        .unwrap()
        .items
        .is_empty());
    let all = read_state(
        &tx,
        users[0],
        &StateQuery {
            unread_only: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!((all.items.len(), all.unread), (100, 125));
    assert!(!all.complete);
    tx.rollback().await.unwrap();
}
