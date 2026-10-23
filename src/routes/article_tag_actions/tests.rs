use super::*;
use sea_orm::{Database, DatabaseBackend, Statement};
use serde_json::json;

fn intent(value: serde_json::Value) -> Intent {
    serde_json::from_value(value).unwrap()
}

#[test]
fn tag_changes_require_distinct_names_and_explicit_replace() {
    for value in [
        json!({}),
        json!({"add":["x"],"replace":[]}),
        json!({"add":["x","x"]}),
        json!({"add":["x"],"remove":["x"]}),
        json!({"add":["  "]}),
        json!({"add":["x"],"level":3}),
        json!({"add":["x"],"color":"red"}),
        json!({"add":["x"],"level":1,"parent_tag":"parent"}),
    ] {
        assert!(intent(value).validate().is_err());
    }
    assert!(intent(json!({"replace":[]})).validate().is_ok());
    assert!(intent(json!({"add":["测试"]})).validate().is_ok());
    assert!(
        serde_json::from_value::<Intent>(json!({"add":["测试"],"article_content":"change"}))
            .is_err()
    );
}

#[tokio::test]
async fn postgres_atomic_tag_changes_preserve_identity_and_reject_stale() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .unwrap();
    let prefix = format!("tagop_{}", uuid::Uuid::new_v4().simple());
    let row=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES($1,'preserve content','private',false,localtimestamp,localtimestamp) RETURNING id",vec![prefix.clone().into()])).await.unwrap().unwrap();
    let id: i32 = row.try_get("", "id").unwrap();
    let shared = 1_900_000_000 + ((uuid::Uuid::new_v4().as_u128() % 10_000_000) as u32) as i32;
    let first = format!("{prefix}_a");
    let second = format!("{prefix}_b");
    let missing = format!("{prefix}_c");
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO tag_one(id,name) VALUES($1,$2)",
        vec![shared.into(), first.clone().into()],
    ))
    .await
    .unwrap();
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO tag_two(id,name,tag_one_id) VALUES($1,$2,$1)",
        vec![shared.into(), second.clone().into()],
    ))
    .await
    .unwrap();
    let wanted = intent(json!({"add":[first,second,missing]}));
    let prepared = targets::prepare(&txn, id, &wanted, false).await.unwrap();
    assert!(prepared.before.is_empty());
    assert_eq!(prepared.after.iter().filter(|t| t.id.is_none()).count(), 1);
    let request = Change {
        version: prepared.version,
        intent: wanted,
    };
    let outcome = apply(&txn, id, &request).await.unwrap();
    assert!(outcome.changed);
    assert_eq!(outcome.state.after.len(), 3);
    let rows = targets::current(&txn, id).await.unwrap();
    assert_eq!(rows[0].id, Some(shared));
    assert_eq!(rows[0].level, 1);
    assert_eq!(rows[1].id, Some(shared));
    assert_eq!(rows[1].level, 2);
    let public_refs = crate::routes::note_tags::load_note_tags(&txn, &[id]).await;
    assert_eq!(public_refs[&id][0].name, first);
    assert_eq!(public_refs[&id][1].name, second);
    assert_eq!(public_refs[&id][0].level, 1);
    assert_eq!(public_refs[&id][1].level, 2);
    crate::routes::note_tags::resync_tags_column(&txn, &[id])
        .await
        .unwrap();
    assert_eq!(targets::current(&txn, id).await.unwrap(), rows);
    let legacy_ids = rows.iter().map(|row| row.id.unwrap()).collect::<Vec<_>>();
    crate::routes::note_tags::replace_note_tags(
        &txn,
        id,
        crate::routes::note_tags::canonical_tags(&legacy_ids).as_deref(),
    )
    .await
    .unwrap();
    assert_eq!(targets::current(&txn, id).await.unwrap(), rows);
    let shadow=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,draft_of,created_at,updated_at) VALUES($1,'revision','draft',false,$2,localtimestamp,localtimestamp) RETURNING id",
        vec![format!("{prefix}_shadow").into(),id.into()])).await.unwrap().unwrap();
    let shadow: i32 = shadow.try_get("", "id").unwrap();
    crate::routes::note_tags::copy_note_tags(&txn, id, shadow)
        .await
        .unwrap();
    assert_eq!(targets::current(&txn, shadow).await.unwrap(), rows);
    assert!(apply(&txn, id, &request).await.is_err());
    let noop = targets::prepare(&txn, id, &request.intent, false)
        .await
        .unwrap();
    let noop = apply(
        &txn,
        id,
        &Change {
            version: noop.version,
            intent: request.intent,
        },
    )
    .await
    .unwrap();
    assert!(!noop.changed);
    let article = note::Entity::find_by_id(id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(article.content, "preserve content");
    assert_eq!(article.user_id, None);
    assert_eq!(article.status.as_deref(), Some("private"));
    assert!(!article.is_public);
    let remove = intent(json!({"remove":[second]}));
    let prepared = targets::prepare(&txn, id, &remove, false).await.unwrap();
    assert_eq!(prepared.after.len(), 2);
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET content='changed without timestamp' WHERE id=$1",
        vec![id.into()],
    ))
    .await
    .unwrap();
    assert!(apply(
        &txn,
        id,
        &Change {
            version: prepared.version,
            intent: remove
        }
    )
    .await
    .is_err());
    assert_eq!(targets::current(&txn, id).await.unwrap(), rows);
    let clear = intent(json!({"replace":[]}));
    let prepared = targets::prepare(&txn, id, &clear, false).await.unwrap();
    assert!(
        apply(
            &txn,
            id,
            &Change {
                version: prepared.version,
                intent: clear
            }
        )
        .await
        .unwrap()
        .changed
    );
    assert!(targets::current(&txn, id).await.unwrap().is_empty());
    txn.rollback().await.unwrap();
    assert!(note::Entity::find_by_id(id)
        .one(&db)
        .await
        .unwrap()
        .is_none());
    assert!(tag_one::Entity::find()
        .filter(tag_one::Column::Name.eq(missing))
        .one(&db)
        .await
        .unwrap()
        .is_none());
}
