//! Isolated PostgreSQL search pagination, visibility and literal matching checks.
use axum::{extract::State, http::HeaderMap, Json};
use saudade_blog::{routes::search, AppState};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    TransactionTrait,
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
                eprintln!("SKIP search_upgrade: TEST_PG_URL 未设置（未执行 PostgreSQL 验证）");
                return None;
            }
        };
        let admin = Database::connect(url.clone())
            .await
            .expect("TEST_PG_URL 无法连接");
        let schema = format!("search_{}", uuid::Uuid::new_v4().simple());
        sql(&admin, &format!("CREATE SCHEMA {schema}")).await;
        for table in [
            "user",
            "web_info",
            "note",
            "talk",
            "note_comment",
            "note_tag",
            "tag_one",
            "tag_two",
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

async fn search(ctx: &Context, payload: Value) -> Value {
    let response = search::search_all(
        State(ctx.state.clone()),
        HeaderMap::new(),
        Json(serde_json::from_value(payload).unwrap()),
    )
    .await;
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
#[tokio::test]
async fn chinese_paging_counts_excerpts_and_visibility_share_one_policy() {
    let Some(ctx) = Context::new().await else {
        return;
    };
    let db = &ctx.state.db;
    sql(db, "INSERT INTO note(id,title,content,status,is_public,created_at,updated_at) SELECT id,'博客手册',repeat('前言',100)||'部署步骤','published',true,'2026-01-01','2026-01-01' FROM generate_series(1,23) id").await;
    sql(db, "INSERT INTO note(id,title,content,status,is_public,draft_of,created_at,updated_at) VALUES (30,'博客部署','禁止泄漏','draft',false,NULL,now(),now()),(31,'博客部署','禁止泄漏','published',false,NULL,now(),now()),(32,'博客部署','禁止泄漏','published',true,1,now(),now())").await;
    sql(db, "INSERT INTO talk(id,title,content,src,approved,author,created_at,updated_at) VALUES (1,'博客部署','无关正文','board',1,'署名',now(),now()),(2,'博客部署','博客部署','talk',0,'署名',now(),now()),(3,'','博客部署','board',1,'河灯署名',now(),now())").await;
    sql(db, "INSERT INTO note_comment(id,note_id,user_id,content,approved,is_deleted) VALUES (1,1,1,'无关评论',1,0),(2,30,1,'博客部署',1,0),(3,1,1,'博客部署',0,0),(4,1,1,'博客部署',1,1),(5,1,1,'博客部署',1,0)").await;
    sql(db, "INSERT INTO note(id,title,content,created_at,updated_at) VALUES (24,'博客博客博客博客','只有部分命中',now(),now())").await;
    let first = search(&ctx, json!({"keyword":"博客部署","pageSize":5})).await;
    assert_eq!(first["code"], 200, "{first}");
    let data = &first["data"];
    assert_eq!(
        data["counts"],
        json!({"note":23,"talk":0,"board":1,"comment":1})
    );
    assert_eq!(data["total"], 25);
    assert_eq!(data["hasMore"], true);
    let rows = data["notes"].as_array().unwrap();
    assert_eq!(rows.len(), 5);
    assert!(rows[0]["snippet"].as_str().unwrap().contains("部署"));
    assert!(rows[0]["snippet"].as_str().unwrap().starts_with('…'));
    let spaced = search(&ctx, json!({"keyword":"博客 部署","pageSize":5})).await;
    assert_eq!(data["counts"], spaced["data"]["counts"]);
    let second = search(&ctx, json!({"keyword":"博客部署","pageSize":5,"page":2})).await;
    let next = second["data"]["notes"].as_array().unwrap();
    assert_eq!(next.len(), 5);
    assert!(next
        .iter()
        .all(|row| !rows.iter().any(|old| old["key"] == row["key"])));
    let last = search(&ctx, json!({"keyword":"博客部署","pageSize":5,"page":6})).await;
    assert_eq!(last["data"]["total"], 25);
    assert_eq!(last["data"]["hasMore"], false);
    assert_eq!(last["data"]["notes"], json!([]));
    let board = search(&ctx, json!({"keyword":"博客部署","type":"board"})).await;
    assert_eq!(board["data"]["board"][0]["author"], "河灯署名");
    assert_eq!(board["data"]["board"][0]["title"], "");
    assert_eq!(board["data"]["total"], 25);
    let comment = search(&ctx, json!({"keyword":"博客部署","type":"comment"})).await;
    assert_eq!(comment["data"]["comments"].as_array().unwrap().len(), 1);
    assert_eq!(comment["data"]["comments"][0]["key"], 5);
    sql(db, "INSERT INTO note(id,title,content,created_at,updated_at) VALUES (40,'Literal 100% a_b','z:\\srch',now(),now()),(41,'Literal 1000 axb','no',now(),now())").await;
    let literal = search(&ctx, json!({"keyword":"100% a_b"})).await;
    assert_eq!(literal["data"]["counts"]["note"], 1, "{literal}");
    assert_eq!(literal["data"]["notes"][0]["key"], 40);
    let partial = search(&ctx, json!({"keyword":"博客 数据库","pageSize":50})).await;
    assert_eq!(partial["data"]["counts"]["note"], 24);
    assert_eq!(partial["data"]["notes"][0]["key"], 24);
    let lock = db.begin().await.unwrap();
    lock.execute_unprepared("LOCK TABLE note IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let timeout = search(&ctx, json!({"keyword":"博客部署"})).await;
    assert_ne!(timeout["code"], 200, "{timeout}");
    assert!(!timeout.to_string().contains("statement_timeout"));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    lock.rollback().await.unwrap();
    assert_eq!(
        search(&ctx, json!({"keyword":"博客部署"})).await["code"],
        200
    );
    ctx.close().await;
}
