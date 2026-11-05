use super::*;
use crate::entity::{announcement, user_notification};
use sea_orm::{ColumnTrait, Database, EntityTrait, PaginatorTrait, QueryFilter};

#[test]
fn publications_cannot_select_an_owner_or_escape_content_contract() {
    assert!(serde_json::from_value::<Publication>(
        serde_json::json!({"runId":"r","title":"标题","content":"正文","ownerId":8})
    )
    .is_err());
    for (run, title, content) in [
        ("../r", "title", "body"),
        ("run", " ", "body"),
        ("run", "title", ""),
        ("run", "x\n", "body"),
    ] {
        assert!(validate(&Publication {
            run_id: run.into(),
            title: title.into(),
            content: content.into()
        })
        .is_err());
    }
    assert!(validate(&Publication {
        run_id: "run".into(),
        title: "t".repeat(81),
        content: "body".into()
    })
    .is_err());
    assert!(validate(&Publication {
        run_id: "run".into(),
        title: "title".into(),
        content: "b".repeat(2001)
    })
    .is_err());
}

#[tokio::test]
async fn postgres_publication_is_atomic_owner_bound_and_not_recreated_after_deletion() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let row=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,password,role) VALUES ($1,'fixture','admin') RETURNING id",
        [format!("scheduled_{prefix}").into()])).await.unwrap().unwrap();
    let owner: i32 = row.try_get("", "id").unwrap();
    let publication = Publication {
        run_id: prefix.clone(),
        title: format!("计划_{prefix}"),
        content: " 审批原文\n😀 ".into(),
    };
    let first = apply(&txn, owner, &publication)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    let replay = apply(&txn, owner, &publication)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    assert!(!first.replayed && replay.replayed);
    assert_eq!(first.announcement_id, replay.announcement_id);
    assert_eq!(first.payload_hash, replay.payload_hash);
    let id = first.announcement_id.unwrap();
    let row = announcement::Entity::find_by_id(id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.content, publication.content);
    assert_eq!(row.title, publication.title);
    assert_eq!(
        user_notification::Entity::find()
            .filter(user_notification::Column::AnnouncementId.eq(id))
            .count(&txn)
            .await
            .unwrap() as i64,
        first.notification_count
    );
    let mut changed = publication.clone();
    changed.content = "changed".into();
    assert_eq!(
        apply(&txn, owner, &changed).await.unwrap_err().0,
        StatusCode::CONFLICT
    );
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET role='user' WHERE id=$1",
        [owner.into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        apply(&txn, owner, &publication).await.unwrap_err().0,
        StatusCode::FORBIDDEN
    );
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET role='admin',status=1 WHERE id=$1",
        [owner.into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        apply(&txn, owner, &publication).await.unwrap_err().0,
        StatusCode::FORBIDDEN
    );
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET status=0 WHERE id=$1",
        [owner.into()],
    ))
    .await
    .unwrap();
    announcement::Entity::delete_by_id(id)
        .exec(&txn)
        .await
        .unwrap();
    let removed = apply(&txn, owner, &publication)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1 .0.message));
    assert!(removed.replayed && removed.announcement_id.is_none());
    assert_eq!(
        announcement::Entity::find()
            .filter(announcement::Column::Title.eq(publication.title.clone()))
            .count(&txn)
            .await
            .unwrap(),
        0
    );
    // Failure in fanout must roll back the publication and the idempotency claim together.
    let savepoint = txn.begin().await.unwrap();
    savepoint.execute(Statement::from_string(DatabaseBackend::Postgres,
        "CREATE FUNCTION pg_temp.fail_scheduled_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$".to_string())).await.unwrap();
    savepoint.execute(Statement::from_string(DatabaseBackend::Postgres,
        "CREATE TRIGGER scheduled_notice_failure BEFORE INSERT ON user_notification FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_scheduled_notice()".to_string())).await.unwrap();
    let mut failed = publication.clone();
    failed.run_id = format!("{prefix}_failed");
    assert!(apply(&savepoint, owner, &failed).await.is_err());
    savepoint.rollback().await.unwrap();
    let claim=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT count(*) AS n FROM automation_announcement_delivery WHERE owner_id=$1 AND run_id=$2",
        [owner.into(),failed.run_id.into()])).await.unwrap().unwrap();
    assert_eq!(claim.try_get::<i64>("", "n").unwrap(), 0);
    txn.rollback().await.unwrap();
}
