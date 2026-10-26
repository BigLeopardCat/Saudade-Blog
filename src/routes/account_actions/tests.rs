use super::*;
use crate::entity::user;
use chrono::NaiveDateTime;
use sea_orm::{DatabaseBackend, MockDatabase};
use serde_json::json;
use tower::ServiceExt;

fn row(id: i32, role: &str) -> user::Model {
    user::Model {
        id,
        username: format!("u{id}"),
        nickname: String::new(),
        nickname_auto_renamed: 0,
        avatar: None,
        password: "must-not-leave-service".into(),
        role: role.into(),
        status: 0,
        token_version: 12,
        chat_quota_used: 0,
        muted_until: None,
    }
}
pub(super) fn intent(action: &str) -> Intent {
    serde_json::from_value(json!({"action":action,"target":{"id":2}})).unwrap()
}
#[test]
fn exact_identity_and_action_fields_are_required() {
    let clock = NaiveDateTime::parse_from_str("2026-10-24T10:00:00", "%Y-%m-%dT%H:%M:%S").unwrap();
    for value in [
        json!({"action":"freeze","target":{}}),
        json!({"action":"freeze","target":{"id":2,"username":" "}}),
        json!({"action":"freeze","target":{"id":0}}),
        json!({"action":"freeze","target":{"username":" "}}),
        json!({"action":"freeze","target":{"id":2},"role":"user"}),
        json!({"action":"set_role","target":{"id":2}}),
        json!({"action":"mute","target":{"id":2}}),
        json!({"action":"mute","target":{"id":2},"mutedUntil":"2026-10-24T10:00:00"}),
        json!({"action":"mute","target":{"id":2},"mutedUntil":"2027-01-01T00:00:00Z"}),
        json!({"action":"unmute","target":{"id":2},"mutedUntil":"9999-12-31T23:59:59"}),
    ] {
        assert!(targets::validate(&serde_json::from_value(value).unwrap(), clock).is_err());
    }
    for until in ["2027-01-01T00:00:00", "9999-12-31T23:59:59"] {
        let v: Intent = serde_json::from_value(
            json!({"action":"mute","target":{"username":"u2"},"mutedUntil":until}),
        )
        .unwrap();
        assert!(targets::validate(&v, clock).unwrap().unwrap() > clock);
    }
    assert!(serde_json::from_value::<Intent>(
        json!({"action":"freeze","target":{"nickname":"u2"}})
    )
    .is_err());
    assert!(serde_json::from_value::<Intent>(
        json!({"action":"freeze","target":{"id":2},"password":"x"})
    )
    .is_err());
}
#[test]
fn authoritative_policy_refuses_self_peers_superadmin_and_role_escalation() {
    for action in ["freeze", "unfreeze", "mute", "unmute"] {
        let v = intent(action);
        for (actor, target) in [
            (row(1, "user"), row(2, "user")),
            (row(1, "admin"), row(1, "user")),
            (row(1, "admin"), row(2, "admin")),
            (row(1, "superadmin"), row(2, "superadmin")),
        ] {
            assert!(targets::authorize(&actor, &target, &v).is_err());
        }
        assert!(targets::authorize(&row(1, "admin"), &row(2, "user"), &v).is_ok());
        assert!(targets::authorize(&row(1, "superadmin"), &row(2, "admin"), &v).is_ok());
    }
    let mut v = intent("set_role");
    v.role = Some("admin".into());
    assert!(targets::authorize(&row(1, "admin"), &row(2, "user"), &v).is_err());
    assert!(targets::authorize(&row(1, "superadmin"), &row(2, "user"), &v).is_ok());
    assert!(
        targets::authorize(&row(1, "superadmin"), &row(2, "historical_unknown"), &v).is_ok(),
        "superadmin may repair an unknown historical role under existing policy"
    );
    assert!(targets::authorize(&row(1, "admin"), &row(2, "historical_unknown"), &v).is_err());
    v.role = Some("superadmin".into());
    assert!(targets::authorize(&row(1, "superadmin"), &row(2, "user"), &v).is_err());
    let mut actor = row(1, "superadmin");
    actor.status = 1;
    assert!(targets::authorize(&actor, &row(2, "user"), &v).is_err());
}
#[test]
fn snapshots_redact_credentials_and_shanghai_clock_does_not_depend_on_host_tz() {
    let value = serde_json::to_value(Account::from(&row(2, "user"))).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 5);
    for key in [
        "password",
        "token_version",
        "tokenVersion",
        "account_action_version",
        "nickname",
    ] {
        assert!(value.get(key).is_none());
    }
    assert!(
        (targets::now() - chrono::Utc::now().naive_utc() - chrono::Duration::hours(8))
            .num_seconds()
            .abs()
            < 2
    );
}
pub(super) fn state(db: sea_orm::DatabaseConnection) -> crate::routes::AppState {
    crate::routes::AppState {
        db,
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: crate::risk::PostRateLimiter::new(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    }
}
#[tokio::test]
async fn complete_router_requires_administrator_for_both_new_endpoints() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    // Fixed test-only key, matching the repository's API fixture convention.
    std::env::set_var("JWT_SECRET", "test-secret-not-used-for-anything-real");
    for path in [
        "/api/protected/account-actions/prepare",
        "/api/protected/account-actions",
    ] {
        let app = crate::routes::create_router(state(
            MockDatabase::new(DatabaseBackend::Postgres).into_connection(),
        ));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let app = crate::routes::create_router(state(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results([vec![row(2, "user")]])
                .into_connection(),
        ));
        let token = crate::auth_jwt::create_token(2, "superadmin", 12); // DB role, never token role, controls admission.
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
