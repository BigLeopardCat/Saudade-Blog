use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase};

#[test]
fn query_bounds_reject_empty_control_and_large_pages() {
    for (keyword, size) in [
        (" ".into(), 5),
        ("x\0".into(), 5),
        ("文".repeat(129), 5),
        ("x".into(), 11),
    ] {
        assert!(
            SearchQuery {
                keyword,
                page: None,
                page_size: Some(size)
            }
            .window()
            .is_err()
        );
    }
    assert_eq!(
        SearchQuery {
            keyword: "OTA".into(),
            page: Some(2),
            page_size: Some(3)
        }
        .window()
        .unwrap(),
        (3, 3)
    );
}

#[tokio::test]
async fn database_failure_is_not_an_empty_search() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(read(&db, "OTA", 3, 0).await.is_err());
}

#[tokio::test]
async fn postgres_search_filters_full_bodies_and_keeps_totals_and_visibility() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let marker = format!("activity_{}_100%_x\\p", uuid::Uuid::new_v4().simple());
    let user = tx.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO \"user\" (username,password,role) VALUES ($1,'fixture','user') RETURNING id",
        [uuid::Uuid::new_v4().simple().to_string().into()])).await.unwrap().unwrap();
    let uid: i32 = user.try_get("", "id").unwrap();
    for source in ["board", "talk"] {
        for approved in [0i16, 1, 2] {
            tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
                "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,reject_reason,created_at,updated_at) \
                 VALUES ($1,$2,'愿',0,'public name',$3,$4,$5,'private reason',localtimestamp,localtimestamp)",
                [marker.clone().into(), format!("{}{} end", "前".repeat(600), marker).into(), uid.into(), source.into(), approved.into()])).await.unwrap();
        }
    }
    // A board's free-form signature is not searchable content.
    tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,reject_reason,created_at,updated_at) \
         VALUES ($1,'unrelated body','愿',0,$1,$2,'board',1,'',localtimestamp,localtimestamp)",
        [marker.clone().into(), uid.into()])).await.unwrap();
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO announcement(title,content) VALUES ('fixture',$1)",
        [format!("{}{}", "前".repeat(600), marker).into()],
    ))
    .await
    .unwrap();
    let decoy = marker.replace('%', "Z").replace('_', "Q").replace('\\', "");
    tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,reject_reason,created_at,updated_at) \
         VALUES ('decoy',$1,'愿',0,'public name',$2,'talk',1,'',localtimestamp,localtimestamp)",
        [decoy.into(), uid.into()])).await.unwrap();
    let first = read(&tx, &marker.to_uppercase(), 2, 0).await.unwrap();
    assert_eq!(
        (
            first.total,
            first.counts.announcements,
            first.counts.board,
            first.counts.talk
        ),
        (3, 1, 1, 1)
    );
    assert!(first.has_more);
    let second = read(&tx, &marker, 2, 2).await.unwrap();
    assert_eq!(second.total, 3);
    assert!(!second.has_more);
    assert_eq!(first.items.len() + second.items.len(), 3);
    for item in first.items.iter().chain(second.items.iter()) {
        assert!(
            item["content"]
                .as_str()
                .unwrap()
                .to_lowercase()
                .contains(&marker)
        );
        assert!(item["content"].as_str().unwrap().chars().count() <= 240);
        assert_eq!(item["contentTruncated"], true);
        assert!(
            !item.to_string().contains("userId") && !item.to_string().contains("private reason")
        );
    }
    let past = read(&tx, &marker, 2, 4).await.unwrap();
    assert_eq!(past.total, 3);
    assert!(past.items.is_empty() && !past.has_more);
    assert_eq!(
        read(&tx, &(marker.clone() + "absent"), 2, 0)
            .await
            .unwrap()
            .total,
        0
    );
    tx.rollback().await.unwrap();
}
