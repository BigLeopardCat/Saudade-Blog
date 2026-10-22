use super::*;
use sea_orm::{DatabaseBackend, QueryTrait};
use serde_json::json;

#[test]
fn windows_and_closed_statuses() {
    for (page, size) in [(Some(0),Some(5)), (Some(1),None), (None,Some(0)),
                         (None,Some(51)), (Some(u64::MAX),Some(5))] {
        assert!(window(page, size).is_err());
    }
    assert_eq!(window(None,None).unwrap(), None);
    assert_eq!(window(Some(2),Some(5)).unwrap(), Some((5,5)));
    let uri = "/?page=2&page_size=5&status=pending".parse().unwrap();
    let params = axum::extract::Query::<super::super::quota::ListQuotaQuery>::try_from_uri(&uri).unwrap().0;
    assert_eq!(window(params.page,params.page_size).unwrap(), Some((5,5)));
    let uri = "/?page_size=5&done=false".parse().unwrap();
    let params = axum::extract::Query::<super::super::todos::TodoQuery>::try_from_uri(&uri).unwrap().0;
    assert_eq!(params.done, Some(false));
    assert!(serde_json::from_value::<super::super::quota::ListQuotaQuery>(
        json!({"status":"unknown"})).is_err());
}

#[test]
fn filters_precede_pagination_and_owner_is_bound() {
    let params = serde_json::from_value(json!({"status":"rejected"})).unwrap();
    let statement = super::super::quota::request_query(&params).build(DatabaseBackend::Postgres);
    assert!(statement.sql.contains("\"status\" = $1"));
    assert!(statement.sql.contains("ORDER BY"));
    assert_eq!(statement.values.unwrap().0, vec![2i16.into()]);
    let statement = super::super::todos::todo_query(17, Some(false)).build(DatabaseBackend::Postgres);
    assert!(statement.sql.contains("\"user_id\" = $1"));
    assert!(statement.sql.contains("\"done\" = $2"));
    assert_eq!(statement.values.unwrap().0, vec![17i32.into(),false.into()]);
}

#[tokio::test]
async fn postgres_queue_pages_and_totals_respect_filters_and_owner() {
    use sea_orm::{ConnectionTrait, Database, PaginatorTrait, QuerySelect, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else { return };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let name = format!("queue_it_{}", uuid::Uuid::new_v4().simple());
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,$2,'admin') RETURNING id",
        vec![name.into(),uuid::Uuid::new_v4().to_string().into()])).await.unwrap().unwrap();
    let uid: i32 = row.try_get("", "id").unwrap();
    let pending = serde_json::from_value(json!({"status":"pending"})).unwrap();
    let before = super::super::quota::request_query(&pending).count(&txn).await.unwrap();
    for i in 0..7 {
        txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO quota_request (user_id,reason,status,created_at) VALUES ($1,'test',0,localtimestamp)",
            vec![uid.into()])).await.unwrap();
        txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO dashboard_todo (user_id,sort_order,text,done) VALUES ($1,$2,'test',false)",
            vec![uid.into(),i.into()])).await.unwrap();
    }
    txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO dashboard_todo (user_id,sort_order,text,done) VALUES ($1,8,'completed',true)",
        vec![uid.into()])).await.unwrap();
    assert_eq!(super::super::quota::request_query(&pending).count(&txn).await.unwrap(), before+7);
    let todos = super::super::todos::todo_query(uid, Some(false));
    assert_eq!(todos.clone().count(&txn).await.unwrap(), 7);
    let first = todos.clone().limit(5).all(&txn).await.unwrap();
    let second = todos.limit(5).offset(5).all(&txn).await.unwrap();
    assert_eq!((first.len(),second.len()), (5,2));
    assert!(first.iter().all(|a| second.iter().all(|b| a.id != b.id)));
    assert!(first.iter().chain(second.iter()).all(|row| row.user_id == uid && !row.done));
    assert_eq!(super::super::todos::todo_query(uid, Some(true)).count(&txn).await.unwrap(), 1);
    assert_eq!(super::super::todos::todo_query(uid+1, None).count(&txn).await.unwrap(), 0);
    let all = serde_json::from_value(json!({"status":"all"})).unwrap();
    let first = super::super::quota::request_query(&all).limit(5).all(&txn).await.unwrap();
    let second = super::super::quota::request_query(&all).limit(5).offset(5).all(&txn).await.unwrap();
    assert!(first.iter().all(|a| second.iter().all(|b| a.id != b.id)));
    assert_eq!(first.iter().chain(second.iter()).filter(|row| row.user_id == uid).count(), 7);
    txn.rollback().await.unwrap();
}
