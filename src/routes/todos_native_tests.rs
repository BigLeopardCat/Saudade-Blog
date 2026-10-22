use super::*;
use chrono::NaiveDate;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, QueryTrait, Statement};

fn row(id: i32, uid: i32) -> dashboard_todo::Model {
    let at = NaiveDate::from_ymd_opt(2026, 10, 23)
        .unwrap()
        .and_hms_micro_opt(10, 0, 0, 1)
        .unwrap();
    dashboard_todo::Model {
        id,
        user_id: uid,
        sort_order: 0,
        text: "same text".into(),
        done: false,
        due_date: None,
        created_at: at,
        updated_at: at,
    }
}

#[test]
fn stable_identity_rejects_stale_versions_and_allows_duplicate_text() {
    let rows = vec![row(11, 7), row(12, 7)];
    let version = rows[0].updated_at.to_string();
    assert_eq!(
        pick_request_todo(&rows, "same text", Some(11), Some(&version))
            .unwrap()
            .id,
        11
    );
    assert!(pick_request_todo(&rows, "same text", None, None).is_err());
    assert!(pick_request_todo(&rows, "same text", Some(11), None).is_err());
    assert!(pick_request_todo(&rows, "same text", None, Some(&version)).is_err());
    assert!(pick_request_todo(&rows, "same text", Some(13), Some(&version)).is_err());
    assert!(pick_request_todo(&rows, "edited text", Some(11), Some(&version)).is_err());
    assert!(pick_request_todo(&rows, "same text", Some(11), Some("old")).is_err());
}

#[test]
fn writes_bind_actor_id_text_and_version_in_sql() {
    let row = row(11, 7);
    let update = conditional_update(
        7,
        &row,
        dashboard_todo::ActiveModel {
            done: Set(true),
            ..Default::default()
        },
    )
    .build(DatabaseBackend::Postgres);
    for field in ["id", "user_id", "text", "updated_at"] {
        assert!(
            update.sql.contains(&format!("\"{field}\" = $")),
            "{update:?}"
        );
    }
}

#[test]
fn read_dto_adds_identity_without_breaking_legacy_save() {
    let old: TodoDto =
        serde_json::from_value(serde_json::json!({"text":"x","done":false,"date":null})).unwrap();
    assert!(old.id.is_none() && old.version.is_none());
    let dto = TodoDto {
        id: Some(11),
        version: Some(row(11, 7).updated_at.to_string()),
        text: "x".into(),
        done: true,
        date: None,
    };
    let value = serde_json::to_value(dto).unwrap();
    assert_eq!(value["id"], 11);
    assert_eq!(value["version"], "2026-10-23 10:00:00.000001");
}

#[tokio::test]
async fn postgres_atomic_updates_reject_foreign_stale_and_deleted_rows() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let name = format!("todo_{}", uuid::Uuid::new_v4().simple());
    let user = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'fixture','admin') RETURNING id",
        vec![name.into()])).await.unwrap().unwrap();
    let uid: i32 = user.try_get("", "id").unwrap();
    let at = row(0, uid).updated_at;
    let first = dashboard_todo::Entity::insert(dashboard_todo::ActiveModel {
        user_id: Set(uid),
        sort_order: Set(0),
        text: Set("same text".into()),
        done: Set(false),
        due_date: Set(None),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_with_returning(&txn)
    .await
    .unwrap();
    assert_eq!(
        pick_request_todo(
            &[first.clone()],
            "same text",
            Some(first.id),
            Some(&first.updated_at.to_string())
        )
        .unwrap()
        .id,
        first.id
    );
    let changes = || dashboard_todo::ActiveModel {
        done: Set(true),
        updated_at: Set(at + chrono::Duration::microseconds(1)),
        ..Default::default()
    };
    assert_eq!(
        conditional_update(uid + 1, &first, changes())
            .exec(&txn)
            .await
            .unwrap()
            .rows_affected,
        0
    );
    assert_eq!(
        conditional_update(uid, &first, changes())
            .exec(&txn)
            .await
            .unwrap()
            .rows_affected,
        1
    );
    assert_eq!(
        conditional_update(uid, &first, changes())
            .exec(&txn)
            .await
            .unwrap()
            .rows_affected,
        0
    );
    let current = dashboard_todo::Entity::find_by_id(first.id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert!(current.done);
    assert_eq!(current.text, first.text);
    assert_eq!(current.due_date, first.due_date);
    let next_date = NaiveDate::from_ymd_opt(2026, 10, 26).unwrap();
    let change = dashboard_todo::ActiveModel {
        due_date: Set(Some(next_date)),
        updated_at: Set(at + chrono::Duration::microseconds(2)),
        ..Default::default()
    };
    assert_eq!(
        conditional_update(uid, &current, change)
            .exec(&txn)
            .await
            .unwrap()
            .rows_affected,
        1
    );
    let dated = dashboard_todo::Entity::find_by_id(first.id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert!(dated.done);
    assert_eq!(dated.due_date, Some(next_date));
    dashboard_todo::Entity::delete_by_id(first.id)
        .exec(&txn)
        .await
        .unwrap();
    assert_eq!(
        conditional_update(uid, &dated, changes())
            .exec(&txn)
            .await
            .unwrap()
            .rows_affected,
        0
    );
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn list_writes_lock_the_actor_row_and_missing_actors_fail_closed() {
    let db = sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<user::Model>::new()])
        .into_connection();
    assert!(begin_list_write(&db, 7).await.is_err());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("FOR UPDATE"), "{log}");
    assert!(log.contains("Int(Some(7))"), "{log}");
}

#[tokio::test]
async fn postgres_list_writes_serialize_on_actor_row_without_business_writes() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Arc::new(Database::connect(url).await.unwrap());
    let actor = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT id FROM \"user\" WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1",
        ))
        .await
        .unwrap()
        .unwrap();
    let uid: i32 = actor.try_get("", "id").unwrap();
    let first = begin_list_write(&db, uid).await.unwrap();
    let cloned = Arc::clone(&db);
    let mut second = tokio::spawn(async move { begin_list_write(&cloned, uid).await.unwrap() });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), &mut second)
            .await
            .is_err()
    );
    first.rollback().await.unwrap();
    let second = tokio::time::timeout(std::time::Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap();
    second.rollback().await.unwrap();
}
