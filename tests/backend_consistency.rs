//! 故障注入使用每个测试独立的 schema、连接池和触发器，不改共享表或进程环境。
//! TEST_PG_URL 必须显式指向测试库；CI 提供该变量，连接失败必须失败。
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use saudade_blog::{
    entity::web_info,
    routes::{announcements, quota, web_info as settings},
    AppState,
};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use serde_json::{json, Value};
use std::sync::Arc;

struct Context {
    admin: DatabaseConnection,
    state: Arc<AppState>,
    schema: String,
}
impl Context {
    async fn new() -> Option<Self> {
        let url = match std::env::var("TEST_PG_URL") {
            Ok(url) => url,
            Err(_) => {
                eprintln!("SKIP backend_consistency: TEST_PG_URL 未设置（未执行 PostgreSQL 验证）");
                return None;
            }
        };
        let admin = Database::connect(url.clone())
            .await
            .expect("TEST_PG_URL 无法连接");
        let schema = format!("consistency_{}", uuid::Uuid::new_v4().simple());
        sql(&admin, &format!("CREATE SCHEMA {schema}")).await;
        for table in [
            "user",
            "web_info",
            "quota_request",
            "user_notification",
            "announcement",
        ] {
            sql(
                &admin,
                &format!(
                    "CREATE TABLE {schema}.\"{table}\" (LIKE public.\"{table}\" INCLUDING ALL)"
                ),
            )
            .await;
        }
        let mut opts = ConnectOptions::new(url);
        opts.max_connections(3)
            .set_schema_search_path(schema.clone());
        let db = Database::connect(opts).await.unwrap();
        let state = Arc::new(AppState {
            db,
            rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 300, 900),
            post_limiter: saudade_blog::risk::PostRateLimiter::new(),
            report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
        });
        Some(Self {
            admin,
            state,
            schema,
        })
    }
    async fn close(self) {
        sql(&self.admin, &format!("DROP SCHEMA {} CASCADE", self.schema)).await;
    }
}
async fn sql(db: &DatabaseConnection, sql: &str) {
    db.execute(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap();
}
async fn count(db: &DatabaseConnection, sql: &str) -> i64 {
    db.query_one(Statement::from_string(DbBackend::Postgres, sql.to_string()))
        .await
        .unwrap()
        .unwrap()
        .try_get_by_index(0)
        .unwrap()
}
fn value<T: serde::Serialize>(response: Json<T>) -> Value {
    serde_json::to_value(response.0).unwrap()
}

#[tokio::test]
async fn settings_batch_rolls_back_and_both_write_paths_report_errors() {
    let Some(ctx) = Context::new().await else {
        return;
    };
    let db = &ctx.state.db;
    sql(
        db,
        "INSERT INTO web_info(key_name,value) VALUES ('author','before'),('blog_title','before')",
    )
    .await;
    sql(db, "CREATE FUNCTION reject_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key_name IN ('blog_title','socialQQ') THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$").await;
    sql(db, "CREATE TRIGGER reject_settings BEFORE INSERT OR UPDATE ON web_info FOR EACH ROW EXECUTE FUNCTION reject_settings()").await;
    let payload =
        serde_json::from_value(json!({"blogAuthor":"after", "blogTitle":"after"})).unwrap();
    let result = value(settings::update_web_info(State(ctx.state.clone()), Json(payload)).await);
    assert_ne!(result["code"], 200, "{result}");
    assert_eq!(
        count(db, "SELECT count(*) FROM web_info WHERE value='before'").await,
        2
    );
    let payload = serde_json::from_value(json!({"socialGithub":"new", "socialQQ":"new", "socialWechat":"", "socialBilibili":"", "socialEmail":""})).unwrap();
    let result = value(settings::update_social_info(State(ctx.state.clone()), Json(payload)).await);
    assert_ne!(result["code"], 200, "{result}");
    assert_eq!(count(db, "SELECT count(*) FROM web_info").await, 2);
    sql(db, "DROP TRIGGER reject_settings ON web_info").await;
    for _ in 0..2 {
        let payload =
            serde_json::from_value(json!({"blogAuthor":"after", "blogTitle":"after"})).unwrap();
        let result =
            value(settings::update_web_info(State(ctx.state.clone()), Json(payload)).await);
        assert_eq!(result["code"], 200, "{result}");
    }
    assert_eq!(
        count(db, "SELECT count(*) FROM web_info WHERE value='after'").await,
        2
    );
    ctx.close().await;
}

#[tokio::test]
async fn failed_announcement_insert_returns_error_and_emits_no_notification() {
    let Some(ctx) = Context::new().await else {
        return;
    };
    let db = &ctx.state.db;
    sql(db, "CREATE FUNCTION reject_announcement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$").await;
    sql(db, "CREATE TRIGGER reject_announcement BEFORE INSERT ON announcement FOR EACH ROW EXECUTE FUNCTION reject_announcement()").await;
    let result = value(
        announcements::create_announcement(
            State(ctx.state.clone()),
            Json(announcements::UpsertAnnouncement {
                title: "test".into(),
                content: "test".into(),
            }),
        )
        .await,
    );
    assert_ne!(result["code"], 200, "{result}");
    assert_eq!(count(db, "SELECT count(*) FROM announcement").await, 0);
    assert_eq!(count(db, "SELECT count(*) FROM user_notification").await, 0);
    sql(db, "DROP TRIGGER reject_announcement ON announcement").await;
    let result = value(
        announcements::create_announcement(
            State(ctx.state.clone()),
            Json(announcements::UpsertAnnouncement {
                title: "test".into(),
                content: "test".into(),
            }),
        )
        .await,
    );
    assert_eq!(result["code"], 200, "{result}");
    assert_eq!(
        count(
            db,
            "SELECT count(*) FROM announcement WHERE created_at IS NOT NULL"
        )
        .await,
        1
    );
    ctx.close().await;
}

#[tokio::test]
async fn quota_failure_rolls_back_claim_then_concurrent_retry_commits_once() {
    let Some(ctx) = Context::new().await else {
        return;
    };
    let db = &ctx.state.db;
    sql(db, "INSERT INTO \"user\"(id,username,password,role,chat_quota_used) VALUES (1,'operator','unused','admin',0),(2,'applicant','unused','user',40)").await;
    sql(
        db,
        "INSERT INTO quota_request(id,user_id,status) VALUES (1,2,0)",
    )
    .await;
    sql(db, "CREATE FUNCTION reject_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$").await;
    sql(db, "CREATE TRIGGER reject_quota BEFORE UPDATE OF chat_quota_used ON \"user\" FOR EACH ROW EXECUTE FUNCTION reject_quota()").await;
    let approve = || async {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!(
                "Bearer {}",
                saudade_blog::auth_jwt::create_token(1, "admin", 0)
            )
            .parse()
            .unwrap(),
        );
        value(
            quota::review_quota_request(
                State(ctx.state.clone()),
                headers,
                Path(1),
                Json(quota::ReviewQuotaReq {
                    approved: true,
                    reason: None,
                }),
            )
            .await,
        )
    };
    let failed = approve().await;
    assert_ne!(failed["code"], 200, "{failed}");
    assert_eq!(
        count(
            db,
            "SELECT count(*) FROM quota_request WHERE status=0 AND handled_at IS NULL"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            db,
            "SELECT chat_quota_used::bigint FROM \"user\" WHERE id=2"
        )
        .await,
        40
    );
    assert_eq!(count(db, "SELECT count(*) FROM user_notification").await, 0);
    sql(db, "DROP TRIGGER reject_quota ON \"user\"").await;
    let (a, b) = tokio::join!(approve(), approve());
    assert_eq!(
        [&a, &b].iter().filter(|v| v["code"] == 200).count(),
        1,
        "{a}; {b}"
    );
    assert_eq!(
        count(
            db,
            "SELECT count(*) FROM quota_request WHERE status=1 AND handled_by=1"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            db,
            "SELECT chat_quota_used::bigint FROM \"user\" WHERE id=2"
        )
        .await,
        0
    );
    assert_eq!(
        count(db, "SELECT count(*) FROM user_notification WHERE user_id=2").await,
        1
    );
    ctx.close().await;
}

#[tokio::test]
async fn review_switch_read_errors_and_invalid_values_never_mean_disabled() {
    use sea_orm::{DatabaseBackend, DbErr, MockDatabase};
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("injected query failure".into())])
        .into_connection();
    assert!(settings::review_switches(&db).await.is_err());
    for keys in [settings::BOARD_REVIEW_KEYS, settings::COMMENT_REVIEW_KEYS] {
        for (value, expected) in [
            (None, Some((false, false))),
            (Some("true"), Some((true, false))),
            (Some("invalid"), None),
        ] {
            let rows: Vec<web_info::Model> = value
                .into_iter()
                .map(|v| web_info::Model {
                    id: 1,
                    key_name: keys.0.to_string(),
                    value: v.into(),
                })
                .collect();
            let db = MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results([rows])
                .into_connection();
            let result = settings::review_switches_of(&db, keys.0, keys.1).await;
            match expected {
                Some(pair) => assert_eq!(result.unwrap(), pair),
                None => assert!(result.is_err()),
            }
        }
    }
}
