use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, Statement, Value};
use std::collections::BTreeMap;

#[test]
fn selection_rejects_ambiguous_empty_and_invalid_id_sets() {
    for request in [
        ReadRequest {
            ids: vec![],
            all: false,
        },
        ReadRequest {
            ids: vec![1],
            all: true,
        },
        ReadRequest {
            ids: vec![0],
            all: false,
        },
        ReadRequest {
            ids: vec![1, 1],
            all: false,
        },
        ReadRequest {
            ids: (1..=101).collect(),
            all: false,
        },
    ] {
        assert!(selection(request).is_err());
    }
    assert_eq!(
        selection(ReadRequest {
            ids: vec![2, 1],
            all: false
        })
        .unwrap(),
        Selection::Selected(vec![1, 2])
    );
    assert_eq!(
        selection(ReadRequest {
            ids: vec![],
            all: true
        })
        .unwrap(),
        Selection::AllUnread
    );
    let mut query = update(7).filter(user_notification::Column::Id.is_in([1, 2]));
    QueryTrait::query(&mut query).returning_col(user_notification::Column::Id);
    let sql = query.build(DatabaseBackend::Postgres).sql;
    assert!(sql.contains("RETURNING \"id\"") && !sql.contains("content"));
    assert!(
        sql.contains("\"user_id\"")
            && sql.contains("\"deleted_at\"")
            && sql.contains("\"is_read\"")
    );
}

fn locked(id: i32, read: bool) -> BTreeMap<&'static str, Value> {
    BTreeMap::from([("id", id.into()), ("is_read", read.into())])
}

#[tokio::test]
async fn failed_count_rolls_back_mutation_instead_of_certifying_completion() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([
            vec![locked(1, false)],
            vec![BTreeMap::from([("id", Value::from(1))])],
        ])
        .append_query_errors([DbErr::Custom("count unavailable".into())])
        .into_connection();
    assert!(apply(&db, 7, Selection::Selected(vec![1])).await.is_err());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("ROLLBACK") && !log.contains("COMMIT"));
}

async fn notice<C: ConnectionTrait>(db: &C, uid: i32, read: bool, deleted: bool) -> i32 {
    db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO user_notification(user_id,type,title,content,is_read,deleted_at) \
         VALUES($1,'system','read contract','BODY_MUST_NOT_TRANSFER',$2,CASE WHEN $3 THEN localtimestamp ELSE NULL END) RETURNING id",
        [uid.into(),read.into(),deleted.into()])).await.unwrap().unwrap().try_get("","id").unwrap()
}

async fn is_read<C: ConnectionTrait>(db: &C, id: i32) -> bool {
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT is_read FROM user_notification WHERE id=$1",
        [id.into()],
    ))
    .await
    .unwrap()
    .unwrap()
    .try_get("", "is_read")
    .unwrap()
}

#[tokio::test]
async fn postgres_fixed_ids_are_atomic_owned_and_idempotent_and_all_returns_only_counts() {
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
    let fresh = notice(&tx, users[0], false, false).await;
    let already = notice(&tx, users[0], true, false).await;
    let deleted = notice(&tx, users[0], false, true).await;
    let spare = notice(&tx, users[0], false, false).await;
    let foreign = notice(&tx, users[1], false, false).await;
    for missing in [deleted, foreign, i32::MAX] {
        let mut ids = vec![fresh, missing];
        ids.sort_unstable();
        assert!(selected(&tx, users[0], &ids).await.is_err());
        assert!(!is_read(&tx, fresh).await);
    }
    let receipt = selected(&tx, users[0], &[fresh, already]).await.unwrap();
    let json = serde_json::to_value(receipt).unwrap();
    assert_eq!(json["scope"], "selected");
    assert_eq!(json["ownerUserId"], users[0]);
    assert_eq!(json["matchedIds"], serde_json::json!([fresh, already]));
    assert_eq!(json["changedIds"], serde_json::json!([fresh]));
    assert_eq!(json["unreadCount"], 1);
    assert!(
        is_read(&tx, fresh).await && !is_read(&tx, spare).await && !is_read(&tx, foreign).await
    );
    let replay =
        serde_json::to_value(selected(&tx, users[0], &[fresh, already]).await.unwrap()).unwrap();
    assert_eq!(replay["changedIds"], serde_json::json!([]));
    assert_eq!(replay["isRead"], true);
    for _ in 0..125 {
        notice(&tx, users[0], false, false).await;
    }
    let all = serde_json::to_value(all_unread(&tx, users[0]).await.unwrap()).unwrap();
    assert_eq!(all["scope"], "all_unread");
    assert_eq!(all["changedCount"], 126);
    assert_eq!(all["unreadCount"], 0);
    assert!(all.get("matchedIds").is_none() && all.get("changedIds").is_none());
    assert!(!is_read(&tx, foreign).await);
    tx.rollback().await.unwrap();
}
