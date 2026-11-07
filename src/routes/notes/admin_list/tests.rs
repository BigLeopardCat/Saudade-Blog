use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, Statement, TransactionTrait};
use serde_json::json;

#[test]
fn filters_are_bound_and_summary_projection_does_not_select_bodies() {
    let params =
        serde_json::from_value(json!({"keyword":"literal_%", "tags":"12,13", "status":"draft"}))
            .unwrap();
    let statement = selection(&params)
        .unwrap()
        .limit(20)
        .offset(40)
        .into_partial_model::<NoteSummary>()
        .build(DatabaseBackend::Postgres);
    let selected = statement.sql.split(" FROM ").next().unwrap();
    assert!(!selected.contains("\"content\""), "{statement}");
    assert!(statement.sql.contains("note_tag") && statement.sql.contains("ILIKE"));
    assert!(statement
        .sql
        .contains("\"created_at\" DESC, \"note\".\"id\" DESC"));
    assert!(!statement.sql.contains("literal_%"));
    assert!(statement
        .values
        .unwrap()
        .0
        .contains(&"%literal\\_\\%%".to_owned().into()));
    let roots = selection(&ListQuery::default())
        .unwrap()
        .build(DatabaseBackend::Postgres);
    assert!(roots.sql.contains("\"draft_of\" IS NULL"));
}

#[test]
fn invalid_filters_are_rejected_instead_of_broadening_the_selection() {
    for value in [
        json!({"status":"invented"}),
        json!({"is_top":4}),
        json!({"start_date":"2026-02-30"}),
        json!({"end_date":"yesterday"}),
        json!({"tags":"1,0"}),
        json!({"tags":"1,no"}),
        json!({"title":" "}),
        json!({"keyword":"x".repeat(101)}),
    ] {
        let params = serde_json::from_value(value).unwrap();
        assert!(selection(&params).is_err());
    }
}

#[tokio::test]
async fn a_database_failure_never_returns_a_successful_empty_page() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("unavailable".into())])
        .into_connection();
    assert!(read(&db, &ListQuery::default(), 10).await.is_err());
}

#[tokio::test]
async fn postgres_pages_filter_the_full_selection_and_retain_draft_semantics() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let name = format!("note_page_{}", uuid::Uuid::new_v4().simple());
    let category = tx
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO category (name) VALUES ($1) RETURNING id",
            vec![name.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let category_id: i32 = category.try_get("", "id").unwrap();
    tx.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note (title,content,category_id,status,is_public,created_at,updated_at) \
         SELECT $1 || n::text,CASE WHEN n=1 THEN 'oldest body keyword' ELSE repeat('BODY_NOT_IN_LIST',1000) END,$2, \
         CASE WHEN n=1003 THEN 'draft' WHEN n=1002 THEN 'private' ELSE 'published' END,n<1002, \
         '2026-01-01 00:00:00'::timestamp,'2026-01-01 00:00:00'::timestamp FROM generate_series(1,1003) n",
        vec![name.clone().into(),category_id.into()])).await.unwrap();
    let root = tx
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT min(id) AS id FROM note WHERE category_id=$1",
            vec![category_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let oldest: i32 = root.try_get("", "id").unwrap();
    tx.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note (title,content,category_id,status,is_public,draft_of) VALUES ('editor shadow','shadow',$1,'draft',false,$2)",
        vec![category_id.into(),oldest.into()])).await.unwrap();
    let tag = tx
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO tag_one (name) VALUES ($1) RETURNING id",
            vec![name.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let tag_id: i32 = tag.try_get("", "id").unwrap();
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO note_tag (note_id,seq,tag_one_id) VALUES ($1,0,$2)",
        vec![oldest.into(), tag_id.into()],
    ))
    .await
    .unwrap();
    let mut params: ListQuery =
        serde_json::from_value(json!({"categories":name,"page":1})).unwrap();
    let first = read(&tx, &params, 50).await.unwrap();
    assert_eq!(first.total, 1003);
    assert_eq!(first.items.len(), 50);
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains("BODY_NOT_IN_LIST"));
    params.page = Some(21);
    let last = read(&tx, &params, 50).await.unwrap();
    assert_eq!(last.items.len(), 3);
    assert_eq!(last.items.last().unwrap().id, oldest);
    assert_eq!(last.items.last().unwrap().tag_refs[0].id, tag_id);
    params.page = Some(999);
    assert_eq!(read(&tx, &params, 50).await.unwrap().page, 21);
    params.keyword = Some("oldest".into());
    let old = read(&tx, &params, 10).await.unwrap();
    assert_eq!(old.total, 1);
    assert_eq!(old.page, 1);
    assert_eq!(old.items[0].id, oldest);
    params.keyword = None;
    params.status = Some("draft".into());
    assert_eq!(read(&tx, &params, 10).await.unwrap().total, 2);
    params.status = Some("public".into());
    assert_eq!(read(&tx, &params, 10).await.unwrap().total, 1001);
    params.tags = Some(tag_id.to_string());
    let tagged = read(&tx, &params, 10).await.unwrap();
    assert_eq!(tagged.total, 1);
    assert_eq!(tagged.items[0].id, oldest);
    tx.rollback().await.unwrap();
}
