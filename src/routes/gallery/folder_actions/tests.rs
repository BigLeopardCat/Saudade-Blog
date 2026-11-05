use super::*;
use sea_orm::Database;
use serde_json::json;
fn intent(value: serde_json::Value) -> Intent {
    serde_json::from_value(value).unwrap()
}
#[tokio::test]
async fn postgres_folder_creation_and_deletion_bind_parent_and_refuse_nonempty_directories() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let name = format!("folder_{}", uuid::Uuid::new_v4().simple());
    let create = intent(json!({"action":"create","name":name}));
    let prepared = plan(&txn, &create).await.unwrap();
    let root = apply(
        &txn,
        &Change {
            version: prepared.version,
            intent: create.clone(),
        },
    )
    .await
    .unwrap()
    .folder
    .unwrap();
    assert_eq!(root.parent_id, 0);
    assert!(plan(&txn, &create).await.is_err());
    let delete = intent(json!({"action":"delete","id":root.id}));
    let before = plan(&txn, &delete).await.unwrap();
    let child = folders::create_in(
        &txn,
        folders::Create {
            name: "child".into(),
            parent_id: root.id,
        },
    )
    .await
    .unwrap();
    assert!(apply(
        &txn,
        &Change {
            version: before.version,
            intent: delete.clone()
        }
    )
    .await
    .is_err());
    assert!(read(&txn, root.id).await.is_ok());
    let mut parent = child.id;
    for level in 3..=8 {
        parent = folders::create_in(
            &txn,
            folders::Create {
                name: format!("level{level}"),
                parent_id: parent,
            },
        )
        .await
        .unwrap()
        .id;
    }
    assert!(plan(
        &txn,
        &intent(json!({"action":"create","name":"too deep","parentId":parent}))
    )
    .await
    .is_err());
    assert!(
        plan(&txn, &intent(json!({"action":"delete","id":child.id})))
            .await
            .is_err()
    );
    let empty = folders::create_in(
        &txn,
        folders::Create {
            name: format!("empty_{name}"),
            parent_id: 0,
        },
    )
    .await
    .unwrap();
    let request = intent(json!({"action":"delete","id":empty.id}));
    let prepared = plan(&txn, &request).await.unwrap();
    let outcome = apply(
        &txn,
        &Change {
            version: prepared.version,
            intent: request,
        },
    )
    .await
    .unwrap();
    assert!(outcome.changed && outcome.folder.is_none());
    assert!(read(&txn, empty.id).await.is_err());
    txn.rollback().await.unwrap();
}
#[tokio::test]
async fn invalid_folder_plans_do_not_contact_database() {
    let db = sea_orm::MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    let txn = db.begin().await.unwrap();
    for value in [
        json!({"action":"create","name":"../x"}),
        json!({"action":"create","name":"x","id":1}),
        json!({"action":"delete","id":0}),
        json!({"action":"delete","id":1,"name":"x"}),
    ] {
        assert!(plan(&txn, &intent(value)).await.is_err());
    }
}
