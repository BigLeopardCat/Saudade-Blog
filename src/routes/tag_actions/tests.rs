use super::*;
use crate::routes::note_tags;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, EntityTrait, Statement};
use serde_json::json;
fn intent(v: serde_json::Value) -> Intent {
    serde_json::from_value(v).unwrap()
}
#[test]
fn requests_require_typed_identity_and_explicit_fields() {
    for value in [
        json!({"action":"create"}),
        json!({"action":"delete","target":{"id":1}}),
        json!({"action":"update","target":{"id":1,"level":1}}),
        json!({"action":"delete","target":{"id":1,"level":1,"name":"x"}}),
        json!({"action":"create","fields":{"name":"x","color":"red"}}),
        json!({"action":"update","target":{"name":"x"},"fields":{"level":3}}),
    ] {
        assert!(targets::validate(&intent(value)).is_err());
    }
    assert!(targets::validate(&intent(json!({"action":"update","target":{"id":1,"level":2},"fields":{"parent":{"id":1,"level":1}}}))).is_ok());
}
async fn prepare_apply<C: ConnectionTrait>(db: &C, i: Intent) -> Outcome {
    let plan = targets::snapshot(db, &i, false).await.unwrap().plan;
    apply(
        db,
        &Change {
            version: plan.version,
            intent: i,
        },
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn postgres_tag_dictionary_changes_preserve_typed_references() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .unwrap();
    let prefix = format!("tagop_{}", uuid::Uuid::new_v4().simple());
    let created = prepare_apply(
        &txn,
        intent(json!({"action":"create","fields":{"name":prefix}})),
    )
    .await;
    let source = created.state.after.unwrap().id.unwrap();
    let parent=prepare_apply(&txn,intent(json!({"action":"create","fields":{"name":format!("p_{}",uuid::Uuid::new_v4().simple())}}))).await.state.after.unwrap().id.unwrap();
    let nid:i32=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES($1,'retain me','private',false,localtimestamp,localtimestamp) RETURNING id",vec![prefix.clone().into()])).await.unwrap().unwrap().try_get("","id").unwrap();
    note_tags::replace_typed_note_tags(&txn, nid, &[(1, source), (1, parent)])
        .await
        .unwrap();
    let move_intent = intent(
        json!({"action":"update","target":{"id":source,"level":1},"fields":{"parent":{"id":parent,"level":1},"color":"#abcdef"}}),
    );
    let stale = targets::snapshot(&txn, &move_intent, false)
        .await
        .unwrap()
        .plan;
    note_tags::replace_typed_note_tags(&txn, nid, &[(1, parent), (1, source)])
        .await
        .unwrap();
    assert!(apply(
        &txn,
        &Change {
            version: stale.version,
            intent: move_intent.clone()
        }
    )
    .await
    .is_err());
    let moved = prepare_apply(&txn, move_intent).await;
    assert_eq!(moved.state.article_count, 1);
    let child = moved.state.after.unwrap().id.unwrap();
    let refs = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT tag_one_id,tag_two_id FROM note_tag WHERE note_id=$1 AND seq=1",
            vec![nid.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(refs.try_get::<Option<i32>>("", "tag_one_id").unwrap(), None);
    assert_eq!(
        refs.try_get::<Option<i32>>("", "tag_two_id").unwrap(),
        Some(child)
    );
    let upgraded=prepare_apply(&txn,intent(json!({"action":"update","target":{"id":child,"level":2},"fields":{"level":1,"color":""}}))).await;
    let source = upgraded.state.after.unwrap().id.unwrap();
    let refs = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT tag_one_id,tag_two_id FROM note_tag WHERE note_id=$1 AND seq=1",
            vec![nid.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        refs.try_get::<Option<i32>>("", "tag_one_id").unwrap(),
        Some(source)
    );
    assert_eq!(refs.try_get::<Option<i32>>("", "tag_two_id").unwrap(), None);
    let nested=prepare_apply(&txn,intent(json!({"action":"create","fields":{"name":format!("c_{}",uuid::Uuid::new_v4().simple()),"parent":{"id":source,"level":1}}}))).await.state.after.unwrap().id.unwrap();
    note_tags::replace_typed_note_tags(&txn, nid, &[(1, source), (2, nested), (1, parent)])
        .await
        .unwrap();
    let deletion = intent(json!({"action":"delete","target":{"id":source,"level":1}}));
    let plan = targets::snapshot(&txn, &deletion, false)
        .await
        .unwrap()
        .plan;
    assert_eq!((plan.child_count, plan.article_count), (1, 1));
    let deleted = apply(
        &txn,
        &Change {
            version: plan.version,
            intent: deletion,
        },
    )
    .await
    .unwrap();
    assert!(deleted.changed);
    let note = crate::entity::note::Entity::find_by_id(nid)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(note.content, "retain me");
    assert_eq!(note.tags.as_deref(), Some(parent.to_string().as_str()));
    txn.rollback().await.unwrap();
    assert!(crate::entity::tag_one::Entity::find_by_id(parent)
        .one(&db)
        .await
        .unwrap()
        .is_none());
}
