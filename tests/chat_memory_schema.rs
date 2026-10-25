//! Apply the real provenance migration in an isolated, disposable PostgreSQL schema.
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};

async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

async fn count(db: &DatabaseConnection, statement: &str) -> i64 {
    db.query_one(Statement::from_string(DbBackend::Postgres, statement))
        .await
        .unwrap()
        .unwrap()
        .try_get_by_index(0)
        .unwrap()
}

#[tokio::test]
async fn provenance_migration_is_repeatable_and_preserves_unknown_sources() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("SKIP chat_memory_schema: TEST_PG_URL 未设置（未执行 PostgreSQL 验证）");
        return;
    };
    let admin = Database::connect(url.clone())
        .await
        .expect("TEST_PG_URL 无法连接");
    let schema = format!("chat_memory_schema_{}", uuid::Uuid::new_v4().simple());
    sql(&admin, &format!("CREATE SCHEMA {schema}")).await;
    let mut options = ConnectOptions::new(url);
    options
        .max_connections(1)
        .set_schema_search_path(schema.clone());
    let db = Database::connect(options).await.unwrap();
    sql(
        &db,
        "CREATE TABLE chat_history (id integer PRIMARY KEY, user_id integer NOT NULL, conversation_id integer NOT NULL);
         CREATE TABLE chat_summary (id integer PRIMARY KEY, user_id integer NOT NULL, conversation_id integer NOT NULL);
         INSERT INTO chat_history VALUES (1, 1, 1);
         INSERT INTO chat_summary VALUES (1, 1, 1)",
    )
    .await;
    let migration = include_str!("../scripts/migration/pg/0018_chat_memory_source_role.sql");
    sql(&db, migration).await;
    for (index, role) in saudade_blog::authz::KNOWN_ROLES.iter().enumerate() {
        for table in ["chat_history", "chat_summary"] {
            sql(
                &db,
                &format!(
                    "INSERT INTO {table}(id, user_id, conversation_id, source_role) VALUES ({}, 1, 1, '{role}')",
                    index + 2
                ),
            )
            .await;
        }
    }
    sql(&db, migration).await;
    for table in ["chat_history", "chat_summary"] {
        assert_eq!(
            count(
                &db,
                &format!("SELECT count(*) FROM {table} WHERE source_role IS NULL")
            )
            .await,
            1,
            "legacy rows keep unknown provenance after repeated migrations"
        );
        assert_eq!(
            count(
                &db,
                &format!("SELECT count(*) FROM {table} WHERE source_role IS NOT NULL")
            )
            .await,
            4,
            "reapplying the migration preserves recorded roles"
        );
        for invalid in ["", "SuperAdmin", "unknown"] {
            assert!(db
                .execute_unprepared(&format!(
                    "INSERT INTO {table}(id, user_id, conversation_id, source_role) VALUES (20, 1, 1, '{invalid}')"
                ))
                .await
                .is_err());
        }
    }
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM pg_index WHERE indexrelid = 'idx_chat_history_source_cursor'::regclass AND indisvalid AND indpred IS NOT NULL"
        ).await,
        1
    );
    db.close().await.unwrap();
    sql(&admin, &format!("DROP SCHEMA {schema} CASCADE")).await;
    admin.close().await.unwrap();
}
