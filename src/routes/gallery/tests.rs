use super::*;
use sea_orm::{Database, MockDatabase, TransactionTrait};

#[tokio::test]
async fn paging_limits_and_invalid_folders_fail_before_querying() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    assert!(page(
        &db,
        7,
        ListQuery {
            limit: Some(101),
            ..Default::default()
        }
    )
    .await
    .is_err());
    assert!(page(
        &db,
        7,
        ListQuery {
            folder_id: Some(-1),
            ..Default::default()
        }
    )
    .await
    .is_err());
    for name in ["", "..", "a/b"] {
        assert!(folders::create_in(
            &db,
            folders::Create {
                name: name.into(),
                parent_id: 0
            }
        )
        .await
        .is_err());
    }
}

#[test]
fn metadata_and_cover_changes_reject_unknown_or_unbounded_fields() {
    assert!(
        serde_json::from_value::<metadata::Change>(serde_json::json!({
        "version":"a".repeat(64),"imageUrl":"https://elsewhere.invalid/a.png"}))
        .is_err()
    );
    assert!(serde_json::from_value::<covers::Change>(serde_json::json!({
        "version":"a".repeat(64),"imageId":1,"imageVersion":"b".repeat(64),"fit":"unsafe"}))
    .is_err());
    assert!(!valid_version("short"));
}

#[tokio::test]
async fn postgres_gallery_metadata_folders_favorites_versions_and_cover_integrity() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let prefix = format!("gallery_{}", uuid::Uuid::new_v4().simple());
    let user=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,nickname,password,role,status) VALUES($1,$1,'test','admin',0) RETURNING id",
        vec![prefix.clone().into()])).await.unwrap().unwrap();
    let uid: i32 = user.try_get("", "id").unwrap();
    let folder = folders::create_in(
        &txn,
        folders::Create {
            name: prefix.clone(),
            parent_id: 0,
        },
    )
    .await
    .unwrap();
    let child = folders::create_in(
        &txn,
        folders::Create {
            name: "child".into(),
            parent_id: folder.id,
        },
    )
    .await
    .unwrap();
    let mut ids = Vec::new();
    for suffix in ["a.png", "b.png"] {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO images(image_url) VALUES($1) RETURNING image_key",
                vec![format!("/api/protect/download/{prefix}_{suffix}").into()],
            ))
            .await
            .unwrap()
            .unwrap();
        ids.push(row.try_get::<i32>("", "image_key").unwrap());
    }
    let first = page(
        &txn,
        uid,
        ListQuery {
            limit: Some(1),
            search: Some(prefix.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.items[0].image_key, ids[1]);
    assert_eq!(first.next_cursor, Some(ids[1]));
    let second = page(
        &txn,
        uid,
        ListQuery {
            limit: Some(1),
            search: Some(prefix.clone()),
            before: first.next_cursor,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(second.items[0].image_key, ids[0]);
    assert!(second.next_cursor.is_none());
    let image = read(&txn, uid, ids[0]).await.unwrap();
    let original_url = image.image_url.clone();
    let saved = metadata::apply(
        &txn,
        uid,
        ids[0],
        metadata::Change {
            version: image.version.clone(),
            display_name: Some("Cover image".into()),
            description: Some("Pastel landscape".into()),
            folder_id: Some(child.id),
            is_favorite: Some(true),
        },
    )
    .await
    .unwrap();
    assert!(saved.changed);
    assert_eq!(saved.state.image_url, original_url);
    assert_eq!(saved.state.folder_id, child.id);
    assert!(saved.state.is_favorite);
    assert!(!read(&txn, uid + 100000, ids[0]).await.unwrap().is_favorite);
    assert!(metadata::apply(
        &txn,
        uid,
        ids[0],
        metadata::Change {
            version: image.version,
            display_name: Some("stale".into()),
            description: None,
            folder_id: None,
            is_favorite: None
        }
    )
    .await
    .is_err());
    let filtered = page(
        &txn,
        uid,
        ListQuery {
            search: Some("Pastel".into()),
            folder_id: Some(child.id),
            favorite: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(filtered.items.len(), 1);
    assert_eq!(filtered.items[0].image_key, ids[0]);
    let root = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO note(title,content,status,is_public,created_at,updated_at) \
         VALUES($1,'published body','public',true,localtimestamp,localtimestamp) RETURNING id",
            vec![prefix.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i32>("", "id")
        .unwrap();
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,draft_of,created_at,updated_at) \
         VALUES('working copy','unsaved body','draft',false,$1,localtimestamp,localtimestamp)",
        vec![root.into()],
    ))
    .await
    .unwrap();
    let target = covers::read_target(&txn, root).await.unwrap();
    let cover = covers::apply(
        &txn,
        uid,
        root,
        covers::Change {
            version: target.version.clone(),
            image_id: ids[0],
            image_version: saved.state.version,
            fit: crate::routes::notes::CoverFit::Contain,
        },
    )
    .await
    .unwrap();
    assert!(cover.changed);
    assert_eq!(
        cover.state.cover_url.as_deref(),
        Some(original_url.as_str())
    );
    assert_eq!(cover.state.fit.as_deref(), Some("contain"));
    assert!(covers::apply(
        &txn,
        uid,
        root,
        covers::Change {
            version: target.version,
            image_id: ids[0],
            image_version: read(&txn, uid, ids[0]).await.unwrap().version,
            fit: crate::routes::notes::CoverFit::Cover
        }
    )
    .await
    .is_err());
    let rows=txn.query_all(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT content,status,is_public,cover FROM note WHERE id=$1 OR draft_of=$1 ORDER BY id",vec![root.into()])).await.unwrap();
    assert_eq!(
        rows[0].try_get::<String>("", "content").unwrap(),
        "published body"
    );
    assert_eq!(
        rows[1].try_get::<String>("", "content").unwrap(),
        "unsaved body"
    );
    assert_eq!(
        rows[1].try_get::<String>("", "cover").unwrap(),
        original_url
    );
    assert!(rows[0].try_get::<bool>("", "is_public").unwrap());
    assert!(!rows[1].try_get::<bool>("", "is_public").unwrap());
    txn.rollback().await.unwrap();
}
