use super::*;
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, Statement,
    TransactionTrait,
};
use serde_json::{json, Value};
use std::time::Duration;

struct Fixture {
    db: DatabaseConnection,
    prefix: String,
    uid: i32,
    other_uid: i32,
    ids: Vec<i32>,
    folders: [i32; 2],
}

impl Fixture {
    async fn new(count: i32) -> Option<Self> {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            assert!(std::env::var_os("CI").is_none(), "CI requires TEST_PG_URL");
            return None;
        };
        let db = Database::connect(url).await.unwrap();
        let prefix = format!("gallery_bulk_{}", uuid::Uuid::new_v4().simple());
        let mut users = Vec::new();
        for suffix in ["owner", "other"] {
            let name = format!("{prefix}_{suffix}");
            let row = db
                .query_one(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "INSERT INTO \"user\"(username,nickname,password,role,status) \
                 VALUES($1,$1,'fixture','admin',0) RETURNING id",
                    vec![name.into()],
                ))
                .await
                .unwrap()
                .unwrap();
            users.push(row.try_get::<i32>("", "id").unwrap());
        }
        let mut folders = Vec::new();
        for suffix in ["a", "b"] {
            let row = db
                .query_one(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "INSERT INTO image_folder(name) VALUES($1) RETURNING id",
                    vec![format!("{prefix}_{suffix}").into()],
                ))
                .await
                .unwrap()
                .unwrap();
            folders.push(row.try_get::<i32>("", "id").unwrap());
        }
        let rows = db
            .query_all(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO images(image_url) SELECT $1 || n::text || '.png' \
             FROM generate_series(1,$2::int) AS n RETURNING image_key",
                vec![
                    format!("/api/protect/download/{prefix}_").into(),
                    count.into(),
                ],
            ))
            .await
            .unwrap();
        let mut ids: Vec<i32> = rows
            .iter()
            .map(|row| row.try_get("", "image_key").unwrap())
            .collect();
        ids.sort_unstable();
        Some(Self {
            db,
            prefix,
            uid: users[0],
            other_uid: users[1],
            ids,
            folders: [folders[0], folders[1]],
        })
    }

    async fn snapshot(&self) -> Vec<Value> {
        self.db.query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT i.image_key,i.image_url,m.display_name,COALESCE(m.description,'') AS description, \
             COALESCE(m.folder_id,0) AS folder_id,(m.image_id IS NOT NULL) AS has_metadata, \
             EXISTS(SELECT 1 FROM image_favorite f WHERE f.image_id=i.image_key AND f.user_id=$1) \
             AS favorite FROM images i LEFT JOIN image_metadata m ON m.image_id=i.image_key \
             WHERE i.image_url LIKE $2 ORDER BY i.image_key",
            vec![self.uid.into(), format!("%{}%", self.prefix).into()],
        )).await.unwrap().iter().map(|row| json!({
            "id": row.try_get::<i32>("", "image_key").unwrap(),
            "url": row.try_get::<String>("", "image_url").unwrap(),
            "name": row.try_get::<Option<String>>("", "display_name").unwrap(),
            "description": row.try_get::<String>("", "description").unwrap(),
            "folder": row.try_get::<i32>("", "folder_id").unwrap(),
            "hasMetadata": row.try_get::<bool>("", "has_metadata").unwrap(),
            "favorite": row.try_get::<bool>("", "favorite").unwrap(),
        })).collect()
    }

    async fn article(&self) -> i32 {
        self.db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO note(title,content,status,is_public,created_at,updated_at) \
             VALUES($1,'fixture','public',true,localtimestamp,localtimestamp) RETURNING id",
                vec![self.prefix.clone().into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "id")
            .unwrap()
    }

    async fn cleanup(self) {
        for sql in [
            "DELETE FROM note_comment WHERE note_id IN (SELECT id FROM note WHERE title=$1)",
            "DELETE FROM note WHERE title=$1",
            "DELETE FROM image_deletion WHERE image_id IN (SELECT image_key FROM images \
             WHERE position($1::text in image_url)>0)",
        ] {
            self.db
                .execute(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    sql,
                    vec![self.prefix.clone().into()],
                ))
                .await
                .unwrap();
        }
        self.db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM images WHERE image_url LIKE $1",
                vec![format!("%{}%", self.prefix).into()],
            ))
            .await
            .unwrap();
        self.db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM image_folder WHERE id=$1 OR id=$2",
                vec![self.folders[0].into(), self.folders[1].into()],
            ))
            .await
            .unwrap();
        self.db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM \"user\" WHERE id=$1 OR id=$2",
                vec![self.uid.into(), self.other_uid.into()],
            ))
            .await
            .unwrap();
        self.db.close().await.unwrap();
    }
}

fn intent(value: Value) -> Intent {
    serde_json::from_value(value).unwrap()
}

fn change(prepared: &Prepared) -> Change {
    Change {
        version: prepared.version.clone(),
        expires_at: prepared.expires_at,
        intent: prepared.intent.clone(),
    }
}

#[test]
fn gallery_intent_rejects_ambiguous_unbounded_and_unknown_fields() {
    for value in [
        json!({"action":"delete","imageIds":[]}),
        json!({"action":"delete","imageIds":[1,1]}),
        json!({"action":"delete","imageIds":[0]}),
        json!({"action":"delete","imageIds":[true]}),
        json!({"action":"delete","imageIds":[1],"all":true}),
        json!({"action":"move","imageIds":[1],"folderId":-1}),
        json!({"action":"move","imageIds":[1],"folderId":null}),
        json!({"action":"favorite","imageIds":[1],"isFavorite":1}),
        json!({"action":"metadata","items":[{"imageId":1,"changes":{}}]}),
        json!({"action":"metadata","items":[{"imageId":1,"changes":{"description":null}}]}),
        json!({"action":"metadata","items":[{"imageId":1,"changes":{"imageUrl":"x"}}]}),
        json!({"action":"metadata","items":[{"imageId":1,"changes":{"displayName":" "}}]}),
        json!({"action":"delete","imageIds":(1..=101).collect::<Vec<_>>()}),
        json!({"action":"metadata","items":[
            {"imageId":1,"changes":{"description":"猫".repeat(2000)}},
            {"imageId":2,"changes":{"description":"猫".repeat(2000)}}]}),
    ] {
        let accepted = serde_json::from_value::<Intent>(value.clone())
            .ok()
            .and_then(|input| input.normalize().ok());
        assert!(accepted.is_none(), "unexpectedly accepted: {value}");
    }
    let valid = intent(json!({"action":"favorite","imageIds":[2,1],"isFavorite":false}))
        .normalize()
        .unwrap();
    assert_eq!(valid.ids(), vec![1, 2]);
}

#[tokio::test]
async fn postgres_gallery_bulk_preparation_is_readonly_and_hundred_image_noop_is_verified() {
    let Some(f) = Fixture::new(100).await else {
        return;
    };
    let before = f.snapshot().await;
    let mut reversed = f.ids.clone();
    reversed.reverse();
    let prepared = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"favorite","imageIds":reversed,"isFavorite":true,
        })),
    )
    .await
    .unwrap();
    assert_eq!(f.snapshot().await, before);
    assert_eq!(prepared.matched_ids, f.ids);
    assert_eq!(prepared.intent.ids(), f.ids);
    assert_eq!(prepared.preview.len(), 10);
    assert!(prepared.preview_truncated);
    let applied = execute_change(&f.db, f.uid, change(&prepared))
        .await
        .unwrap();
    assert!(applied.changed);
    assert_eq!(applied.matched_ids, f.ids);
    assert_eq!(applied.changed_ids, f.ids);
    assert!(applied.cleanup_pending_ids.is_empty());
    assert!(f.snapshot().await.iter().all(|row| row["favorite"] == true));
    assert!(
        !super::super::read(&f.db, f.other_uid, f.ids[0])
            .await
            .unwrap()
            .is_favorite
    );
    assert!(execute_change(&f.db, f.uid, change(&prepared))
        .await
        .is_err());
    let fresh = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"favorite","imageIds":f.ids,"isFavorite":true,
        })),
    )
    .await
    .unwrap();
    let unchanged = execute_change(&f.db, f.uid, change(&fresh)).await.unwrap();
    assert!(!unchanged.changed);
    assert_eq!(unchanged.matched_ids, f.ids);
    assert!(unchanged.changed_ids.is_empty() && unchanged.cleanup_pending_ids.is_empty());
    f.cleanup().await;
}

#[tokio::test]
async fn postgres_gallery_bulk_metadata_keeps_urls_and_all_per_image_fields() {
    let Some(f) = Fixture::new(2).await else {
        return;
    };
    let before = f.snapshot().await;
    let prepared = prepare_change(
        &f.db,
        f.uid,
        intent(json!({"action":"metadata","items":[
            {"imageId":f.ids[1],"changes":{"description":"","folderId":f.folders[1]}},
            {"imageId":f.ids[0],"changes":{"displayName":"新名称","description":"完整描述",
                                         "folderId":f.folders[0],"isFavorite":true}},
        ]})),
    )
    .await
    .unwrap();
    assert_eq!(f.snapshot().await, before);
    assert!(prepared.destination.is_none());
    assert_eq!(prepared.intent.ids(), f.ids);
    let result = execute_change(&f.db, f.uid, change(&prepared))
        .await
        .unwrap();
    assert_eq!(result.changed_ids, f.ids);
    let after = f.snapshot().await;
    for index in 0..2 {
        assert_eq!(after[index]["url"], before[index]["url"]);
    }
    assert_eq!(after[0]["name"], "新名称");
    assert_eq!(after[0]["description"], "完整描述");
    assert_eq!(after[0]["folder"], f.folders[0]);
    assert_eq!(after[0]["favorite"], true);
    assert_eq!(after[1]["description"], "");
    assert_eq!(after[1]["folder"], f.folders[1]);
    assert_eq!(after[1]["favorite"], false);
    let unclassified = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"move","imageIds":f.ids,"folderId":0,
        })),
    )
    .await
    .unwrap();
    assert_eq!(unclassified.destination.as_ref().unwrap().id, 0);
    let moved = execute_change(&f.db, f.uid, change(&unclassified))
        .await
        .unwrap();
    assert_eq!(moved.changed_ids, f.ids);
    let mut expected = after.clone();
    for row in &mut expected {
        row["folder"] = json!(0);
    }
    assert_eq!(f.snapshot().await, expected);
    f.cleanup().await;
}

#[tokio::test]
async fn postgres_gallery_bulk_binds_actor_expiry_and_complete_fixed_selection() {
    let Some(f) = Fixture::new(2).await else {
        return;
    };
    let before = f.snapshot().await;
    let prepared = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"favorite","imageIds":f.ids,"isFavorite":true,
        })),
    )
    .await
    .unwrap();
    assert!(execute_change(&f.db, f.other_uid, change(&prepared))
        .await
        .is_err());
    let mut expired = change(&prepared);
    expired.expires_at = 1;
    assert!(execute_change(&f.db, f.uid, expired).await.is_err());
    let mut extended = change(&prepared);
    extended.expires_at += 3600;
    assert!(execute_change(&f.db, f.uid, extended).await.is_err());
    let mut narrowed = change(&prepared);
    narrowed.intent = intent(json!({"action":"favorite","imageIds":[f.ids[0]],"isFavorite":true}));
    assert!(execute_change(&f.db, f.uid, narrowed).await.is_err());
    assert_eq!(f.snapshot().await, before);
    f.db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "DELETE FROM images WHERE image_key=$1",
        vec![f.ids[1].into()],
    ))
    .await
    .unwrap();
    assert!(execute_change(&f.db, f.uid, change(&prepared))
        .await
        .is_err());
    let after = f.snapshot().await;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0], before[0]);
    f.cleanup().await;
}

#[tokio::test]
async fn postgres_gallery_bulk_stale_image_and_destination_changes_block_every_item() {
    let Some(f) = Fixture::new(2).await else {
        return;
    };
    let prepared = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"metadata","items":[
                {"imageId":f.ids[0],"changes":{"description":"first"}},
                {"imageId":f.ids[1],"changes":{"description":"second"}},
            ],
        })),
    )
    .await
    .unwrap();
    f.db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO image_metadata(image_id,description) VALUES($1,'external')",
        vec![f.ids[1].into()],
    ))
    .await
    .unwrap();
    let external = f.snapshot().await;
    assert!(execute_change(&f.db, f.uid, change(&prepared))
        .await
        .is_err());
    assert_eq!(f.snapshot().await, external);
    let moved = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"move","imageIds":f.ids,"folderId":f.folders[0],
        })),
    )
    .await
    .unwrap();
    f.db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE image_folder SET name=name || '_changed' WHERE id=$1",
        vec![f.folders[0].into()],
    ))
    .await
    .unwrap();
    assert!(execute_change(&f.db, f.uid, change(&moved)).await.is_err());
    assert_eq!(f.snapshot().await, external);
    let missing_folder = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"metadata","items":[
                {"imageId":f.ids[0],"changes":{"description":"first"}},
                {"imageId":f.ids[1],"changes":{"folderId":i32::MAX}},
            ],
        })),
    )
    .await;
    assert!(missing_folder.is_err());
    assert_eq!(f.snapshot().await, external);
    f.cleanup().await;
}

#[tokio::test]
async fn postgres_gallery_bulk_database_failure_rolls_back_earlier_changes() {
    let Some(f) = Fixture::new(2).await else {
        return;
    };
    let prepared = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"metadata","items":[
                {"imageId":f.ids[0],"changes":{"description":"first"}},
                {"imageId":f.ids[1],"changes":{"description":"second"}},
            ],
        })),
    )
    .await
    .unwrap();
    let before = f.snapshot().await;
    let name = format!("bulk_fail_{}", uuid::Uuid::new_v4().simple());
    for sql in [
        format!(
            "CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ \
                 BEGIN RAISE EXCEPTION 'isolated gallery fixture failure'; END; $$"
        ),
        format!(
            "CREATE TRIGGER {name} BEFORE INSERT OR UPDATE ON image_metadata \
                 FOR EACH ROW WHEN (NEW.image_id={}) EXECUTE FUNCTION {name}()",
            f.ids[1]
        ),
    ] {
        f.db.execute(Statement::from_string(DatabaseBackend::Postgres, sql))
            .await
            .unwrap();
    }
    let result = execute_change(&f.db, f.uid, change(&prepared)).await;
    f.db.execute(Statement::from_string(
        DatabaseBackend::Postgres,
        format!("DROP TRIGGER {name} ON image_metadata"),
    ))
    .await
    .unwrap();
    f.db.execute(Statement::from_string(
        DatabaseBackend::Postgres,
        format!("DROP FUNCTION {name}()"),
    ))
    .await
    .unwrap();
    assert!(result.is_err());
    assert_eq!(f.snapshot().await, before);
    f.cleanup().await;
}

async fn isolated_connection() -> (DatabaseConnection, i32) {
    let mut options = ConnectOptions::new(std::env::var("TEST_PG_URL").unwrap());
    options.max_connections(1).min_connections(1);
    let db = Database::connect(options).await.unwrap();
    let pid = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT pg_backend_pid() AS pid".to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    (db, pid)
}

async fn wait_for_block(db: &DatabaseConnection, waiter: i32, holder: i32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let blocked: bool = db
                .query_one(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
                    vec![waiter.into(), holder.into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get("", "blocked")
                .unwrap();
            if blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the competing transaction must actually wait on the reference fence");
}

#[tokio::test]
async fn postgres_gallery_comment_commit_before_delete_blocks_the_entire_deletion() {
    let Some(f) = Fixture::new(1).await else {
        return;
    };
    let note = f.article().await;
    let image = super::super::read(&f.db, f.uid, f.ids[0]).await.unwrap();
    let prepared = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"delete","imageIds":f.ids,
        })),
    )
    .await
    .unwrap();
    let comment = f.db.begin().await.unwrap();
    let holder = comment
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT pg_backend_pid() AS pid".to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let text = format!("![fixture]({})", image.image_url);
    references::guard_texts(&comment, &[&text]).await.unwrap();
    comment
        .execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO note_comment(note_id,user_id,content) VALUES($1,$2,$3)",
            vec![note.into(), f.uid.into(), text.into()],
        ))
        .await
        .unwrap();
    let (worker, waiter) = isolated_connection().await;
    let uid = f.uid;
    let input = change(&prepared);
    let task = tokio::spawn(async move {
        let result = execute_change(&worker, uid, input).await;
        worker.close().await.unwrap();
        result
    });
    wait_for_block(&f.db, waiter, holder).await;
    comment.commit().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, Err(ActionError::Referenced(_))));
    assert!(super::super::read(&f.db, f.uid, f.ids[0]).await.is_ok());
    let tombstone =
        f.db.query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT image_id FROM image_deletion WHERE image_id=$1",
            vec![f.ids[0].into()],
        ))
        .await
        .unwrap();
    assert!(tombstone.is_none());
    f.cleanup().await;
}

#[tokio::test]
async fn postgres_gallery_delete_commit_before_comment_rejects_the_new_reference() {
    let Some(f) = Fixture::new(1).await else {
        return;
    };
    let note = f.article().await;
    let image = super::super::read(&f.db, f.uid, f.ids[0]).await.unwrap();
    let prepared = prepare_change(
        &f.db,
        f.uid,
        intent(json!({
            "action":"delete","imageIds":f.ids,
        })),
    )
    .await
    .unwrap();
    let deletion = f.db.begin().await.unwrap();
    let holder = deletion
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT pg_backend_pid() AS pid".to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    let planned = plan::build(
        &deletion,
        f.uid,
        prepared.intent.clone(),
        prepared.expires_at,
        true,
    )
    .await
    .unwrap();
    assert_eq!(planned.prepared.version, prepared.version);
    let outcome = changes::apply(&deletion, f.uid, planned, &prepared.version)
        .await
        .unwrap();
    assert_eq!(outcome.cleanup_pending_ids, f.ids);
    let (worker, waiter) = isolated_connection().await;
    let uid = f.uid;
    let text = format!("![fixture]({})", image.image_url);
    let task = tokio::spawn(async move {
        let transaction = worker.begin().await.unwrap();
        let result = async {
            references::guard_texts(&transaction, &[&text]).await?;
            transaction
                .execute(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "INSERT INTO note_comment(note_id,user_id,content) VALUES($1,$2,$3)",
                    vec![note.into(), uid.into(), text.into()],
                ))
                .await?;
            Ok::<_, sea_orm::DbErr>(())
        }
        .await;
        if result.is_ok() {
            transaction.commit().await.unwrap();
        } else {
            transaction.rollback().await.unwrap();
        }
        worker.close().await.unwrap();
        result
    });
    wait_for_block(&f.db, waiter, holder).await;
    deletion.commit().await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    let comments =
        f.db.query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT count(*) AS count FROM note_comment WHERE note_id=$1",
            vec![note.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "count")
        .unwrap();
    assert_eq!(comments, 0);
    assert!(super::super::read(&f.db, f.uid, f.ids[0]).await.is_err());
    f.cleanup().await;
}

#[tokio::test]
async fn postgres_gallery_batch_http_uses_admin_auth_and_real_transaction_routes() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let Some(f) = Fixture::new(1).await else {
        return;
    };
    f.db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET role='user' WHERE id=$1",
        [f.other_uid.into()],
    ))
    .await
    .unwrap();
    let app = crate::routes::create_router(crate::routes::AppState {
        db: f.db.clone(),
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
        post_limiter: crate::risk::PostRateLimiter::default(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    });
    let body = json!({"action":"favorite","imageIds":f.ids,"isFavorite":true}).to_string();
    let token = crate::auth_jwt::create_token(f.uid, "admin", 0);
    let request = |path: &str, token: Option<&str>, body: String| {
        let mut builder = Request::post(path).header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        builder.body(Body::from(body)).unwrap()
    };
    let url = "/api/protect/gallery/image-actions/prepare";
    assert_eq!(
        app.clone()
            .oneshot(request(url, None, body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let user = crate::auth_jwt::create_token(f.other_uid, "admin", 0);
    assert_eq!(
        app.clone()
            .oneshot(request(url, Some(&user), body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = app
        .clone()
        .oneshot(request(url, Some(&token), body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(data["data"]["matchedIds"], json!(f.ids));
    assert!(
        !super::super::read(&f.db, f.uid, f.ids[0])
            .await
            .unwrap()
            .is_favorite
    );
    let prepared = &data["data"];
    let response = app.oneshot(request("/api/protect/gallery/image-actions", Some(&token),
        json!({"version":prepared["version"],"expiresAt":prepared["expiresAt"],"intent":prepared["intent"]}).to_string())).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(data["data"]["changedIds"], json!(f.ids));
    assert!(
        super::super::read(&f.db, f.uid, f.ids[0])
            .await
            .unwrap()
            .is_favorite
    );
    f.cleanup().await;
}
