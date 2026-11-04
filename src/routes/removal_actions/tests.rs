use super::*;
use crate::entity::{announcement, user_notification};
use sea_orm::{Database, DatabaseBackend, EntityTrait, Statement};
use serde_json::json;

#[test]
fn explicit_deletion_scopes_reject_ambiguous_and_unbounded_requests() {
    for value in [
        json!({"scope":"all","ids":[1]}),
        json!({"scope":"selected","ids":[]}),
        json!({"scope":"selected","ids":[1,1]}),
        json!({"scope":"selected","ids":[0]}),
        json!({"scope":"selected","ids":(1..=1001).collect::<Vec<_>>()}),
    ] {
        let request: Selection = serde_json::from_value(value).unwrap();
        assert!(validate(&request, Resource::Notifications).is_err());
    }
    assert!(serde_json::from_value::<Selection>(json!({"scope":"all","userId":99})).is_err());
    assert!(serde_json::from_value::<Selection>(json!({"scope":"all","kind":"unknown"})).is_err());
    assert!(serde_json::from_value::<Selection>(json!({"scope":"selected","ids":[true]})).is_err());
    let request: Selection =
        serde_json::from_value(json!({"scope":"all","kind":"notice"})).unwrap();
    assert!(validate(&request, Resource::Notifications).is_ok());
    assert!(validate(&request, Resource::Announcements).is_err());
}
async fn actor<C: ConnectionTrait>(db: &C, role: &str) -> i32 {
    let name = format!("remove_{}", uuid::Uuid::new_v4().simple());
    let row=db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,nickname,password,role) VALUES($1,$1,$2,$3) RETURNING id",
        vec![name.into(),uuid::Uuid::new_v4().to_string().into(),role.into()])).await.unwrap().unwrap();
    row.try_get("", "id").unwrap()
}
async fn notice<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    announcement_id: Option<i32>,
    title: &str,
) -> i32 {
    let kind = if announcement_id.is_some() {
        "announcement"
    } else {
        "notice"
    };
    db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO user_notification(user_id,announcement_id,type,title,content,is_read) VALUES($1,$2,$3,$4,'body',false) RETURNING id",
        vec![uid.into(),announcement_id.into(),kind.into(),title.into()])).await.unwrap().unwrap().try_get("","id").unwrap()
}
fn selection(ids: Vec<i32>) -> Selection {
    Selection {
        scope: Scope::Selected,
        ids,
        kind: Kind::All,
    }
}
fn change(plan: &Prepared) -> Change {
    Change {
        version: plan.version.clone(),
        ids: plan.ids.clone(),
        kind: Kind::All,
    }
}

#[tokio::test]
async fn postgres_personal_batch_is_frozen_owned_and_atomic() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let own = actor(&txn, "user").await;
    let peer = actor(&txn, "user").await;
    let a = notice(&txn, own, None, "first").await;
    let b = notice(&txn, own, None, "second").await;
    let foreign = notice(&txn, peer, None, "foreign").await;
    assert!(targets::snapshot(
        &txn,
        own,
        Resource::Notifications,
        &selection(vec![a, foreign]),
        false
    )
    .await
    .is_err());
    let request = Selection {
        scope: Scope::All,
        ids: vec![],
        kind: Kind::All,
    };
    let plan = targets::snapshot(&txn, own, Resource::Notifications, &request, false)
        .await
        .unwrap()
        .plan;
    assert_eq!(plan.ids, vec![a, b]);
    let arrival = notice(&txn, own, None, "new arrival").await;
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE user_notification SET is_read=true WHERE id=$1",
        vec![a.into()],
    ))
    .await
    .unwrap();
    let outcome = apply(&txn, own, Resource::Notifications, &change(&plan))
        .await
        .unwrap();
    assert_eq!(outcome.deleted_ids, vec![a, b]);
    for id in [a, b] {
        assert!(user_notification::Entity::find_by_id(id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap()
            .deleted_at
            .is_some());
    }
    for id in [foreign, arrival] {
        assert!(user_notification::Entity::find_by_id(id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap()
            .deleted_at
            .is_none());
    }
    assert!(apply(&txn, peer, Resource::Notifications, &change(&plan))
        .await
        .is_err());
    assert!(apply(&txn, own, Resource::Notifications, &change(&plan))
        .await
        .is_err());
    let c = notice(&txn, own, None, "third").await;
    let plan = targets::snapshot(
        &txn,
        own,
        Resource::Notifications,
        &selection(vec![arrival, c]),
        false,
    )
    .await
    .unwrap()
    .plan;
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE user_notification SET content='changed' WHERE id=$1",
        vec![c.into()],
    ))
    .await
    .unwrap();
    assert!(apply(&txn, own, Resource::Notifications, &change(&plan))
        .await
        .is_err());
    assert!(user_notification::Entity::find_by_id(arrival)
        .one(&txn)
        .await
        .unwrap()
        .unwrap()
        .deleted_at
        .is_none());
    let bulk = actor(&txn, "user").await;
    txn.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO user_notification(user_id,type,title,content,is_read) SELECT $1,'notice',g::text,'bulk',false FROM generate_series(1,125) g",
        vec![bulk.into()])).await.unwrap();
    let bulk_plan = targets::snapshot(&txn, bulk, Resource::Notifications, &request, false)
        .await
        .unwrap()
        .plan;
    assert_eq!(bulk_plan.count, 125);
    assert_eq!(bulk_plan.items.len(), 20);
    assert_eq!(
        apply(&txn, bulk, Resource::Notifications, &change(&bulk_plan))
            .await
            .unwrap()
            .deleted_ids
            .len(),
        125
    );
    txn.rollback().await.unwrap();
}
#[tokio::test]
async fn postgres_global_announcement_batch_preserves_new_sources_and_checks_fanout() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let admin = actor(&txn, "admin").await;
    let recipient = actor(&txn, "user").await;
    let mut ids = vec![];
    for title in ["first", "second", "later"] {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO announcement(title,content) VALUES($1,'body') RETURNING id",
                vec![title.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        ids.push(row.try_get::<i32>("", "id").unwrap());
    }
    let copy = notice(&txn, recipient, Some(ids[0]), "copy").await;
    let request = selection(ids[..2].to_vec());
    assert!(
        targets::snapshot(&txn, recipient, Resource::Announcements, &request, false)
            .await
            .is_err()
    );
    let plan = targets::snapshot(&txn, admin, Resource::Announcements, &request, false)
        .await
        .unwrap()
        .plan;
    assert_eq!(plan.associated_notifications, 1);
    let own_plan = targets::snapshot(
        &txn,
        recipient,
        Resource::Notifications,
        &selection(vec![copy]),
        false,
    )
    .await
    .unwrap()
    .plan;
    apply(&txn, recipient, Resource::Notifications, &change(&own_plan))
        .await
        .unwrap();
    assert!(announcement::Entity::find_by_id(ids[0])
        .one(&txn)
        .await
        .unwrap()
        .is_some());
    // Hiding a personal copy does not revoke an administrator's fixed global deletion.
    let outcome = apply(&txn, admin, Resource::Announcements, &change(&plan))
        .await
        .unwrap();
    assert_eq!(outcome.deleted_ids, ids[..2]);
    assert!(user_notification::Entity::find_by_id(copy)
        .one(&txn)
        .await
        .unwrap()
        .is_none());
    assert!(announcement::Entity::find_by_id(ids[2])
        .one(&txn)
        .await
        .unwrap()
        .is_some());
    txn.rollback().await.unwrap();
}
