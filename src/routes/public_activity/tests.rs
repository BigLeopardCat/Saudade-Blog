use super::*;
use sea_orm::{DatabaseBackend, DbErr, MockDatabase, QueryTrait};

#[test]
fn visibility_and_ids_are_sql_bound_and_windows_are_bounded() {
    let params = ActivityQuery {
        id: Some(72),
        ..Default::default()
    };
    let statement = messages::query(&params, "board").build(DatabaseBackend::Postgres);
    assert!(statement.sql.contains("\"src\" = $1") && statement.sql.contains("\"approved\" = $2"));
    assert!(statement.sql.contains("\"id\" = $3"));
    assert_eq!(
        statement.values.unwrap().0,
        vec!["board".into(), 1i32.into(), 72i32.into()]
    );
    assert!(
        window(&ActivityQuery {
            id: Some(0),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        window(&ActivityQuery {
            page_size: Some(51),
            ..Default::default()
        })
        .is_err()
    );
    assert_eq!(window(&ActivityQuery::default()).unwrap(), (5, 0));
}

#[tokio::test]
async fn failures_do_not_become_empty_public_pages() {
    for source in ["board", "talk"] {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors([DbErr::Custom("offline".into())])
            .into_connection();
        assert!(
            messages::read(&db, &ActivityQuery::default(), source, 5, 0)
                .await
                .is_err()
        );
    }
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(
        announcements::read(&db, &ActivityQuery::default(), 5, 0)
            .await
            .is_err()
    );
    let output = serde_json::to_value(response(Err(DbErr::Custom("offline".into()))).0).unwrap();
    assert_ne!(output["code"], 200);
    assert!(output["total"].is_null());
}

#[tokio::test]
async fn postgres_pages_keep_public_sources_separate_and_truncate_before_transfer() {
    use sea_orm::{ConnectionTrait, Database, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let prefix = format!("public_activity_{}", uuid::Uuid::new_v4().simple());
    let row=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'fixture','user') RETURNING id",
        vec![prefix.clone().into()])).await.unwrap().unwrap();
    let uid: i32 = row.try_get("", "id").unwrap();
    for source in ["board", "talk"] {
        let before = messages::read(&tx, &ActivityQuery::default(), source, 5, 0)
            .await
            .unwrap()
            .1;
        let mut approved_ids = Vec::new();
        for status in [1i16, 1, 1, 1, 1, 1, 0, 2] {
            let row=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,reject_reason,created_at,updated_at) \
                 VALUES ($1,$2,'愿',0,$3,$4,$5,$6,'private reason',localtimestamp,localtimestamp) RETURNING id",
                vec!["题".repeat(255).into(),"文".repeat(2501).into(),"名".repeat(64).into(),uid.into(),source.into(),status.into()]))
                .await.unwrap().unwrap();
            let id: i32 = row.try_get("", "id").unwrap();
            let params = ActivityQuery {
                id: Some(id),
                ..Default::default()
            };
            let (items, total) = messages::read(&tx, &params, source, 1, 0).await.unwrap();
            if status == 1 {
                approved_ids.push(id);
                assert_eq!(total, 1);
                assert_eq!(items[0]["content"].as_str().unwrap().chars().count(), 2000);
                assert_eq!(
                    items[0]["displayName"].as_str().unwrap().chars().count(),
                    64
                );
                assert_eq!(items[0]["contentTruncated"], true);
                assert_eq!(items[0]["titleTruncated"], false);
                assert_eq!(items[0]["displayNameTruncated"], false);
                let encoded = items[0].to_string();
                assert!(!encoded.contains("userId") && !encoded.contains("user_id"));
                assert!(!encoded.contains("reject") && !encoded.contains("private reason"));
                let other = if source == "board" { "talk" } else { "board" };
                assert_eq!(
                    messages::read(&tx, &params, other, 1, 0).await.unwrap().1,
                    0
                );
            } else {
                assert_eq!(total, 0);
                assert!(items.is_empty());
            }
        }
        let (first, total) = messages::read(&tx, &ActivityQuery::default(), source, 5, 0)
            .await
            .unwrap();
        let (second, second_total) = messages::read(&tx, &ActivityQuery::default(), source, 5, 5)
            .await
            .unwrap();
        assert_eq!(total, before + 6);
        assert_eq!(second_total, total);
        assert_eq!(first.len(), 5);
        assert_eq!(second.len(), (total - 5).min(5) as usize);
        assert!(
            first
                .iter()
                .all(|item| item["content"].as_str().unwrap().chars().count() <= 240)
        );
        assert!(
            first
                .iter()
                .all(|a| second.iter().all(|b| a["id"] != b["id"]))
        );
        assert!(approved_ids.iter().all(|id| {
            first
                .iter()
                .chain(second.iter())
                .any(|item| item["id"] == *id)
        }));
    }
    let before = announcements::read(&tx, &ActivityQuery::default(), 5, 0)
        .await
        .unwrap()
        .1;
    let row = tx
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO announcement(title,content) VALUES ($1,$2) RETURNING id",
            vec![prefix.into(), "告".repeat(2501).into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let id: i32 = row.try_get("", "id").unwrap();
    let params = ActivityQuery {
        id: Some(id),
        ..Default::default()
    };
    let (items, total) = announcements::read(&tx, &params, 1, 0).await.unwrap();
    assert_eq!(total, 1);
    assert_eq!(items[0]["contentTruncated"], true);
    assert_eq!(items[0]["content"].as_str().unwrap().chars().count(), 2000);
    assert_eq!(
        announcements::read(&tx, &ActivityQuery::default(), 5, 0)
            .await
            .unwrap()
            .1,
        before + 1
    );
    tx.rollback().await.unwrap();
}
