use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, QueryTrait, Statement, TransactionTrait};

#[test]
fn cursor_is_typed_bounded_and_deterministic_for_equal_timestamps() {
    let at = "2026-11-08T12:00:00".parse().unwrap();
    let cursor = Cursor { at, id: 72 };
    let (limit, decoded) = window(
        &FeedQuery {
            limit: Some(50),
            cursor: Some(cursor.encode()),
        },
        20,
    )
    .unwrap();
    assert_eq!(limit, 50);
    assert_eq!(decoded.unwrap(), cursor);
    for value in [
        String::new(),
        "invalid".into(),
        "x".repeat(129),
        Cursor { at, id: 0 }.encode(),
    ] {
        assert!(
            window(
                &FeedQuery {
                    cursor: Some(value),
                    ..Default::default()
                },
                20
            )
            .is_err()
        );
    }
    for limit in [0, 51, u64::MAX] {
        assert!(
            window(
                &FeedQuery {
                    limit: Some(limit),
                    ..Default::default()
                },
                20
            )
            .is_err()
        );
    }
    let archive = archive_query(Some(&cursor)).build(DatabaseBackend::Postgres);
    assert!(archive.sql.contains("\"draft_of\" IS NULL"));
    assert!(archive.sql.contains("\"is_public\" ="));
    assert!(
        archive
            .sql
            .contains("\"created_at\" DESC, \"note\".\"id\" DESC")
    );
    assert!(archive.sql.contains("\"created_at\" <") && archive.sql.contains("\"id\" <"));
    let talk = talk_query(Some(&cursor), Some(8)).build(DatabaseBackend::Postgres);
    assert!(talk.sql.contains("\"src\" =") && talk.sql.contains("\"approved\" ="));
    assert!(
        talk.sql
            .contains("\"created_at\" DESC, \"talk\".\"id\" DESC")
    );
}

#[tokio::test]
async fn database_failures_are_not_confirmed_empty_pages() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(archive_page(&db, 50, None).await.is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(read_talks(&db, 20, None, None).await.is_err());
}

#[tokio::test]
async fn postgres_archive_passes_999_and_talk_deep_links_never_expose_hidden_sources() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let prefix = format!("public_feed_{}", uuid::Uuid::new_v4().simple());
    async fn insert<C: ConnectionTrait>(db: &C, sql: &str, values: Vec<sea_orm::Value>) -> i32 {
        db.query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "id")
        .unwrap()
    }
    let before = archive_page(&tx, 1, None).await.unwrap().total.unwrap();
    let root = insert(&tx,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES ($1,'SECRET BODY','public',true,'2099-01-01','2099-01-01') RETURNING id",
        vec![prefix.clone().into()]).await;
    let second = insert(&tx,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES ($1,'SECRET BODY','published',true,'2099-01-01','2099-01-01') RETURNING id",
        vec![prefix.clone().into()]).await;
    for (status, public, shadow) in [
        ("private", false, None),
        ("draft", false, None),
        ("public", true, Some(root)),
    ] {
        insert(&tx,
            "INSERT INTO note(title,content,status,is_public,draft_of,created_at,updated_at) VALUES ($1,'SECRET BODY',$2,$3,$4,'2099-01-01','2099-01-01') RETURNING id",
            vec![prefix.clone().into(), status.into(), public.into(), shadow.into()]).await;
    }
    let first = archive_page(&tx, 1, None).await.unwrap();
    assert_eq!(first.total, Some(before + 2));
    assert_eq!(first.items[0].id, second);
    let cursor = window(
        &FeedQuery {
            cursor: first.next_cursor.clone(),
            ..Default::default()
        },
        50,
    )
    .unwrap()
    .1;
    let next = archive_page(&tx, 1, cursor.as_ref()).await.unwrap();
    assert_eq!(next.items[0].id, root);
    let value = serde_json::to_value(first).unwrap();
    let keys = value["items"][0].as_object().unwrap();
    assert_eq!(keys.len(), 3);
    assert!(!value.to_string().contains("SECRET BODY"));
    tx.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) SELECT $1,'SECRET BODY','public',true,'2099-01-01','2099-01-01' FROM generate_series(1,1005)",
        vec![prefix.clone().into()])).await.unwrap();
    let mut cursor = None;
    let mut seen = std::collections::HashSet::new();
    loop {
        let page = archive_page(&tx, 50, cursor.as_ref()).await.unwrap();
        for row in &page.items {
            assert!(seen.insert(row.id), "duplicate across cursor pages");
        }
        if page.next_cursor.is_none() {
            break;
        }
        cursor = window(
            &FeedQuery {
                cursor: page.next_cursor,
                ..Default::default()
            },
            50,
        )
        .unwrap()
        .1;
        assert!(seen.len() < 100_000);
    }
    assert_eq!(seen.len() as u64, before + 1007);
    let uid = insert(&tx,
        "INSERT INTO \"user\"(username,nickname,password,role) VALUES ($1,'展示名','fixture','user') RETURNING id",
        vec![prefix.clone().into()]).await;
    let mut visible = Vec::new();
    for (source, approved) in [
        ("talk", 1i16),
        ("talk", 1),
        ("talk", 0),
        ("talk", 2),
        ("board", 1),
    ] {
        let id = insert(&tx,
            "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,created_at,updated_at) VALUES ($1,$2,'愿',0,'display',$3,$4,$5,'2099-01-01','2099-01-01') RETURNING id",
            vec![prefix.clone().into(), "文".repeat(2501).into(), uid.into(), source.into(), approved.into()]).await;
        let detail = read_talks(&tx, 1, None, Some(id)).await.unwrap();
        if source == "talk" && approved == 1 {
            visible.push(id);
            assert_eq!(detail[0].content.chars().count(), 2501);
            assert_eq!(detail[0].nickname, "展示名");
            let data = serde_json::to_value(&detail[0]).unwrap();
            assert!(data.get("user_id").is_none() && data.get("rejectReason").is_none());
        } else {
            assert!(detail.is_empty());
        }
    }
    let first = read_talks(&tx, 1, None, None).await.unwrap();
    assert_eq!(first[0].id, visible[1]);
    let cursor = Cursor {
        at: first[0].created_at,
        id: first[0].id,
    };
    let next = read_talks(&tx, 1, Some(&cursor), None).await.unwrap();
    assert_eq!(next[0].id, visible[0]);
    tx.rollback().await.unwrap();
}
