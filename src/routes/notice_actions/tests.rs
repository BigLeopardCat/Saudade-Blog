use super::*;
use crate::entity::{user, user_notification};
use sea_orm::{ActiveModelTrait, ColumnTrait, Database, QueryFilter, Set};
use serde_json::json;
fn intent(v: serde_json::Value) -> Intent {
    serde_json::from_value(v).unwrap()
}
#[test]
fn notice_requests_require_exact_target_and_complete_bounded_text() {
    for value in [
        json!({"target":{},"content":"x"}),
        json!({"target":{"id":1,"username":"x"},"content":"x"}),
        json!({"target":{"id":1},"content":" "}),
        json!({"target":{"id":1},"content":"x".repeat(1001)}),
        json!({"target":{"id":1},"title":"x".repeat(129),"content":"x"}),
        json!({"target":{"id":1},"content":"\0"}),
    ] {
        assert!(targets::validate(&intent(value)).is_err());
    }
    assert!(targets::validate(&intent(
        json!({"target":{"username":"精确账号"},"content":" 保留\n原文\t "})
    ))
    .is_ok());
    assert!(serde_json::from_value::<Intent>(json!({"target":{"id":true},"content":"x"})).is_err());
}
async fn fixture<C: ConnectionTrait>(db: &C, role: &str, prefix: &str) -> user::Model {
    user::ActiveModel {
        username: Set(prefix.to_owned()),
        password: Set("owned test fixture".to_owned()),
        role: Set(role.to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}
#[tokio::test]
async fn postgres_notice_targets_permissions_text_and_delivery_are_atomic() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await
        .unwrap();
    let prefix = format!("notice_{}", uuid::Uuid::new_v4().simple());
    let actor = fixture(&txn, crate::authz::ROLE_ADMIN, &format!("{prefix}_a")).await;
    let recipient = fixture(&txn, crate::authz::ROLE_USER, &format!("{prefix}_r")).await;
    let superadmin = fixture(&txn, crate::authz::ROLE_SUPERADMIN, &format!("{prefix}_s")).await;
    let request = intent(
        json!({"target":{"username":recipient.username},"content":" 原文\n保持😀\t ","title":null}),
    );
    let plan = targets::prepare(&txn, actor.id, &request, false)
        .await
        .unwrap();
    assert_eq!(plan.title, crate::routes::notice::DEFAULT_TITLE);
    assert!(user_notification::Entity::find()
        .filter(user_notification::Column::UserId.eq(recipient.id))
        .one(&txn)
        .await
        .unwrap()
        .is_none());
    let result = apply(
        &txn,
        actor.id,
        &Change {
            version: plan.version.clone(),
            intent: request.clone(),
        },
    )
    .await
    .unwrap();
    assert!(result.delivered && result.notification_id > 0);
    let saved = user_notification::Entity::find_by_id(result.notification_id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.content.as_deref(), Some(" 原文\n保持😀\t "));
    assert_eq!(saved.user_id, recipient.id);
    assert!(!saved.is_read);
    assert!(saved.link.is_none());
    let stale = targets::prepare(&txn, actor.id, &request, false)
        .await
        .unwrap();
    user::Entity::update_many()
        .col_expr(
            user::Column::ChatQuotaUsed,
            sea_orm::sea_query::Expr::value(3),
        )
        .filter(user::Column::Id.eq(recipient.id))
        .exec(&txn)
        .await
        .unwrap();
    assert_eq!(
        targets::prepare(&txn, actor.id, &request, false)
            .await
            .unwrap(),
        stale
    );
    user::Entity::update_many()
        .col_expr(user::Column::Role, sea_orm::sea_query::Expr::value("zako"))
        .filter(user::Column::Id.eq(recipient.id))
        .exec(&txn)
        .await
        .unwrap();
    assert!(apply(
        &txn,
        actor.id,
        &Change {
            version: stale.version,
            intent: request.clone()
        }
    )
    .await
    .is_err());
    assert!(targets::prepare(
        &txn,
        actor.id,
        &intent(json!({"target":{"id":superadmin.id},"content":"x"})),
        false
    )
    .await
    .is_err());
    assert!(targets::prepare(&txn, recipient.id, &request, false)
        .await
        .is_err());
    let plan = targets::prepare(&txn, actor.id, &request, false)
        .await
        .unwrap();
    user::Entity::update_many()
        .col_expr(
            user::Column::TokenVersion,
            sea_orm::sea_query::Expr::value(1),
        )
        .filter(user::Column::Id.eq(actor.id))
        .exec(&txn)
        .await
        .unwrap();
    assert!(apply(
        &txn,
        actor.id,
        &Change {
            version: plan.version,
            intent: request.clone()
        }
    )
    .await
    .is_err());
    user::Entity::update_many()
        .col_expr(user::Column::Status, sea_orm::sea_query::Expr::value(1_i16))
        .filter(user::Column::Id.eq(actor.id))
        .exec(&txn)
        .await
        .unwrap();
    assert!(targets::prepare(&txn, actor.id, &request, false)
        .await
        .is_err());
    txn.rollback().await.unwrap();
    assert!(
        user_notification::Entity::find_by_id(result.notification_id)
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
    assert!(user::Entity::find_by_id(actor.id)
        .one(&db)
        .await
        .unwrap()
        .is_none());
}
