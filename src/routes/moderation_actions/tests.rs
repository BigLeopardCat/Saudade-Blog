use super::*;
use crate::entity::{note_comment, talk, user_notification};
use sea_orm::{
    ColumnTrait, ConnectionTrait, Database, DatabaseBackend, EntityTrait, PaginatorTrait,
    QueryFilter, Set, Statement, TransactionTrait,
};

#[test]
fn change_schema_rejects_unknown_direction_and_arguments() {
    assert!(serde_json::from_str::<Change>(r#"{"action":"approve","version":"x"}"#).is_err());
    assert!(serde_json::from_str::<Change>(r#"{"action":"pass","version":"x","uid":3}"#).is_err());
}

async fn account(db: &impl ConnectionTrait, role: &str) -> i32 {
    let name = format!("moderation_{}", uuid::Uuid::new_v4().simple());
    db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'fixture',$2) RETURNING id",
        vec![name.into(), role.into()])).await.unwrap().unwrap().try_get("", "id").unwrap()
}

async fn board(db: &impl ConnectionTrait, uid: i32, source: &str) -> i32 {
    db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO talk (title,content,cat,v,author,user_id,src,approved,ai_reason,created_at,updated_at) \
         VALUES ('','真实审核正文','愿',0,'自由留名',$1,$2,0,'保留的审核说明',localtimestamp,localtimestamp) RETURNING id",
        vec![uid.into(), source.into()])).await.unwrap().unwrap().try_get("", "id").unwrap()
}

async fn comment(
    db: &impl ConnectionTrait,
    uid: i32,
    article: i32,
    root: Option<i32>,
    recipient: Option<i32>,
) -> i32 {
    db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note_comment (note_id,user_id,content,root_id,parent_id,reply_to_uid,approved,is_deleted,created_at,updated_at) \
         VALUES ($1,$2,'真实评论正文',$3,$3,$4,0,0,localtimestamp,localtimestamp) RETURNING id",
        vec![article.into(), uid.into(), root.into(), recipient.into()])).await.unwrap().unwrap().try_get("", "id").unwrap()
}

async fn change(
    db: &impl ConnectionTrait,
    actor: i32,
    resource: Resource,
    id: i32,
    action: Action,
) -> mutations::Receipt {
    let target = targets::load(db, resource, id, false)
        .await
        .unwrap()
        .target
        .unwrap();
    mutations::apply_in(
        db,
        actor,
        resource,
        id,
        &Change {
            action,
            version: target.version,
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn postgres_moderation_bindings_notifications_and_deletion_roll_back() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let admin = account(&txn, "admin").await;
    let owner = account(&txn, "user").await;
    let replier = account(&txn, "user").await;
    for (saved, expected) in [
        ("", "具体AI理由"),
        (" \t\n ", "具体AI理由"),
        ("  手工理由  ", "手工理由"),
    ] {
        let id = board(&txn, owner, "board").await;
        talk::Entity::update_many()
            .set(talk::ActiveModel {
                reject_reason: Set(Some(saved.into())),
                ai_reason: Set(Some("  具体AI理由  ".into())),
                ..Default::default()
            })
            .filter(talk::Column::Id.eq(id))
            .exec(&txn)
            .await
            .unwrap();
        let receipt = change(&txn, admin, Resource::Boards, id, Action::Reject).await;
        assert_eq!(receipt.notifications, 1);
        let saved = talk::Entity::find_by_id(id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.reject_reason.as_deref(), Some(expected));
        let notification = user_notification::Entity::find()
            .filter(user_notification::Column::UserId.eq(owner))
            .filter(user_notification::Column::Link.eq(format!("/guestbook?lid={id}")))
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(notification
            .content
            .unwrap()
            .contains(&format!("理由：{expected}")));
    }
    let id = board(&txn, owner, "board").await;
    let not_board = board(&txn, owner, "talk").await;
    let long_id = board(&txn, owner, "board").await;
    let long = "长".repeat(5000);
    talk::Entity::update_many()
        .set(talk::ActiveModel {
            content: Set(format!("{long}甲")),
            ..Default::default()
        })
        .filter(talk::Column::Id.eq(long_id))
        .exec(&txn)
        .await
        .unwrap();
    let bounded = targets::load(&txn, Resource::Boards, long_id, false)
        .await
        .unwrap()
        .target
        .unwrap();
    assert!(bounded.content_truncated && bounded.content.chars().count() == 500);
    talk::Entity::update_many()
        .set(talk::ActiveModel {
            content: Set(format!("{long}乙")),
            ..Default::default()
        })
        .filter(talk::Column::Id.eq(long_id))
        .exec(&txn)
        .await
        .unwrap();
    let different_tail = targets::load(&txn, Resource::Boards, long_id, false)
        .await
        .unwrap()
        .target
        .unwrap();
    assert_ne!(bounded.version, different_tail.version);
    assert!(mutations::apply_in(
        &txn,
        admin,
        Resource::Boards,
        long_id,
        &Change {
            action: Action::Delete,
            version: different_tail.version
        }
    )
    .await
    .is_err());

    assert!(
        !targets::load(&txn, Resource::Boards, not_board, false)
            .await
            .unwrap()
            .exists
    );
    let initial = targets::load(&txn, Resource::Boards, id, false)
        .await
        .unwrap()
        .target
        .unwrap();
    assert!(!initial.content_truncated);
    assert!(mutations::apply_in(
        &txn,
        owner,
        Resource::Boards,
        id,
        &Change {
            action: Action::Pass,
            version: initial.version.clone()
        }
    )
    .await
    .is_err());
    let count = user_notification::Entity::find()
        .filter(user_notification::Column::UserId.eq(owner))
        .count(&txn)
        .await
        .unwrap();
    let done = change(&txn, admin, Resource::Boards, id, Action::Reject).await;
    assert!(done.changed && done.approved == 2 && done.notifications == 1);
    let saved = talk::Entity::find_by_id(id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.reject_reason.as_deref(), Some("保留的审核说明"));
    assert!(mutations::apply_in(
        &txn,
        admin,
        Resource::Boards,
        id,
        &Change {
            action: Action::Pass,
            version: initial.version
        }
    )
    .await
    .is_err());
    let noop = change(&txn, admin, Resource::Boards, id, Action::Reject).await;
    assert!(!noop.changed && noop.notifications == 0);
    change(&txn, admin, Resource::Boards, id, Action::Pass).await;
    assert!(talk::Entity::find_by_id(id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap()
        .reject_reason
        .is_none());
    assert_eq!(
        user_notification::Entity::find()
            .filter(user_notification::Column::UserId.eq(owner))
            .count(&txn)
            .await
            .unwrap(),
        count + 2
    );
    let old = targets::load(&txn, Resource::Boards, id, false)
        .await
        .unwrap()
        .target
        .unwrap();
    talk::Entity::update_many()
        .col_expr(
            talk::Column::Content,
            sea_orm::sea_query::Expr::value("正文已编辑"),
        )
        .filter(talk::Column::Id.eq(id))
        .exec(&txn)
        .await
        .unwrap();
    assert!(mutations::apply_in(
        &txn,
        admin,
        Resource::Boards,
        id,
        &Change {
            action: Action::Delete,
            version: old.version
        }
    )
    .await
    .is_err());
    change(&txn, admin, Resource::Boards, id, Action::Delete).await;
    assert!(talk::Entity::find_by_id(id)
        .one(&txn)
        .await
        .unwrap()
        .is_none());

    let article: i32 = txn
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO note (title,content,status,is_public,created_at,updated_at) \
         VALUES ('审核测试文章','', 'published',true,localtimestamp,localtimestamp) RETURNING id",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "id")
        .unwrap();
    for (saved, expected) in [
        ("", "具体AI理由"),
        (" \t\n ", "具体AI理由"),
        ("  手工理由  ", "手工理由"),
    ] {
        let id = comment(&txn, owner, article, None, None).await;
        note_comment::Entity::update_many()
            .set(note_comment::ActiveModel {
                reject_reason: Set(Some(saved.into())),
                ai_reason: Set(Some("  具体AI理由  ".into())),
                ..Default::default()
            })
            .filter(note_comment::Column::Id.eq(id))
            .exec(&txn)
            .await
            .unwrap();
        let receipt = change(&txn, admin, Resource::Comments, id, Action::Reject).await;
        assert_eq!(receipt.notifications, 0);
        assert_eq!(
            note_comment::Entity::find_by_id(id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .reject_reason
                .as_deref(),
            Some(expected)
        );
    }
    let root = comment(&txn, owner, article, None, None).await;
    change(&txn, admin, Resource::Comments, root, Action::Pass).await;
    let reply = comment(&txn, replier, article, Some(root), Some(owner)).await;
    let reply_done = change(&txn, admin, Resource::Comments, reply, Action::Pass).await;
    assert!(reply_done.changed && reply_done.notifications == 1);
    let root_before = targets::load(&txn, Resource::Comments, root, false)
        .await
        .unwrap()
        .target
        .unwrap();
    assert_eq!(root_before.affected_replies, 1);
    note_comment::Entity::update_many()
        .set(note_comment::ActiveModel {
            content: Set("回复已编辑".into()),
            ..Default::default()
        })
        .filter(note_comment::Column::Id.eq(reply))
        .exec(&txn)
        .await
        .unwrap();
    assert!(mutations::apply_in(
        &txn,
        admin,
        Resource::Comments,
        root,
        &Change {
            action: Action::Delete,
            version: root_before.version
        }
    )
    .await
    .is_err());
    change(&txn, admin, Resource::Comments, root, Action::Reject).await;
    let hidden_reply = comment(&txn, replier, article, Some(root), Some(owner)).await;
    let hidden = change(&txn, admin, Resource::Comments, hidden_reply, Action::Pass).await;
    assert_eq!(hidden.notifications, 0);
    let root_deleted = change(&txn, admin, Resource::Comments, root, Action::Delete).await;
    assert!(root_deleted.changed && root_deleted.is_deleted);
    assert_eq!(
        note_comment::Entity::find_by_id(root)
            .one(&txn)
            .await
            .unwrap()
            .unwrap()
            .is_deleted,
        1
    );
    assert!(note_comment::Entity::find_by_id(reply)
        .one(&txn)
        .await
        .unwrap()
        .is_some());
    let again = change(&txn, admin, Resource::Comments, root, Action::Delete).await;
    assert!(!again.changed);
    let snapshot = targets::load(&txn, Resource::Comments, root, false)
        .await
        .unwrap()
        .target
        .unwrap();
    assert!(mutations::apply_in(
        &txn,
        admin,
        Resource::Comments,
        root,
        &Change {
            action: Action::Pass,
            version: snapshot.version
        }
    )
    .await
    .is_err());
    txn.rollback().await.unwrap();
}

fn at() -> chrono::NaiveDateTime {
    chrono::NaiveDate::from_ymd_opt(2026, 10, 23)
        .unwrap()
        .and_hms_opt(10, 0, 0)
        .unwrap()
}

fn fixture_board() -> talk::Model {
    talk::Model {
        id: 11,
        user_id: 8,
        title: None,
        content: "真实审核正文".into(),
        cat: "愿".into(),
        v: 0,
        author: "留名".into(),
        src: "board".into(),
        approved: 0,
        ai_result: None,
        ai_reason: None,
        reject_reason: None,
        created_at: at(),
        updated_at: at(),
    }
}

fn mock_board() -> std::collections::BTreeMap<String, sea_orm::Value> {
    use sea_orm::{Iden, Iterable, ModelTrait};
    use sha2::{Digest, Sha256};
    let row = fixture_board();
    let mut data: std::collections::BTreeMap<_, _> = talk::Column::iter()
        .map(|column| (column.to_string(), row.get(column)))
        .collect();
    data.insert(
        "content_digest".into(),
        hex::encode(Sha256::digest(row.content.as_bytes())).into(),
    );
    data
}

fn publisher() -> std::collections::BTreeMap<String, sea_orm::Value> {
    std::collections::BTreeMap::from([
        ("id".into(), 8.into()),
        ("username".into(), "owner".into()),
        ("nickname".into(), "账号".into()),
        ("role".into(), "user".into()),
    ])
}

#[tokio::test]
async fn target_sql_limits_body_before_transport_and_hashes_full_content() {
    let db = sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([sea_orm::DbErr::Custom("offline".into())])
        .into_connection();
    assert!(targets::row(&db, Resource::Boards, 11, false)
        .await
        .is_err());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(
        log.contains("LEFT(content,501)") && log.contains("sha256(convert_to(content"),
        "{log}"
    );
    assert!(!log.contains("\"talk\".\"content\""), "{log}");
}

#[tokio::test]
async fn visibility_context_locks_article_then_root_before_target_write() {
    let row = note_comment::Model {
        id: 12,
        note_id: 19,
        user_id: 8,
        content: "正文".into(),
        root_id: Some(11),
        parent_id: Some(11),
        reply_to_uid: Some(9),
        approved: 0,
        ai_result: None,
        ai_reason: None,
        reject_reason: None,
        is_deleted: 0,
        created_at: at(),
        updated_at: at(),
    };
    let row = targets::Row::Comment(targets::Content {
        row,
        content_digest: String::new(),
    });
    let db = sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([
            vec![std::collections::BTreeMap::from([(
                "id".to_owned(),
                sea_orm::Value::Int(Some(19)),
            )])],
            vec![std::collections::BTreeMap::from([(
                "id".to_owned(),
                sea_orm::Value::Int(Some(11)),
            )])],
        ])
        .into_connection();
    targets::lock_context(&db, &row).await.unwrap();
    let log = format!("{:?}", db.into_transaction_log());
    assert_eq!(log.matches("FOR SHARE").count(), 2, "{log}");
    assert!(
        log.find("note").unwrap() < log.find("note_comment").unwrap(),
        "{log}"
    );
}

#[tokio::test]
async fn notification_failure_rolls_back_the_moderation_write() {
    let read = sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![mock_board()], vec![publisher()]])
        .into_connection();
    let version = targets::load(&read, Resource::Boards, 11, false)
        .await
        .unwrap()
        .target
        .unwrap()
        .version;
    let actor = std::collections::BTreeMap::from([
        ("role".to_owned(), "admin".into()),
        ("status".to_owned(), 0_i16.into()),
    ]);
    let db = sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([
            vec![actor],
            vec![mock_board()],
            vec![mock_board()],
            vec![publisher()],
        ])
        .append_exec_results([sea_orm::MockExecResult {
            last_insert_id: 0,
            rows_affected: 1,
        }])
        .append_query_errors([sea_orm::DbErr::Custom(
            "notification storage offline".into(),
        )])
        .into_connection();
    assert!(mutations::apply(
        &db,
        7,
        Resource::Boards,
        11,
        &Change {
            action: Action::Pass,
            version
        }
    )
    .await
    .is_err());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(
        log.contains("UPDATE") && log.contains("INSERT INTO") && log.contains("ROLLBACK"),
        "{log}"
    );
    assert!(!log.contains("COMMIT"), "{log}");
}

#[test]
fn rejection_reason_skips_blank_values_and_preserves_priority() {
    assert_eq!(
        mutations::reject_reason(Some(""), Some("  AI说明  ")),
        Some("AI说明".into())
    );
    assert_eq!(
        mutations::reject_reason(Some(" \t\n "), Some("  AI说明  ")),
        Some("AI说明".into())
    );
    assert_eq!(
        mutations::reject_reason(Some("  人工说明 "), Some("AI说明")),
        Some("人工说明".into())
    );
    assert_eq!(mutations::reject_reason(Some(" "), Some("\t")), None);
    assert_eq!(mutations::reject_reason(None, None), None);
}
