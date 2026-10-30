use super::{batch, targets, Intent};
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement, TransactionTrait};
use serde_json::json;

#[test]
fn batches_require_an_exact_bounded_set_and_closed_fields() {
    for values in [vec![], vec![1, 1], vec![0], (1..=21).collect()] {
        let value = json!({"article_ids": values, "intent": {"add": ["x"]}});
        let request: batch::Selection = serde_json::from_value(value).unwrap();
        assert!(batch::validate_selection(&request.article_ids).is_err());
    }
    assert!(serde_json::from_value::<batch::Selection>(json!({
        "article_ids": [1], "intent": {"add": ["x"]}, "all": true,
    }))
    .is_err());
    assert!(serde_json::from_value::<batch::Change>(json!({
        "items": [{"id": true, "version": "a".repeat(64)}], "intent": {"add": ["x"]},
    }))
    .is_err());
}

async fn insert<C: ConnectionTrait>(db: &C, title: &str) -> i32 {
    let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES($1,'keep body','private',false,localtimestamp,localtimestamp) RETURNING id",
        vec![title.into()])).await.unwrap().unwrap();
    row.try_get("", "id").unwrap()
}

#[tokio::test]
async fn postgres_batch_freezes_all_versions_and_creates_one_shared_tag() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let prefix = format!("tagbatch_{}", uuid::Uuid::new_v4().simple());
    let first = insert(&txn, &format!("{prefix}_first")).await;
    let second = insert(&txn, &format!("{prefix}_second")).await;
    let name = format!("tb_{}", uuid::Uuid::new_v4().simple());
    let intent: Intent = serde_json::from_value(json!({"add": [name]})).unwrap();
    let before = [
        targets::prepare(&txn, first, &intent, false).await.unwrap(),
        targets::prepare(&txn, second, &intent, false)
            .await
            .unwrap(),
    ];
    let stale = batch::Change {
        items: before
            .iter()
            .map(|plan| batch::Item {
                id: plan.id,
                version: plan.version.clone(),
            })
            .collect(),
        intent: serde_json::from_value(json!({"add": [name]})).unwrap(),
    };
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET content='user edit' WHERE id=$1",
        vec![second.into()],
    ))
    .await
    .unwrap();
    assert!(batch::apply(&txn, &stale).await.is_err());
    assert!(targets::current(&txn, first).await.unwrap().is_empty());
    assert!(targets::current(&txn, second).await.unwrap().is_empty());
    let plans = [
        targets::prepare(&txn, first, &intent, false).await.unwrap(),
        targets::prepare(&txn, second, &intent, false)
            .await
            .unwrap(),
    ];
    let request = batch::Change {
        items: plans
            .iter()
            .rev()
            .map(|plan| batch::Item {
                id: plan.id,
                version: plan.version.clone(),
            })
            .collect(),
        intent,
    };
    let outcomes = batch::apply(&txn, &request).await.unwrap();
    assert_eq!(outcomes.len(), 2);
    assert!(outcomes.iter().all(|row| row.changed));
    assert_eq!(outcomes[0].state.id, first.min(second));
    let left = targets::current(&txn, first).await.unwrap();
    let right = targets::current(&txn, second).await.unwrap();
    assert_eq!(left, right);
    assert_eq!(left.len(), 1);
    assert!(left[0].id.is_some());
    assert_eq!(left[0].name, name);
    let count = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT COUNT(*) AS n FROM tag_one WHERE name=$1",
            vec![name.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(count.try_get::<i64>("", "n").unwrap(), 1);
    assert!(batch::apply(&txn, &request).await.is_err());
    let rows = txn
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id,content,status,is_public,user_id FROM note WHERE id IN ($1,$2) ORDER BY id",
            vec![first.into(), second.into()],
        ))
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        let id: i32 = row.try_get("", "id").unwrap();
        assert_eq!(
            row.try_get::<String>("", "content").unwrap(),
            if id == first {
                "keep body"
            } else {
                "user edit"
            }
        );
        assert_eq!(row.try_get::<String>("", "status").unwrap(), "private");
        assert!(!row.try_get::<bool>("", "is_public").unwrap());
        assert_eq!(row.try_get::<Option<i32>>("", "user_id").unwrap(), None);
    }
    txn.rollback().await.unwrap();
}
