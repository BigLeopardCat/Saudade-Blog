use super::*;
use sea_orm::{DatabaseBackend, DbErr, MockDatabase, QueryTrait};
use serde_json::json;

#[test]
fn projections_exclude_bodies_and_credentials_and_filters_are_bound() {
    let params = serde_json::from_value(json!({"username":"exact_%'", "id":17})).unwrap();
    let statement = accounts::query(&params)
        .into_partial_model::<accounts::AccountRow>()
        .into_statement(DatabaseBackend::Postgres);
    assert!(!statement.sql.contains("password") && !statement.sql.contains("token_version"));
    let values = statement.values.unwrap().0;
    assert!(!values.contains(&crate::authz::ROLE_SUPERADMIN.into()));
    assert!(values.contains(&"exact_%'".to_string().into()));
    let params = serde_json::from_value(json!({"keyword":"%_"})).unwrap();
    let statement = articles::query(&params, None).build(DatabaseBackend::Postgres);
    assert!(statement.sql.contains("draft_of\" IS NULL") && statement.sql.contains("ILIKE"));
    assert!(statement.sql.contains("tag_one") && statement.sql.contains("tag_two"));
    assert!(statement
        .values
        .unwrap()
        .0
        .contains(&"%\\%\\_%".to_string().into()));
    assert!(window(Some(0), Some(5)).is_err());
    assert!(!valid_text(Some(" ")) && !valid_text(Some(&"x".repeat(101))));
}

#[tokio::test]
async fn count_failure_is_not_an_empty_catalog() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(
        accounts::read(&db, &accounts::AccountQuery::default(), 5, 0)
            .await
            .is_err()
    );
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(
        articles::read(&db, &articles::ArticleQuery::default(), 5, 0)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn postgres_catalog_pages_and_metadata_are_bounded_and_filtered() {
    use sea_orm::{ConnectionTrait, Database, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let prefix = format!("catalog_{}", uuid::Uuid::new_v4().simple());
    let before = accounts::read(&txn, &accounts::AccountQuery::default(), 5, 0)
        .await
        .unwrap()
        .1;
    let mut uid = 0;
    for i in 0..8 {
        let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'not-selected',$2) RETURNING id",
            vec![format!("{prefix}_{i}%_").into(),if i==7 {"superadmin"} else {"user"}.into()]))
            .await.unwrap().unwrap();
        uid = row.try_get("", "id").unwrap();
    }
    let (_, total) = accounts::read(&txn, &accounts::AccountQuery::default(), 5, 0)
        .await
        .unwrap();
    assert_eq!(total, before + 7);
    let exact = serde_json::from_value(json!({"username":format!("{prefix}_0%_")})).unwrap();
    let (items, total) = accounts::read(&txn, &exact, 5, 0).await.unwrap();
    assert_eq!(total, 1);
    let output = serde_json::to_string(&items).unwrap();
    assert!(!output.contains("password") && !output.contains("not-selected"));
    let hidden = serde_json::from_value(json!({"id":uid})).unwrap();
    assert_eq!(accounts::read(&txn, &hidden, 5, 0).await.unwrap().1, 0);
    let row = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO category (name) VALUES ($1) RETURNING id",
            vec![prefix.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let category_id: i32 = row.try_get("", "id").unwrap();
    let mut note_id = 0;
    for i in 0..7 {
        let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO note (title,content,category_id,status,is_public,created_at,updated_at) \
             VALUES ($1,$2,$3,$4,$5,localtimestamp,localtimestamp) RETURNING id",
            vec![format!("{prefix}_{i}").into(),if i==0 {"literal %_ body"} else {"private body"}.into(),
                 category_id.into(),if i%2==0 {"draft"} else {"published"}.into(),(i%2!=0).into()]))
            .await.unwrap().unwrap();
        note_id = row.try_get("", "id").unwrap();
    }
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO note (title,content,category_id,draft_of,created_at,updated_at) \
         VALUES ('shadow','not a separate article',$1,$2,localtimestamp,localtimestamp)",
        vec![category_id.into(), note_id.into()],
    ))
    .await
    .unwrap();
    let tag = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO tag_two (name) VALUES ($1) RETURNING id",
            vec![prefix.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let tag_id: i32 = tag.try_get("", "id").unwrap();
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO note_tag (note_id,seq,tag_two_id) VALUES ($1,0,$2)",
        vec![note_id.into(), tag_id.into()],
    ))
    .await
    .unwrap();
    let params = serde_json::from_value(json!({"category":prefix})).unwrap();
    let (first, total) = articles::read(&txn, &params, 5, 0).await.unwrap();
    let (second, tail_total) = articles::read(&txn, &params, 5, 5).await.unwrap();
    assert_eq!((total, tail_total, first.len(), second.len()), (7, 7, 5, 2));
    assert!(first.iter().all(|a| second.iter().all(|b| a.id != b.id)));
    let output = serde_json::to_string(&first).unwrap();
    assert!(!output.contains("private body") && !output.contains("literal %_ body"));
    let selected = first.iter().find(|row| row.id == note_id).unwrap();
    assert_eq!(selected.tags[0].level, 2);
    assert_eq!(selected.tags[0].id, tag_id);
    let params = serde_json::from_value(json!({"category":prefix,"keyword":"%_"})).unwrap();
    assert_eq!(articles::read(&txn, &params, 5, 0).await.unwrap().1, 1);
    let params = serde_json::from_value(json!({"category":prefix,"keyword":prefix})).unwrap();
    assert_eq!(articles::read(&txn, &params, 5, 0).await.unwrap().1, 7);
    let params = serde_json::from_value(json!({"category":format!("{prefix}_missing")})).unwrap();
    assert!(articles::read(&txn, &params, 5, 0).await.is_err());
    txn.rollback().await.unwrap();
}
