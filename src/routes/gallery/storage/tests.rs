use super::*;
use sea_orm::MockDatabase;
#[test]
fn provider_paths_reject_traversal_and_unrecognized_providers() {
    for value in ["", "..", "a/../b", "/root/a", "a//b", "a\\b", "a\n"] {
        assert!(!key(value), "{value}");
    }
    assert!(key("gallery/中文.png"));
    assert!(serde_json::from_str::<Kind>("\"disk://elsewhere\"").is_err());
    let id = uuid::Uuid::new_v4();
    assert_eq!(public_id(&media_url(id)), Some(id));
    assert!(public_id("/api/public/media/72").is_none());
}
#[tokio::test]
async fn local_provider_reads_writes_deletes_without_r2_and_rejects_changed_scope() {
    // A private temporary root avoids process-global configuration or production media.
    let dir = std::env::temp_dir().join(format!("saudade-storage-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let store = LocalFileSystem::new_with_prefix(&dir)
        .unwrap()
        .with_fsync(true);
    let path = Path::from("fixture.png");
    let bytes = axum::body::Bytes::from_static(b"\x89PNG\r\n\x1a\nfixture");
    store.put(&path, bytes.clone().into()).await.unwrap();
    assert_eq!(
        store.get(&path).await.unwrap().bytes().await.unwrap(),
        bytes
    );
    store.delete(&path).await.unwrap();
    assert!(matches!(
        store.get(&path).await,
        Err(object_store::Error::NotFound { .. })
    ));
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    let forged = Location {
        storage: Kind::Local,
        scope: "/etc".into(),
        bucket: None,
        key: "passwd".into(),
    };
    assert!(super::store(&db, &forged).await.is_err());
    tokio::fs::remove_dir_all(dir).await.unwrap();
}
