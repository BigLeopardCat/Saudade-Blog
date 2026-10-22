use super::*;
use sea_orm::{DatabaseBackend, DbErr, MockDatabase, QueryTrait};

#[test]
fn public_query_requires_published_root_and_public_flag() {
    let sql = visible_notes().build(DatabaseBackend::Postgres).sql;
    for boundary in ["\"is_public\"", "\"status\" IN", "\"draft_of\" IS NULL"] {
        assert!(sql.contains(boundary), "{sql}");
    }
}

#[tokio::test]
async fn query_failures_remain_errors() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(categories::read(&db, 5, 0).await.is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(tags::read(&db, &tags::TagQuery::default(), 5, 0)
        .await
        .is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(super::super::catalog::articles::read_public(
        &db,
        &ArticleQuery::default(),
        5,
        0,
        false
    )
    .await
    .is_err());
}

#[tokio::test]
async fn postgres_public_counts_exclude_hidden_drafts_and_shadow_versions() {
    use sea_orm::{ConnectionTrait, Database, Statement, TransactionTrait, Value};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    async fn insert<C: ConnectionTrait>(db: &C, sql: &str, values: Vec<Value>) -> i32 {
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
    let name = format!("catalog_{}", uuid::Uuid::new_v4().simple());
    let cid = insert(
        &txn,
        "INSERT INTO category (name) VALUES ($1) RETURNING id",
        vec![name.clone().into()],
    )
    .await;
    let one = insert(
        &txn,
        "INSERT INTO tag_one (id,name) SELECT GREATEST(COALESCE((SELECT max(id) FROM tag_one),0),COALESCE((SELECT max(id) FROM tag_two),0))+100000,$1 RETURNING id",
        vec![name.clone().into()],
    )
    .await;
    // Explicit matching IDs exercise the independent tag namespaces.
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO tag_two (id,name,tag_one_id) VALUES ($1,$2,$3)",
        vec![one.into(), name.clone().into(), one.into()],
    ))
    .await
    .unwrap();
    let mut root = 0;
    for (index, status, public, shadow) in [
        (0, "public", true, false),
        (1, "published", true, false),
        (2, "private", false, false),
        (3, "public", false, false),
        (4, "draft", false, false),
        (5, "public", true, true),
        (6, "published", false, false),
    ] {
        let id = insert(&txn,
            "INSERT INTO note (title,content,category_id,status,is_public,is_top,draft_of,created_at,updated_at) \
             VALUES ($1,'SECRET BODY',$2,$3,$4,1,$5,localtimestamp,localtimestamp) RETURNING id",
            vec![name.clone().into(),cid.into(),status.into(),public.into(),if shadow {Some(root)} else {None}.into()]).await;
        if index == 0 {
            root = id;
        }
        txn.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO note_tag (note_id,seq,tag_one_id) VALUES ($1,0,$2)",
            vec![id.into(), one.into()],
        ))
        .await
        .unwrap();
        if index != 0 {
            txn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO note_tag (note_id,seq,tag_two_id) VALUES ($1,1,$2)",
                vec![id.into(), one.into()],
            ))
            .await
            .unwrap();
        }
    }
    let filter = ArticleQuery {
        category_id: Some(cid),
        ..Default::default()
    };
    let (first, total) = super::super::catalog::articles::read_public(&txn, &filter, 1, 0, true)
        .await
        .unwrap();
    let (second, total2) = super::super::catalog::articles::read_public(&txn, &filter, 1, 1, true)
        .await
        .unwrap();
    assert_eq!((total, total2), (2, 2));
    assert_eq!((first.len(), second.len()), (1, 1));
    assert_ne!(first[0].id, second[0].id);
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains("SECRET BODY"));
    let (cats, _) = categories::read(&txn, 10000, 0).await.unwrap();
    assert_eq!(
        cats.iter()
            .find(|row| row.id == cid)
            .unwrap()
            .public_article_count,
        2
    );
    for (level, count) in [(1, 2), (2, 1)] {
        let params = tags::TagQuery {
            level: Some(level),
            parent_id: if level == 2 { Some(one) } else { None },
            ..Default::default()
        };
        let (rows, _) = tags::read(&txn, &params, 10000, 0).await.unwrap();
        assert_eq!(
            rows.iter()
                .find(|row| row.id == one)
                .unwrap()
                .public_article_count,
            count
        );
    }
    let params = tags::TagQuery {
        parent_id: Some(i32::MAX),
        ..Default::default()
    };
    assert!(tags::read(&txn, &params, 5, 0).await.is_err());
    txn.rollback().await.unwrap();
}
