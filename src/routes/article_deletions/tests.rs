use super::*;
use sea_orm::Database;
#[test]
fn deletion_selection_requires_bounded_distinct_positive_ids() {
    for values in [vec![], vec![1, 1], vec![0], (1..=51).collect::<Vec<_>>()] {
        assert!(ids(&values).is_err());
    }
    assert_eq!(ids(&[2, 1]).unwrap(), vec![1, 2]);
}
async fn count(db: &DatabaseTransaction, table: &str, key: &str, id: i32) -> i64 {
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!("SELECT count(*) AS n FROM {table} WHERE {key}=$1"),
        [id.into()],
    ))
    .await
    .unwrap()
    .unwrap()
    .try_get("", "n")
    .unwrap()
}
#[tokio::test]
async fn postgres_deletion_checks_every_version_and_cascades_with_atomic_rollback() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let name = format!("delete_{}", uuid::Uuid::new_v4().simple());
    let uid:i32=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",[name.clone().into()]))
        .await.unwrap().unwrap().try_get("","id").unwrap();
    let mut roots = Vec::new();
    for suffix in ["a", "b"] {
        let id:i32=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES($1,'body','public',true,localtimestamp,localtimestamp) RETURNING id",
            [format!("{name}_{suffix}").into()])).await.unwrap().unwrap().try_get("","id").unwrap();
        roots.push(id);
    }
    let root = roots[0];
    let draft:i32=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,draft_of,created_at,updated_at) VALUES('draft','body','draft',false,$1,localtimestamp,localtimestamp) RETURNING id",
        [root.into()])).await.unwrap().unwrap().try_get("","id").unwrap();
    let comment:i32=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note_comment(note_id,user_id,content) VALUES($1,$2,'comment') RETURNING id",[root.into(),uid.into()]))
        .await.unwrap().unwrap().try_get("","id").unwrap();
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO note_comment_vote(comment_id,visitor_key,value) VALUES($1,'fixture',1)",
        [comment.into()],
    ))
    .await
    .unwrap();
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO user_favorite(user_id,note_id) VALUES($1,$2)",
        [uid.into(), root.into()],
    ))
    .await
    .unwrap();
    let prepared = targets(&txn, &roots).await.unwrap();
    let change = Change {
        items: prepared
            .iter()
            .map(|v| Item {
                id: v.id,
                version: v.version.clone(),
            })
            .collect(),
    };
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET content='edited' WHERE id=$1",
        [draft.into()],
    ))
    .await
    .unwrap();
    assert!(apply(&txn, &change).await.is_err());
    assert_eq!(count(&txn, "note", "id", root).await, 1);
    let prepared = targets(&txn, &roots).await.unwrap();
    let change = Change {
        items: prepared
            .iter()
            .map(|v| Item {
                id: v.id,
                version: v.version.clone(),
            })
            .collect(),
    };
    let attempt = txn.begin().await.unwrap();
    let outcome = apply(&attempt, &change).await.unwrap();
    assert!(outcome.deleted && outcome.items.len() == 2);
    assert_eq!(count(&attempt, "note", "id", root).await, 0);
    assert_eq!(count(&attempt, "note", "id", draft).await, 0);
    assert_eq!(count(&attempt, "note_comment", "id", comment).await, 0);
    assert_eq!(
        count(&attempt, "note_comment_vote", "comment_id", comment).await,
        0
    );
    assert_eq!(count(&attempt, "user_favorite", "note_id", root).await, 0);
    attempt.rollback().await.unwrap();
    assert_eq!(count(&txn, "note", "id", draft).await, 1);
    assert_eq!(
        count(&txn, "note_comment_vote", "comment_id", comment).await,
        1
    );
    assert!(targets(&txn, &[draft]).await.is_err());
    txn.rollback().await.unwrap();
}
#[tokio::test]
async fn postgres_rejects_new_orphan_comments() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let result = txn
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO note_comment(note_id,user_id,content) VALUES($1,1,'invalid reference')",
            [i32::MAX.into()],
        ))
        .await;
    assert!(result.is_err());
    txn.rollback().await.unwrap();
}
