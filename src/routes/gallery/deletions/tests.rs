use super::{target, worker};
use crate::routes::gallery::{self, references};
use sea_orm::{
    ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, Statement, TransactionTrait,
};

async fn database() -> Option<DatabaseConnection> {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        assert!(
            std::env::var_os("CI").is_none(),
            "CI requires explicit TEST_PG_URL"
        );
        return None;
    };
    assert!(url.starts_with("postgres://") || url.starts_with("postgresql://"));
    Some(Database::connect(url).await.unwrap())
}

fn sql(value: &str) -> Statement {
    Statement::from_string(DatabaseBackend::Postgres, value.to_owned())
}

#[test]
fn cleanup_targets_reject_paths_and_endpoint_credentials() {
    for bad in [
        "",
        ".",
        "..",
        "../image.png",
        "/image.png",
        "nested/image.png",
        "image.png/",
        "image.png/.",
        "a\\b",
        "x\n.png",
    ] {
        assert!(!target::safe_filename(bad), "{bad:?}");
    }
    assert!(target::safe_filename("image-图片.png"));
    for bad in [
        "https://user:secret@objects.invalid",
        "https://objects.invalid/?token=private",
        "https://objects.invalid/#secret",
        "file:///tmp/images",
    ] {
        assert!(target::endpoint(bad).is_none());
    }
    assert_eq!(
        target::endpoint("https://objects.invalid/"),
        Some("https://objects.invalid".into())
    );
    let cfg = crate::r2::R2Config {
        prefix: "gallery".into(),
        public_base: "https://images.invalid".into(),
        ..Default::default()
    };
    assert_eq!(
        target::r2_key("https://images.invalid/gallery/a.png", &cfg),
        Some("gallery/a.png".into())
    );
    for url in [
        "https://images.invalid/private/a.png",
        "https://images.invalid/gallery-other/a.png",
        "https://images.invalid/gallery/",
        "https://images.invalid/gallery/../private/a.png",
        "https://other.invalid/gallery/a.png",
    ] {
        assert!(target::r2_key(url, &cfg).is_none(), "{url}");
    }
}

#[tokio::test]
async fn postgres_cleanup_lease_recovers_and_stale_completion_cannot_win() {
    let Some(db) = database().await else {
        return;
    };
    let txn = db.begin().await.unwrap();
    // A connection-local table exercises the production lease SQL without claiming other test jobs.
    txn.execute(sql("CREATE TEMP TABLE image_deletion (LIKE public.image_deletion INCLUDING ALL) ON COMMIT DROP")).await.unwrap();
    txn.execute(sql("INSERT INTO image_deletion(image_id,image_url,decoded_url,requested_by,storage_kind,storage_scope,storage_key) VALUES (1,'/fixture.png','/fixture.png',1,'local','/fixture','fixture.png')")).await.unwrap();
    let first = worker::claim(&txn).await.unwrap().unwrap();
    assert_eq!(first.image_id, 1);
    assert_eq!(first.attempts, 1);
    assert!(worker::claim(&txn).await.unwrap().is_none());
    txn.execute(sql("UPDATE image_deletion SET next_attempt_at=CURRENT_TIMESTAMP-interval '1 second' WHERE image_id=1")).await.unwrap();
    let second = worker::claim(&txn).await.unwrap().unwrap();
    assert_eq!(second.attempts, 2);
    worker::finish(&txn, &first, Ok(())).await.unwrap();
    let row = txn
        .query_one(sql(
            "SELECT finished_at IS NULL AS pending FROM image_deletion WHERE image_id=1",
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(row.try_get::<bool>("", "pending").unwrap());
    worker::finish(&txn, &second, Err("storage_timeout"))
        .await
        .unwrap();
    let row = txn.query_one(sql("SELECT last_error,next_attempt_at>CURRENT_TIMESTAMP AS delayed FROM image_deletion WHERE image_id=1")).await.unwrap().unwrap();
    assert_eq!(
        row.try_get::<String>("", "last_error").unwrap(),
        "storage_timeout"
    );
    assert!(row.try_get::<bool>("", "delayed").unwrap());
    worker::finish(&txn, &second, Ok(())).await.unwrap();
    worker::finish(&txn, &second, Err("late_failure"))
        .await
        .unwrap();
    let row = txn.query_one(sql("SELECT finished_at IS NOT NULL AS finished,last_error FROM image_deletion WHERE image_id=1")).await.unwrap().unwrap();
    assert!(row.try_get::<bool>("", "finished").unwrap());
    assert!(row
        .try_get::<Option<String>>("", "last_error")
        .unwrap()
        .is_none());
    assert!(worker::claim(&txn).await.unwrap().is_none());
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn postgres_cleanup_local_file_is_idempotent_and_cannot_change_target() {
    let Some(db) = database().await else {
        return;
    };
    let root = target::local_root().await.unwrap();
    tokio::fs::create_dir_all(&root).await.unwrap();
    let key = format!("gallery_cleanup_{}.png", uuid::Uuid::new_v4().simple());
    let path = root.join(&key);
    tokio::fs::write(&path, b"synthetic image").await.unwrap();
    let mut job = worker::Job {
        image_id: 1,
        storage_kind: "local".into(),
        storage_scope: format!("{}-different", root.display()),
        storage_bucket: None,
        storage_key: key,
        attempts: 1,
    };
    assert_eq!(worker::remove(&db, &job).await, Err("target_changed"));
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"synthetic image");
    job.storage_scope = root.to_string_lossy().into_owned();
    worker::remove(&db, &job).await.unwrap();
    assert!(!path.exists());
    worker::remove(&db, &job).await.unwrap();
    job.storage_key = "../outside.png".into();
    assert_eq!(worker::remove(&db, &job).await, Err("unsafe_path"));
}

#[tokio::test]
async fn postgres_deleted_url_guard_includes_percent_aliases_and_completed_cleanup() {
    let Some(db) = database().await else {
        return;
    };
    let txn = db.begin().await.unwrap();
    txn.execute(sql("CREATE TEMP TABLE image_deletion (LIKE public.image_deletion INCLUDING ALL) ON COMMIT DROP")).await.unwrap();
    txn.execute(sql("INSERT INTO image_deletion(image_id,image_url,decoded_url,requested_by,storage_kind,storage_scope,storage_key,finished_at) VALUES (1,'https://images.invalid/%E7%8C%AB.png','https://images.invalid/猫.png',1,'local','/fixture','fixture.png',CURRENT_TIMESTAMP)")).await.unwrap();
    for text in [
        "![cat](https://images.invalid/%E7%8C%AB.png)",
        "![cat](https://images.invalid/猫.png)",
    ] {
        assert!(references::guard_texts(&txn, &[text]).await.is_err());
    }
    references::guard_texts(&txn, &["![other](https://images.invalid/other.png)"])
        .await
        .unwrap();
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn postgres_registration_preserves_names_and_refuses_retired_urls() {
    let Some(db) = database().await else {
        return;
    };
    let url = format!(
        "/api/protect/download/gallery_register_{}.png",
        uuid::Uuid::new_v4().simple()
    );
    let id = gallery::register_named_image(&db, &url, "原始文件名.png")
        .await
        .unwrap();
    assert_eq!(
        gallery::register_named_image(&db, &url, "不可覆盖.png")
            .await
            .unwrap(),
        id
    );
    assert_eq!(
        gallery::read(&db, 1, id)
            .await
            .unwrap()
            .display_name
            .as_deref(),
        Some("原始文件名.png")
    );
    db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres, "INSERT INTO image_deletion(image_id,image_url,decoded_url,requested_by,storage_kind,storage_scope,storage_key) VALUES($1,$2,$2,1,'local','/fixture','fixture.png')", [id.into(), url.clone().into()])).await.unwrap();
    assert!(gallery::register_image(&db, &url).await.is_err());
    assert!(gallery::read(&db, 1, id).await.is_err());
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "DELETE FROM image_deletion WHERE image_id=$1",
        [id.into()],
    ))
    .await
    .unwrap();
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "DELETE FROM images WHERE image_key=$1",
        [id.into()],
    ))
    .await
    .unwrap();
}

#[tokio::test]
async fn postgres_durable_article_and_avatar_references_are_deletion_blockers() {
    let Some(db) = database().await else {
        return;
    };
    let txn = db.begin().await.unwrap();
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let url = format!("https://images.invalid/{unique}/%E7%8C%AB.png");
    let image = gallery::Image {
        image_key: 1,
        image_url: url.clone(),
        ..Default::default()
    };
    let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES($1,$2,'draft',false,localtimestamp,localtimestamp) RETURNING id",
        [unique.clone().into(), format!("![cat](https://images.invalid/{unique}/猫.png)").into()])).await.unwrap().unwrap();
    let note: i32 = row.try_get("", "id").unwrap();
    let blocker = references::first_use(&txn, std::slice::from_ref(&image))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(blocker.resource, "article");
    assert_eq!(blocker.resource_id, note.to_string());
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "DELETE FROM note WHERE id=$1",
        [note.into()],
    ))
    .await
    .unwrap();
    txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,nickname,password,role,avatar) VALUES($1,$1,'fixture','admin',$2)", [unique.into(), url.into()])).await.unwrap();
    let blocker = references::first_use(&txn, std::slice::from_ref(&image))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(blocker.resource, "user_avatar");
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn postgres_delete_rollback_preserves_gallery_and_commit_queues_all_ids() {
    use crate::routes::gallery::actions::{self, Change, Intent};
    let Some(db) = database().await else {
        return;
    };
    let prefix = format!("gallery_delete_{}", uuid::Uuid::new_v4().simple());
    let mut ids = Vec::new();
    for index in 0..2 {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO images(image_url) VALUES($1) RETURNING image_key",
                [format!("/api/protect/download/{prefix}_{index}.png").into()],
            ))
            .await
            .unwrap()
            .unwrap();
        ids.push(row.try_get::<i32>("", "image_key").unwrap());
    }
    let prepared = actions::prepare_change(
        &db,
        1,
        Intent::Delete {
            image_ids: ids.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(prepared.matched_ids, ids);
    let transaction = db.begin().await.unwrap();
    references::fence(&transaction, true).await.unwrap();
    let images = vec![
        gallery::read(&transaction, 1, ids[0]).await.unwrap(),
        gallery::read(&transaction, 1, ids[1]).await.unwrap(),
    ];
    let targets = super::targets(&transaction, &images).await.unwrap();
    super::enqueue(&transaction, 1, &images, &targets)
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    for id in &ids {
        assert!(gallery::read(&db, 1, *id).await.is_ok());
    }
    let outcome = actions::execute_change(
        &db,
        1,
        Change {
            version: prepared.version,
            expires_at: prepared.expires_at,
            intent: prepared.intent,
        },
    )
    .await
    .unwrap();
    assert_eq!(outcome.changed_ids, ids);
    assert_eq!(outcome.cleanup_pending_ids, ids);
    for id in ids {
        assert!(gallery::read(&db, 1, id).await.is_err());
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM image_deletion WHERE image_id=$1",
            [id.into()],
        ))
        .await
        .unwrap();
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM images WHERE image_key=$1",
            [id.into()],
        ))
        .await
        .unwrap();
    }
}
