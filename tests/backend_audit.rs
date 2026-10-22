//! 真 PostgreSQL 回归；用 TEST_PG_URL 指向隔离库，并先加载 ci_schema_files.py 清单。
use axum::{body::Body, http::Request};
use saudade_blog::{create_router, AppState};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn connect() -> Option<DatabaseConnection> {
    let url = std::env::var("TEST_PG_URL").ok()?;
    std::env::set_var("JWT_SECRET", "isolated-backend-audit-test-secret");
    Some(Database::connect(url).await.expect("TEST_PG_URL 无法连接"))
}

fn app(db: DatabaseConnection) -> axum::Router {
    create_router(AppState {
        db,
        rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 300, 900),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

async fn sql(db: &DatabaseConnection, query: &str) {
    db.execute(Statement::from_string(
        DbBackend::Postgres,
        query.to_string(),
    ))
    .await
    .unwrap();
}

async fn scalar(db: &DatabaseConnection, query: &str) -> i64 {
    db.query_one(Statement::from_string(
        DbBackend::Postgres,
        query.to_string(),
    ))
    .await
    .unwrap()
    .unwrap()
    .try_get_by_index(0)
    .unwrap()
}

async fn user(db: &DatabaseConnection, id: i32, role: &str) {
    sql(db, &format!("DELETE FROM \"user\" WHERE id={id}")).await;
    let hash = saudade_blog::utils::encrypt_password("original-password");
    sql(
        db,
        &format!(
            "INSERT INTO \"user\" (id,username,password,role) VALUES \
        ({id},'audit_{id}','{hash}','{role}')"
        ),
    )
    .await;
}

async fn api(app: axum::Router, uri: &str, actor: Option<i32>, body: Value) -> Value {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(uid) = actor {
        builder = builder.header(
            "authorization",
            format!(
                "Bearer {}",
                saudade_blog::auth_jwt::create_token(uid, "admin", 0)
            ),
        );
    }
    let response = app
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn credentials_enforce_target_tiers_on_both_endpoints() {
    let Some(db) = connect().await else { return };
    for (id, role) in [
        (910000001, "admin"),
        (910000002, "superadmin"),
        (910000003, "admin"),
        (910000004, "user"),
    ] {
        user(&db, id, role).await;
    }
    let router = app(Database::connect(std::env::var("TEST_PG_URL").unwrap())
        .await
        .unwrap());
    for target in [910000001, 910000002, 910000003] {
        for endpoint in ["password", "password-reset-token"] {
            let result = api(
                router.clone(),
                &format!("/api/temp-users/{target}/{endpoint}"),
                Some(910000001),
                json!({"password":"replacement-password"}),
            )
            .await;
            assert_ne!(result["code"], 200, "{target}/{endpoint}: {result}");
        }
        assert_eq!(
            scalar(
                &db,
                &format!("SELECT token_version::bigint FROM \"user\" WHERE id={target}")
            )
            .await,
            0
        );
        assert_eq!(
            scalar(
                &db,
                &format!("SELECT count(*) FROM password_reset_token WHERE user_id={target}")
            )
            .await,
            0
        );
    }
    let changed = api(
        router.clone(),
        "/api/temp-users/910000004/password",
        Some(910000001),
        json!({"password":"replacement-password"}),
    )
    .await;
    assert_eq!(changed["code"], 200, "{changed}");
    assert_eq!(
        scalar(
            &db,
            "SELECT token_version::bigint FROM \"user\" WHERE id=910000004"
        )
        .await,
        1
    );
    let issued = api(
        router.clone(),
        "/api/temp-users/910000003/password-reset-token",
        Some(910000002),
        json!({}),
    )
    .await;
    assert_eq!(issued["code"], 200, "{issued}");
    assert!(issued["data"].as_str().unwrap().len() >= 16);
    // 超管可管理普通管理员的密码，但仍然不能管理另一个超管。
    let changed = api(
        router,
        "/api/temp-users/910000003/password",
        Some(910000002),
        json!({"password":"replacement-password"}),
    )
    .await;
    assert_eq!(changed["code"], 200, "{changed}");
}

#[tokio::test]
async fn recovery_code_is_consumed_once_under_concurrent_requests() {
    let Some(db) = connect().await else { return };
    user(&db, 910000011, "user").await;
    let hash = saudade_blog::utils::encrypt_password("single-use-recovery-code");
    sql(&db,&format!("INSERT INTO password_reset_token (user_id,token_hash,expires_at,created_at) \
        VALUES (910000011,'{hash}',timezone('UTC',CURRENT_TIMESTAMP) + interval '15 minutes',timezone('UTC',CURRENT_TIMESTAMP))")).await;
    let router = app(Database::connect(std::env::var("TEST_PG_URL").unwrap())
        .await
        .unwrap());
    let payload = |pw| json!({"username":"audit_910000011","recovery_code":"single-use-recovery-code","new_password":pw});
    let (a, b) = tokio::join!(
        api(
            router.clone(),
            "/api/password/reset",
            None,
            payload("first-new-password")
        ),
        api(
            router,
            "/api/password/reset",
            None,
            payload("second-new-password")
        )
    );
    assert_eq!(
        [&a, &b].iter().filter(|r| r["code"] == 200).count(),
        1,
        "{a}; {b}"
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT token_version::bigint FROM \"user\" WHERE id=910000011"
        )
        .await,
        1
    );
    assert_eq!(scalar(&db,"SELECT count(*) FROM password_reset_token WHERE user_id=910000011 AND used_at IS NOT NULL").await,1);
    let row = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT password FROM \"user\" WHERE id=910000011".to_string(),
        ))
        .await
        .unwrap()
        .unwrap();
    let stored: String = row.try_get_by_index(0).unwrap();
    let winning_password = if a["code"] == 200 {
        "first-new-password"
    } else {
        "second-new-password"
    };
    assert!(saudade_blog::utils::verify_password(
        winning_password,
        &stored
    ));
}

#[tokio::test]
async fn failed_password_updates_roll_back_code_claim_and_do_not_report_success() {
    let Some(db) = connect().await else { return };
    user(&db, 910000021, "user").await;
    user(&db, 910000022, "admin").await;
    let hash = saudade_blog::utils::encrypt_password("rollback-recovery-code");
    sql(&db,&format!("INSERT INTO password_reset_token (user_id,token_hash,expires_at,created_at) \
        VALUES (910000021,'{hash}',timezone('UTC',CURRENT_TIMESTAMP) + interval '15 minutes',timezone('UTC',CURRENT_TIMESTAMP))")).await;
    sql(&db,"CREATE OR REPLACE FUNCTION audit_reject_password() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id=910000021 THEN RAISE EXCEPTION 'audit injected update failure'; END IF; RETURN NEW; END $$").await;
    sql(&db,"CREATE TRIGGER audit_reject_password BEFORE UPDATE OF password ON \"user\" FOR EACH ROW EXECUTE FUNCTION audit_reject_password()").await;
    let router = app(Database::connect(std::env::var("TEST_PG_URL").unwrap())
        .await
        .unwrap());
    let recovered = api(router.clone(),"/api/password/reset",None,json!({
        "username":"audit_910000021","recovery_code":"rollback-recovery-code","new_password":"recovery-new-password"})).await;
    let changed = api(
        router,
        "/api/temp-users/910000021/password",
        Some(910000022),
        json!({"password":"admin-new-password"}),
    )
    .await;
    sql(&db, "DROP TRIGGER audit_reject_password ON \"user\"").await;
    sql(&db, "DROP FUNCTION audit_reject_password()").await;
    assert_ne!(recovered["code"], 200, "{recovered}");
    assert_ne!(changed["code"], 200, "{changed}");
    assert_eq!(
        scalar(
            &db,
            "SELECT token_version::bigint FROM \"user\" WHERE id=910000021"
        )
        .await,
        0
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) FROM password_reset_token WHERE user_id=910000021 AND used_at IS NULL"
        )
        .await,
        1
    );
}

#[tokio::test]
async fn avatar_replacements_keep_new_file_and_use_distinct_names() {
    let Some(db) = connect().await else { return };
    user(&db, 910000031, "user").await;
    let root = std::env::temp_dir().join(format!("saudade-avatar-test-{}", uuid::Uuid::new_v4()));
    std::env::set_var("UPLOAD_DIR", &root);
    let router = app(Database::connect(std::env::var("TEST_PG_URL").unwrap())
        .await
        .unwrap());
    let mut urls = Vec::new();
    for n in 0..2 {
        let mut bytes = b"--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
        bytes.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes.push(n);
        bytes.extend_from_slice(b"\r\n--test-boundary--\r\n");
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/protected/profile/avatar")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=test-boundary",
                    )
                    .header(
                        "authorization",
                        format!(
                            "Bearer {}",
                            saudade_blog::auth_jwt::create_token(910000031, "user", 0)
                        ),
                    )
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["code"], 200, "{result}");
        urls.push(result["data"]["avatar"].as_str().unwrap().to_string());
    }
    assert_ne!(urls[0], urls[1]);
    let file = |url: &str| root.join("avatars").join(url.rsplit('/').next().unwrap());
    assert!(file(&urls[1]).exists());
    assert!(!file(&urls[0]).exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn history_image_budget_is_applied_before_fetching_payloads_on_postgres() {
    let Some(db) = connect().await else { return };
    user(&db, 910000041, "user").await;
    sql(
        &db,
        "INSERT INTO conversation (id,user_id) VALUES (910000041,910000041)",
    )
    .await;
    sql(&db,"INSERT INTO chat_history (id,user_id,conversation_id,role,content,created_at)
        SELECT 910000100+n,910000041,910000041,'user','[image]',CURRENT_TIMESTAMP FROM generate_series(0,49) n").await;
    sql(
        &db,
        "INSERT INTO chat_image (message_id,seq,data)
        SELECT 910000100+n,0,repeat('x',262144) FROM generate_series(0,49) n",
    )
    .await;
    let router = app(Database::connect(std::env::var("TEST_PG_URL").unwrap())
        .await
        .unwrap());
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/chat/history?conversation_id=910000041")
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        saudade_blog::auth_jwt::create_token(910000041, "user", 0)
                    ),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let rows = body["items"].as_array().unwrap();
    assert_eq!(rows.len(), 50);
    let with_images: Vec<_> = rows
        .iter()
        .filter(|r| !r["images"].as_array().unwrap().is_empty())
        .collect();
    assert_eq!(with_images.len(), 32);
    assert_eq!(with_images[0]["id"], 910000118);
    assert_eq!(with_images[31]["id"], 910000149);
    sql(
        &db,
        "DELETE FROM chat_history WHERE conversation_id=910000041",
    )
    .await;
    sql(&db, "DELETE FROM conversation WHERE id=910000041").await;
}

#[tokio::test]
async fn title_only_note_filter_preserves_visibility_and_summary_response() {
    let Some(db) = connect().await else { return };
    sql(&db, "DELETE FROM note WHERE id IN (910000501,910000502)").await;
    sql(&db,"INSERT INTO note (id,title,content,status,is_public,created_at,updated_at) VALUES
        (910000501,'audit-load-filter-public',repeat('large-body',10000),'public',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        (910000502,'audit-load-filter-private','secret','private',false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").await;
    let router = app(Database::connect(std::env::var("TEST_PG_URL").unwrap())
        .await
        .unwrap());
    let result = api(
        router,
        "/api/public/notes/search",
        None,
        json!({"title":"audit-load-filter"}),
    )
    .await;
    let rows = result["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{result}");
    assert_eq!(rows[0]["noteKey"], 910000501);
    assert_eq!(rows[0]["noteContent"], "");
    assert_eq!(rows[0]["content"], "");
    sql(&db, "DELETE FROM note WHERE id IN (910000501,910000502)").await;
}
