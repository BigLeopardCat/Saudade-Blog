use super::*;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, QueryFilter, Statement};
use serde_json::json;

fn intent(value: serde_json::Value) -> Intent {
    serde_json::from_value(value).unwrap()
}

#[test]
fn category_mutations_require_exact_targets_and_bounded_fields() {
    for value in [
        json!({"action":"create"}),
        json!({"action":"delete"}),
        json!({"action":"update","target":{"id":1}}),
        json!({"action":"delete","target":{"id":0,"name":"x"}}),
        json!({"action":"delete","target":{"id":1},"fields":{"name":"x"}}),
        json!({"action":"create","fields":{"name":" "}}),
        json!({"action":"create","fields":{"name":"x","pathName":"../x"}}),
        json!({"action":"create","fields":{"name":"x","color":"red"}}),
        json!({"action":"create","fields":{"name":"x","introduce":"x".repeat(256)}}),
    ] {
        assert!(targets::validate(&intent(value)).is_err());
    }
    assert!(
        targets::validate(&intent(json!({"action":"update","target":{"name":"测试"},
        "fields":{"introduce":"","icon":"","color":""}})))
        .is_ok()
    );
    assert!(
        serde_json::from_value::<Intent>(json!({"action":"create","fields":{"name":"x"},
        "article_content":"forbidden"}))
        .is_err()
    );
}

#[tokio::test]
async fn postgres_category_changes_are_atomic_and_preserve_articles() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .unwrap();
    let prefix = format!("catop_{}", uuid::Uuid::new_v4().simple());
    let create = intent(
        json!({"action":"create","fields":{"name":prefix,"introduce":"intro","icon":"icon","color":"#123456"}}),
    );
    let prepared = targets::prepare(&txn, &create, false).await.unwrap();
    assert!(prepared.before.is_none() && prepared.after.as_ref().unwrap().id.is_none());
    assert!(category::Entity::find()
        .filter(sea_orm::ColumnTrait::eq(
            &category::Column::Name,
            prefix.clone()
        ))
        .one(&txn)
        .await
        .unwrap()
        .is_none());
    let created = apply(
        &txn,
        &Change {
            version: prepared.version,
            intent: create,
        },
    )
    .await
    .unwrap();
    let cid = created.state.after.as_ref().unwrap().id.unwrap();
    assert!(targets::prepare(
        &txn,
        &intent(json!({"action":"delete",
        "target":{"id":cid,"name":"different"}})),
        false
    )
    .await
    .is_err());
    assert_eq!(
        created.state.after.as_ref().unwrap().path_name.as_deref(),
        Some(prefix.as_str())
    );
    assert!(created.changed);
    // Uniqueness also applies to legacy SQL writers, not just the new endpoint.
    let duplicate = txn.begin().await.unwrap();
    assert!(duplicate
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO category(name) VALUES($1)",
            vec![prefix.clone().into()]
        ))
        .await
        .is_err());
    duplicate.rollback().await.unwrap();
    let duplicate = txn.begin().await.unwrap();
    assert!(duplicate
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO category(name,path_name) VALUES($1,$2)",
            vec![format!("{prefix}_other").into(), prefix.clone().into()]
        ))
        .await
        .is_err());
    duplicate.rollback().await.unwrap();
    let row=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,category_id,status,is_public,created_at,updated_at) VALUES($1,'keep content',$2,'private',false,localtimestamp,localtimestamp) RETURNING id",
        vec![prefix.clone().into(),cid.into()])).await.unwrap().unwrap();
    let nid: i32 = row.try_get("", "id").unwrap();
    let row=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,category_id,status,is_public,draft_of,created_at,updated_at) VALUES($1,'keep revision',$2,'draft',false,$3,localtimestamp,localtimestamp) RETURNING id",
        vec![prefix.clone().into(),cid.into(),nid.into()])).await.unwrap().unwrap();
    let revision: i32 = row.try_get("", "id").unwrap();
    let modify = intent(
        json!({"action":"update","target":{"id":cid,"name":prefix},"fields":{"introduce":"","icon":"","color":""}}),
    );
    let prepared = targets::prepare(&txn, &modify, false).await.unwrap();
    assert_eq!((prepared.article_count, prepared.revision_count), (1, 1));
    let updated = apply(
        &txn,
        &Change {
            version: prepared.version,
            intent: modify.clone(),
        },
    )
    .await
    .unwrap();
    assert!(updated.changed);
    let row = category::Entity::find_by_id(cid)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.introduce.as_deref(), Some(""));
    assert_eq!(row.icon.as_deref(), Some(""));
    assert_eq!(row.color.as_deref(), Some(""));
    let noop = targets::prepare(&txn, &modify, false).await.unwrap();
    assert!(
        !apply(
            &txn,
            &Change {
                version: noop.version,
                intent: modify
            }
        )
        .await
        .unwrap()
        .changed
    );
    let delete = intent(json!({"action":"delete","target":{"id":cid}}));
    let frozen = targets::prepare(&txn, &delete, false).await.unwrap();
    // The same reference count with a different record is still a stale scope.
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET category_id=NULL WHERE id=$1",
        vec![nid.into()],
    ))
    .await
    .unwrap();
    txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,category_id,status,is_public,created_at,updated_at) VALUES($1,'other',$2,'private',false,localtimestamp,localtimestamp)",
        vec![format!("{prefix}_another").into(),cid.into()])).await.unwrap();
    assert!(apply(
        &txn,
        &Change {
            version: frozen.version,
            intent: delete.clone()
        }
    )
    .await
    .is_err());
    assert!(category::Entity::find_by_id(cid)
        .one(&txn)
        .await
        .unwrap()
        .is_some());
    let frozen = targets::prepare(&txn, &delete, false).await.unwrap();
    let deleted = apply(
        &txn,
        &Change {
            version: frozen.version,
            intent: delete,
        },
    )
    .await
    .unwrap();
    assert!(deleted.changed && deleted.state.after.is_none());
    for (id, content) in [(nid, "keep content"), (revision, "keep revision")] {
        let article = crate::entity::note::Entity::find_by_id(id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(article.category_id.is_none());
        assert_eq!(article.content, content);
        assert!(!article.is_public);
        assert!(article.user_id.is_none());
    }
    assert_eq!(
        crate::entity::note::Entity::find_by_id(revision)
            .one(&txn)
            .await
            .unwrap()
            .unwrap()
            .draft_of,
        Some(nid)
    );
    txn.rollback().await.unwrap();
    assert!(category::Entity::find_by_id(cid)
        .one(&db)
        .await
        .unwrap()
        .is_none());
    assert!(crate::entity::note::Entity::find_by_id(nid)
        .one(&db)
        .await
        .unwrap()
        .is_none());
}
