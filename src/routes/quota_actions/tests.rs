use super::*;
use sea_orm::{Database, DatabaseBackend, Statement, TransactionTrait};

fn target() -> Account {
    Account {
        id: 12,
        username: "reader".into(),
        role: "user".into(),
        status: 0,
        chat_quota_used: 25,
    }
}

fn application() -> quota_request::Model {
    quota_request::Model {
        id: 31,
        user_id: 12,
        reason: Some("prepare interview".into()),
        status: 0,
        note: None,
        created_at: chrono::NaiveDate::from_ymd_opt(2026, 10, 23)
            .unwrap()
            .and_hms_micro_opt(12, 0, 0, 123456)
            .unwrap(),
        handled_at: None,
        handled_by: None,
    }
}

#[test]
fn approval_version_binds_full_request_and_account_but_not_natural_usage_growth() {
    let mut user = target();
    let mut row = application();
    let version = request_version(&row, &user);
    user.chat_quota_used += 1;
    assert_eq!(version, request_version(&row, &user));
    for field in [
        "reason",
        "created_at",
        "status",
        "user_id",
        "username",
        "role",
    ] {
        let mut changed = row.clone();
        let mut renamed = user.clone();
        match field {
            "reason" => changed.reason = Some("different reason".repeat(20)),
            "created_at" => changed.created_at += chrono::Duration::microseconds(1),
            "status" => changed.status = 2,
            "user_id" => changed.user_id += 1,
            "username" => renamed.username = "another".into(),
            "role" => renamed.role = "admin".into(),
            _ => unreachable!(),
        }
        assert_ne!(version, request_version(&changed, &renamed), "{field}");
    }
    row.reason = Some("x".repeat(500));
    let first = request_version(&row, &user);
    row.reason = Some("x".repeat(499) + "y");
    assert_ne!(first, request_version(&row, &user));
}

#[test]
fn reset_version_binds_used_turns_and_snapshot_encodes_unlimited_truthfully() {
    let mut user = target();
    let version = account_version(&user);
    user.chat_quota_used += 1;
    assert_ne!(version, account_version(&user));
    user.role = "admin".into();
    let view = snapshot(&user, None);
    assert!(view.unlimited);
    assert_eq!((view.used, view.limit), (0, 0));
    assert_eq!(view.unit, "conversation_turns");
    let value = serde_json::to_value(view).unwrap();
    assert!(value.get("password").is_none() && value.get("request").is_none());
}

#[tokio::test]
async fn missing_account_query_fails_and_selects_no_credentials() {
    let db = sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<user::Model>::new()])
        .into_connection();
    assert!(account(&db, 12, true).await.is_err());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("FOR UPDATE"));
    assert!(!log.contains("password") && !log.contains("token_version"));
}

#[tokio::test]
async fn postgres_quota_actions_guard_exact_requests_and_accounts_in_rollback() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let name = format!("quota_{}", uuid::Uuid::new_v4().simple());
    let id: i32 = tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role,chat_quota_used) VALUES ($1,$1,$2,'user',25) RETURNING id",
        vec![name.into(), uuid::Uuid::new_v4().to_string().into()])).await.unwrap().unwrap()
        .try_get("", "id").unwrap();
    let insert = |reason: &str| {
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO quota_request (user_id,reason,status,created_at) VALUES ($1,$2,0,localtimestamp) RETURNING id",
            vec![id.into(), reason.to_owned().into()],
        )
    };
    let request_id: i32 = tx
        .query_one(insert("first application"))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "id")
        .unwrap();
    let second_id: i32 = tx
        .query_one(insert("second application"))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "id")
        .unwrap();
    let row = request(&tx, request_id, false).await.unwrap();
    let user = account(&tx, id, false).await.unwrap();
    let version = request_version(&row, &user);
    let review = || super::super::quota::ReviewQuotaReq {
        approved: true,
        reason: None,
    };
    assert!(
        service::review_in(&tx, id, request_id, review(), Some("stale"))
            .await
            .is_err()
    );
    assert_eq!(account(&tx, id, false).await.unwrap().chat_quota_used, 25);
    let result = service::review_in(&tx, id, request_id, review(), Some(&version))
        .await
        .unwrap();
    assert!(result.changed);
    let stored = request(&tx, request_id, false).await.unwrap();
    let stored_account = account(&tx, id, false).await.unwrap();
    assert_eq!(
        result.state.version,
        request_version(&stored, &stored_account)
    );
    assert_eq!(result.state.request.unwrap().id, request_id);
    assert_eq!(account(&tx, id, false).await.unwrap().chat_quota_used, 0);
    assert_eq!(request(&tx, second_id, false).await.unwrap().status, 0);
    assert!(
        service::review_in(&tx, id, request_id, review(), Some(&version))
            .await
            .is_err()
    );
    let pending = request(&tx, second_id, false).await.unwrap();
    let target = account(&tx, id, false).await.unwrap();
    let expected = request_version(&pending, &target);
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE quota_request SET reason='edited' WHERE id=$1",
        vec![second_id.into()],
    ))
    .await
    .unwrap();
    assert!(
        service::review_in(&tx, id, second_id, review(), Some(&expected))
            .await
            .is_err()
    );
    let edited = request(&tx, second_id, false).await.unwrap();
    let reject_version = request_version(&edited, &target);
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET chat_quota_used=7 WHERE id=$1",
        vec![id.into()],
    ))
    .await
    .unwrap();
    service::review_in(
        &tx,
        id,
        second_id,
        super::super::quota::ReviewQuotaReq {
            approved: false,
            reason: Some("explicit decision".into()),
        },
        Some(&reject_version),
    )
    .await
    .unwrap();
    assert_eq!(account(&tx, id, false).await.unwrap().chat_quota_used, 7);
    let target = account(&tx, id, false).await.unwrap();
    let reset_version = account_version(&target);
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET chat_quota_used=8 WHERE id=$1",
        vec![id.into()],
    ))
    .await
    .unwrap();
    assert!(
        service::reset_in(&tx, id, Some(&reset_version))
            .await
            .is_err()
    );
    assert_eq!(account(&tx, id, false).await.unwrap().chat_quota_used, 8);
    let updated = account(&tx, id, false).await.unwrap();
    let reset = service::reset_in(&tx, id, Some(&account_version(&updated)))
        .await
        .unwrap();
    assert!(reset.changed && reset.state.used == 0);
    assert!(!service::reset_in(&tx, id, None).await.unwrap().changed);
    user::Entity::delete_by_id(id).exec(&tx).await.unwrap();
    assert!(service::reset_in(&tx, id, None).await.is_err());
    tx.rollback().await.unwrap();
}
