use super::*;
use crate::entity::{user, user_notification};
use sea_orm::{Database, DatabaseBackend, Statement};
use serde_json::json;

fn intent(value: serde_json::Value) -> Intent {
    serde_json::from_value(value).unwrap()
}

#[test]
fn announcement_changes_require_exact_target_and_nonempty_text() {
    for value in [
        json!({"action":"create","fields":{"title":"x"}}),
        json!({"action":"update","target":{"id":1}}),
        json!({"action":"delete","target":{"id":0,"title":"x"}}),
        json!({"action":"delete","target":{"id":1},"fields":{"content":"x"}}),
        json!({"action":"create","fields":{"title":"x","content":" "}}),
        json!({"action":"create","fields":{"title":"x".repeat(81),"content":"x"}}),
        json!({"action":"create","fields":{"title":"x","content":"x".repeat(2001)}}),
    ] {
        assert!(targets::validate(&intent(value)).is_err());
    }
    assert!(targets::validate(&intent(
        json!({"action":"update","target":{"id":1},"fields":{"content":" 保留原文 \n"}})
    ))
    .is_ok());
    assert!(
        serde_json::from_value::<Intent>(json!({"action":"delete","target":{"id":true}})).is_err()
    );
}

async fn execute<C: ConnectionTrait>(db: &C, request: Intent) -> Outcome {
    let prepared = targets::prepare(db, &request, false).await.unwrap();
    apply(
        db,
        &Change {
            version: prepared.version,
            intent: request,
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn postgres_announcement_changes_preserve_identity_and_rollback_fanout_failures() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .unwrap();
    let prefix = format!("annop_{}", uuid::Uuid::new_v4().simple());
    let create =
        intent(json!({"action":"create","fields":{"title":prefix,"content":" 原文\n保持 "}}));
    let frozen = targets::prepare(&txn, &create, false).await.unwrap();
    assert!(announcement::Entity::find()
        .filter(announcement::Column::Title.eq(prefix.clone()))
        .one(&txn)
        .await
        .unwrap()
        .is_none());
    let first = apply(
        &txn,
        &Change {
            version: frozen.version,
            intent: create.clone(),
        },
    )
    .await
    .unwrap();
    let aid = first.state.after.as_ref().unwrap().id.unwrap();
    assert!(targets::prepare(
        &txn,
        &intent(json!({"action":"delete",
        "target":{"id":aid,"title":"different"}})),
        false
    )
    .await
    .is_err());
    let copies = targets::notifications(&txn, aid).await.unwrap();
    assert_eq!(copies.len() as u64, first.state.notification_count);
    assert_eq!(copies.len(), targets::recipients(&txn).await.unwrap().len());
    let second = execute(&txn, create).await;
    let other_id = second.state.after.as_ref().unwrap().id.unwrap();
    assert_ne!(aid, other_id);
    assert!(targets::prepare(
        &txn,
        &intent(json!({"action":"delete","target":{"title":prefix}})),
        false
    )
    .await
    .is_err());
    let modify = intent(
        json!({"action":"update","target":{"id":aid,"title":prefix},"fields":{"title":format!("{prefix}_new"),"content":"修订正文"}}),
    );
    let frozen = targets::prepare(&txn, &modify, false).await.unwrap();
    // Read state changes do not invalidate approval or get reset during synchronization.
    if let Some((nid, _)) = copies.first() {
        user_notification::Entity::update_many()
            .col_expr(
                user_notification::Column::IsRead,
                sea_orm::sea_query::Expr::value(true),
            )
            .filter(user_notification::Column::Id.eq(*nid))
            .exec(&txn)
            .await
            .unwrap();
    }
    let updated = apply(
        &txn,
        &Change {
            version: frozen.version,
            intent: modify.clone(),
        },
    )
    .await
    .unwrap();
    assert!(updated.changed);
    for row in user_notification::Entity::find()
        .filter(user_notification::Column::AnnouncementId.eq(aid))
        .all(&txn)
        .await
        .unwrap()
    {
        assert_eq!(row.title, format!("{prefix}_new"));
        assert_eq!(row.content.as_deref(), Some("修订正文"));
        if copies.first().is_some_and(|(nid, _)| *nid == row.id) {
            assert!(row.is_read);
        }
    }
    assert!(!execute(&txn, modify).await.changed);
    for row in user_notification::Entity::find()
        .filter(user_notification::Column::AnnouncementId.eq(other_id))
        .all(&txn)
        .await
        .unwrap()
    {
        assert_eq!(row.title, prefix);
        assert_eq!(row.content.as_deref(), Some(" 原文\n保持 "));
    }
    let delete = intent(json!({"action":"delete","target":{"id":aid}}));
    let frozen = targets::prepare(&txn, &delete, false).await.unwrap();
    announcement::Entity::update_many()
        .col_expr(
            announcement::Column::Content,
            sea_orm::sea_query::Expr::value("changed without timestamp"),
        )
        .filter(announcement::Column::Id.eq(aid))
        .exec(&txn)
        .await
        .unwrap();
    assert!(apply(
        &txn,
        &Change {
            version: frozen.version,
            intent: delete.clone()
        }
    )
    .await
    .is_err());
    let deleted = execute(&txn, delete).await;
    assert!(deleted.changed && deleted.state.after.is_none());
    assert!(targets::notifications(&txn, aid).await.unwrap().is_empty());
    assert_eq!(
        targets::notifications(&txn, other_id).await.unwrap().len(),
        copies.len()
    );

    // A notification insert failure must also roll back its newly inserted announcement.
    let savepoint = txn.begin().await.unwrap();
    savepoint
        .execute(Statement::from_string(
            DatabaseBackend::Postgres,
            "CREATE TEMP TABLE announcement_failure_fixture_marker(id integer) ON COMMIT DROP"
                .to_owned(),
        ))
        .await
        .unwrap();
    savepoint.execute(Statement::from_string(DatabaseBackend::Postgres,
        "CREATE FUNCTION pg_temp.reject_owned_announcement_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title LIKE 'annop_%_fail' THEN RAISE EXCEPTION 'owned fixture failure'; END IF; RETURN NEW; END $$".to_owned())).await.unwrap();
    savepoint.execute(Statement::from_string(DatabaseBackend::Postgres,
        "CREATE TRIGGER reject_owned_announcement_notification BEFORE INSERT ON user_notification FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_owned_announcement_notification()".to_owned())).await.unwrap();
    // Ensure at least one recipient exists, using an isolated owned fixture if needed.
    if targets::recipients(&savepoint).await.unwrap().is_empty() {
        user::ActiveModel {
            username: Set(format!("{prefix}_user")),
            password: Set("fixture".to_owned()),
            ..Default::default()
        }
        .insert(&savepoint)
        .await
        .unwrap();
    }
    let fail = intent(
        json!({"action":"create","fields":{"title":format!("{prefix}_fail"),"content":"rollback"}}),
    );
    let frozen = targets::prepare(&savepoint, &fail, false).await.unwrap();
    assert!(apply(
        &savepoint,
        &Change {
            version: frozen.version,
            intent: fail
        }
    )
    .await
    .is_err());
    savepoint.rollback().await.unwrap();
    assert!(announcement::Entity::find()
        .filter(announcement::Column::Title.eq(format!("{prefix}_fail")))
        .one(&txn)
        .await
        .unwrap()
        .is_none());
    txn.rollback().await.unwrap();
    assert!(announcement::Entity::find_by_id(other_id)
        .one(&db)
        .await
        .unwrap()
        .is_none());
}
