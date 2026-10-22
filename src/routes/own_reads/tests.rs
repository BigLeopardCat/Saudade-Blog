use super::*;
use sea_orm::{DatabaseBackend, DbErr, MockDatabase, QueryTrait};
use serde_json::json;

#[test]
fn own_filters_are_always_in_database_queries() {
    let params = serde_json::from_value(json!({"id":12,"status":"rejected"})).unwrap();
    let statement = board::query(7, &params).build(DatabaseBackend::Postgres);
    assert!(statement.sql.contains("\"user_id\" = $1"));
    assert!(statement.sql.contains("\"src\" = $2"));
    let params = serde_json::from_value(json!({"conversation_id":9,"before_id":20})).unwrap();
    let statement = history::query(7, &params).build(DatabaseBackend::Postgres);
    assert!(
        statement.sql.contains("\"user_id\" = $1")
            && statement.sql.contains("\"conversation_id\" = $2")
    );
    assert!(statement.sql.contains("\"id\" < $3"));
}

#[tokio::test]
async fn failures_remain_unknown() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(board::read(&db, 7, &board::BoardQuery::default(), 5, 0)
        .await
        .is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    let params = serde_json::from_value(json!({"conversation_id":9})).unwrap();
    assert!(history::read(&db, 7, &params, 5).await.is_err());
}

#[tokio::test]
async fn postgres_owned_pages_history_cursor_and_foreign_denial() {
    use sea_orm::{ConnectionTrait, Database, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let name = format!("activity_{}", uuid::Uuid::new_v4().simple());
    let user=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'fixture','user') RETURNING id",
        vec![name.into()])).await.unwrap().unwrap();
    let uid: i32 = user.try_get("", "id").unwrap();
    let conv = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO conversation (user_id) VALUES ($1) RETURNING id",
            vec![uid.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let cid: i32 = conv.try_get("", "id").unwrap();
    let mut msg_id = 0;
    let mut board_id = 0;
    for i in 0..7 {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO chat_history (user_id,conversation_id,role,content,created_at) \
             VALUES ($1,$2,'user',$3,localtimestamp) RETURNING id",
                vec![uid.into(), cid.into(), "长".repeat(2501).into()],
            ))
            .await
            .unwrap()
            .unwrap();
        msg_id = row.try_get("", "id").unwrap();
        let row=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO talk (title,content,cat,v,author,user_id,src,approved,created_at,updated_at) \
             VALUES ('',$1,'愿',0,'free name',$2,'board',$3,localtimestamp,localtimestamp) RETURNING id",
            vec!["灯".repeat(2501).into(),uid.into(),(i%3 as i16).into()])).await.unwrap().unwrap();
        board_id = row.try_get("", "id").unwrap();
    }
    let first = board::read(&txn, uid, &board::BoardQuery::default(), 5, 0)
        .await
        .unwrap();
    let second = board::read(&txn, uid, &board::BoardQuery::default(), 5, 5)
        .await
        .unwrap();
    assert_eq!(first["total"], 7);
    assert_eq!(first["items"].as_array().unwrap().len(), 5);
    assert_eq!(second["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        first["items"][0]["content"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        240
    );
    assert_eq!(first["items"][0]["contentTruncated"], true);
    let params = serde_json::from_value(json!({"id":board_id})).unwrap();
    assert_eq!(
        board::read(&txn, uid + 1, &params, 1, 0).await.unwrap()["total"],
        0
    );
    let params = serde_json::from_value(json!({"conversation_id":cid})).unwrap();
    let first = history::read(&txn, uid, &params, 5).await.unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 5);
    assert_eq!(first["hasMore"], true);
    assert_eq!(first["includesImages"], false);
    assert_eq!(
        first["items"][0]["content"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        300
    );
    let params =
        serde_json::from_value(json!({"conversation_id":cid,"before_id":first["nextBeforeId"]}))
            .unwrap();
    let second = history::read(&txn, uid, &params, 5).await.unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 2);
    assert_eq!(second["hasMore"], false);
    assert!(history::read(&txn, uid + 1, &params, 5).await.is_err());
    let params =
        serde_json::from_value(json!({"conversation_id":cid,"message_id":msg_id})).unwrap();
    let detail = history::read(&txn, uid, &params, 1).await.unwrap();
    assert_eq!(
        detail["items"][0]["content"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2000
    );
    assert_eq!(detail["items"][0]["contentTruncated"], true);
    txn.rollback().await.unwrap();
}
