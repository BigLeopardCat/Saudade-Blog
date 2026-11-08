//! Real HTTP + PostgreSQL + loopback S3; no external storage credentials or services.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures::FutureExt;
use saudade_blog::{auth_jwt, create_router, routes::gallery::transfers, AppState};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend,
    SqlxPostgresConnector, Statement,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const IMAGE: &[u8] = b"\x89PNG\r\n\x1a\nstorage-e2e";
const TRANSFERS: &str = "/api/protect/gallery/transfers";

#[derive(Clone, Default)]
struct S3(Arc<Mutex<S3Data>>);
#[derive(Default)]
struct S3Data {
    objects: BTreeMap<String, Bytes>,
    calls: Vec<(String, String)>,
    reject_put: bool,
}
impl S3 {
    // Public redirect reads are counted separately from authenticated provider I/O.
    fn counts(&self) -> [usize; 5] {
        let state = self.0.lock().unwrap();
        let mut counts = [0; 5];
        for (method, path) in &state.calls {
            if path.starts_with("/public/") {
                continue;
            }
            let index = match method.as_str() {
                "LIST" => 0,
                "HEAD" => 1,
                "GET" => 2,
                "PUT" => 3,
                "DELETE" => 4,
                _ => panic!("unexpected S3 method: {method}"),
            };
            counts[index] += 1;
        }
        counts
    }
    fn objects(&self) -> BTreeMap<String, Bytes> {
        self.0.lock().unwrap().objects.clone()
    }
}

async fn s3_request(State(s3): State<S3>, request: Request<Body>) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let public = path.starts_with("/public/");
    let listing = method == Method::GET && matches!(path.as_str(), "/images" | "/images/");
    if !public {
        assert!(request.headers()["authorization"]
            .to_str()
            .unwrap()
            .starts_with("AWS4-HMAC-SHA256 Credential=storage-e2e/"));
    }
    let body = axum::body::to_bytes(request.into_body(), 1024)
        .await
        .unwrap();
    let mut state = s3.0.lock().unwrap();
    state.calls.push((
        if listing {
            "LIST".into()
        } else {
            method.to_string()
        },
        path.clone(),
    ));
    if listing {
        let contents = state.objects.iter().map(|(key, value)| format!(
            "<Contents><Key>{key}</Key><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>fixture</ETag><Size>{}</Size></Contents>", value.len()
        )).collect::<String>();
        return (StatusCode::OK, [("content-type", "application/xml")], format!(
            "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>images</Name>{contents}<IsTruncated>false</IsTruncated></ListBucketResult>"
        )).into_response();
    }
    let key = path
        .strip_prefix(if public { "/public/" } else { "/images/" })
        .expect("unexpected S3 path");
    match method {
        Method::PUT if state.reject_put => (
            StatusCode::FORBIDDEN,
            [("content-type", "application/xml")],
            "<Error><Code>AccessDenied</Code><Message>fixture rejects writes</Message></Error>",
        )
            .into_response(),
        Method::PUT => {
            assert_eq!(&body[..], IMAGE);
            state.objects.insert(key.into(), body);
            (StatusCode::OK, [("etag", "\"fixture\"")]).into_response()
        }
        Method::GET | Method::HEAD => match state.objects.get(key) {
            Some(body) => (
                StatusCode::OK,
                [
                    ("etag", "\"fixture\"".to_owned()),
                    ("last-modified", "Thu, 01 Jan 2026 00:00:00 GMT".to_owned()),
                    ("content-type", "image/png".to_owned()),
                    ("content-length", body.len().to_string()),
                ],
                if method == Method::HEAD {
                    Bytes::new()
                } else {
                    body.clone()
                },
            )
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        Method::DELETE => {
            state.objects.remove(key);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

struct Server {
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn start(router: Router) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self { url, task }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Fixture {
    admin: DatabaseConnection,
    db: DatabaseConnection,
    schema: String,
    root: PathBuf,
    app: Server,
    provider: Server,
    s3: S3,
    client: reqwest::Client,
    token: String,
}
impl Fixture {
    async fn new(url: String) -> Self {
        let admin = Database::connect(url.clone())
            .await
            .expect("TEST_PG_URL connection");
        let schema = format!("storage_e2e_{}", uuid::Uuid::new_v4().simple());
        execute(&admin, &format!("CREATE SCHEMA {schema}"), vec![]).await;
        // Clone the CI migration fixture, as in backend_consistency.rs; never change public rows.
        for table in [
            "user",
            "web_info",
            "images",
            "image_metadata",
            "image_folder",
            "image_favorite",
            "image_location",
            "image_deletion",
            "image_transfer",
            "note",
            "note_comment",
            "announcement",
            "talk",
            "knowledge_base",
            "user_notification",
            "user_message",
            "user_message_draft",
        ] {
            execute(
                &admin,
                &format!(
                    "CREATE TABLE {schema}.\"{table}\" (LIKE public.\"{table}\" INCLUDING ALL)"
                ),
                vec![],
            )
            .await;
        }
        let mut options = ConnectOptions::new(url);
        options
            .max_connections(4)
            .connect_timeout(Duration::from_secs(5))
            .set_schema_search_path(schema.clone());
        let db = Database::connect(options).await.unwrap();
        let root = std::env::temp_dir().join(&schema);
        tokio::fs::create_dir(&root).await.unwrap();
        let s3 = S3::default();
        let provider = Server::start(
            Router::new()
                .fallback(any(s3_request))
                .with_state(s3.clone()),
        )
        .await;
        // This integration binary owns its process environment and runs one sequential scenario.
        std::env::set_var("UPLOAD_DIR", &root);
        std::env::set_var("JWT_SECRET", "storage-e2e-isolated-test-secret");
        std::env::set_var("R2_IMAGE_ENDPOINT", &provider.url);
        std::env::set_var("R2_IMAGE_ACCESS_KEY", "storage-e2e");
        std::env::set_var("R2_IMAGE_SECRET_KEY", "storage-e2e-synthetic-secret");
        for (key, value) in [
            ("r2ImageBucket", "images".to_owned()),
            ("r2ImagePrefix", "gallery".to_owned()),
            ("r2ImagePublicBase", format!("{}/public", provider.url)),
            ("r2ImageQuotaGB", "1".to_owned()),
            ("r2ImageEnabled", "true".to_owned()),
        ] {
            execute(
                &db,
                "INSERT INTO web_info(key_name,value) VALUES($1,$2)",
                vec![key.into(), value.into()],
            )
            .await;
        }
        let user = row(&db, "INSERT INTO \"user\"(username,nickname,password,role,status) VALUES('storage-e2e','storage-e2e','unused','admin',0) RETURNING id", vec![]).await;
        let uid: i32 = user.try_get("", "id").unwrap();
        let app = Server::start(create_router(AppState {
            db: SqlxPostgresConnector::from_sqlx_postgres_pool(
                db.get_postgres_connection_pool().clone(),
            ),
            rate_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(5, 60, 300),
            post_limiter: saudade_blog::risk::PostRateLimiter::new(),
            report_limiter: saudade_blog::rate_limiter::LoginRateLimiter::new(120, 60, 300),
        }))
        .await;
        Self {
            admin,
            db,
            schema,
            root,
            app,
            provider,
            s3,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            token: auth_jwt::create_token(uid, "admin", 0),
        }
    }
    async fn api(&self, method: Method, path: &str, body: Option<&Value>) -> Value {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.app.url))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let response: Value = response.json().await.unwrap();
        assert_eq!(response["code"], 200, "{path}: {response}");
        response["data"].clone()
    }
    async fn image(&self, id: i32) -> Value {
        self.api(
            Method::GET,
            &format!("/api/protect/gallery/images/{id}"),
            None,
        )
        .await
    }
    async fn seed(&self, name: &str) -> i32 {
        tokio::fs::write(self.root.join(name), IMAGE).await.unwrap();
        row(
            &self.db,
            "INSERT INTO images(image_url) VALUES($1) RETURNING image_key",
            vec![format!("/api/protect/download/{name}").into()],
        )
        .await
        .try_get("", "image_key")
        .unwrap()
    }
    async fn catalogue(&self) -> Value {
        row(&self.db, "SELECT jsonb_build_object('images',(SELECT jsonb_agg(i ORDER BY image_key) FROM images i),'metadata',(SELECT jsonb_agg(m ORDER BY image_id) FROM image_metadata m),'locations',(SELECT jsonb_agg(l ORDER BY image_id) FROM image_location l),'jobs',(SELECT jsonb_agg(j ORDER BY id) FROM image_transfer j),'notes',(SELECT jsonb_agg(n ORDER BY id) FROM note n)) AS snapshot", vec![]).await.try_get("", "snapshot").unwrap()
    }
    async fn files(&self) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut entries = tokio::fs::read_dir(&self.root).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            files.insert(
                entry.file_name().to_str().unwrap().to_owned(),
                tokio::fs::read(entry.path()).await.unwrap(),
            );
        }
        files
    }
    async fn prepare(&self, id: i32, mode: &str, storage: &str, folder: i32) -> Value {
        let before = (
            self.catalogue().await,
            self.files().await,
            self.s3.objects(),
            self.s3.0.lock().unwrap().calls.clone(),
        );
        let preview = self
            .api(
                Method::POST,
                &format!("{TRANSFERS}/prepare"),
                Some(&json!({
                    "mode": mode, "imageIds": [id], "storage": storage, "folderId": folder,
                })),
            )
            .await;
        assert_eq!(
            self.catalogue().await,
            before.0,
            "preview changed PostgreSQL"
        );
        assert_eq!(
            self.files().await,
            before.1,
            "preview changed local storage"
        );
        assert_eq!(self.s3.objects(), before.2, "preview changed S3 objects");
        assert_eq!(
            self.s3.0.lock().unwrap().calls,
            before.3,
            "preview contacted S3"
        );
        json!({"version": preview["version"], "expiresAt": preview["expiresAt"], "intent": preview["intent"]})
    }
    async fn submit(&self, approval: &Value) -> Value {
        self.api(Method::POST, TRANSFERS, Some(approval)).await
    }
    async fn job(&self, id: &str) -> Value {
        self.api(Method::GET, &format!("{TRANSFERS}/{id}"), None)
            .await
    }
    async fn complete(&self, id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let job = self.job(id).await;
                if job["status"] == "complete" {
                    return job;
                }
                assert!(job["error"].is_null(), "unexpected transfer failure: {job}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("transfer did not complete")
    }
    async fn retry_pending(&self, id: &str, attempts: i32) -> Value {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let state = row(&self.db, "SELECT attempts,last_error,next_attempt_at<now()+interval '60 seconds' AS backed_off FROM image_transfer WHERE id=$1", vec![id.into()]).await;
                if state.try_get::<i32>("", "attempts").unwrap() == attempts
                    && state.try_get::<Option<String>>("", "last_error").unwrap().is_some()
                    && state.try_get::<bool>("", "backed_off").unwrap()
                { return self.job(id).await; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.expect("worker did not persist retry state")
    }
    async fn due_now(&self, id: &str) {
        // Only shorten real outbox backoff; status, leases, attempts and specs stay worker-owned.
        execute(
            &self.db,
            "UPDATE image_transfer SET next_attempt_at=now() WHERE id=$1 AND finished_at IS NULL",
            vec![id.into()],
        )
        .await;
    }
    async fn readable(&self, id: i32) -> Value {
        let image = self.image(id).await;
        let content = self
            .client
            .get(format!(
                "{}/api/protect/gallery/images/{id}/content",
                self.app.url
            ))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap();
        assert_eq!(content.status(), StatusCode::OK);
        assert_eq!(content.headers()["cache-control"], "private,no-store");
        assert_eq!(&content.bytes().await.unwrap()[..], IMAGE);
        let (status, location) = self.read_url(image["imageUrl"].as_str().unwrap()).await;
        if image["storage"] == "r2" {
            assert_eq!(status, StatusCode::TEMPORARY_REDIRECT);
            assert_eq!(
                location,
                Some(format!(
                    "{}/public/{}",
                    self.provider.url,
                    image["storagePath"].as_str().unwrap()
                ))
            );
        } else {
            assert_eq!(status, StatusCode::OK);
            assert!(location.is_none());
        }
        image
    }
    async fn read_url(&self, url: &str) -> (StatusCode, Option<String>) {
        let mut response = self
            .client
            .get(format!("{}{url}", self.app.url))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let location = response
            .headers()
            .get("location")
            .map(|value| value.to_str().unwrap().to_owned());
        if status == StatusCode::TEMPORARY_REDIRECT {
            assert_eq!(response.headers()["cache-control"], "no-store");
            let target = location.as_deref().unwrap();
            assert!(target.starts_with(&format!("{}/public/gallery/", self.provider.url)));
            response = self.client.get(target).send().await.unwrap();
        } else if url.starts_with("/api/public/media/") {
            assert_eq!(response.headers()["cache-control"], "public,max-age=300");
        }
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(&response.bytes().await.unwrap()[..], IMAGE);
        (status, location)
    }
    async fn references(&self, note: i32, url: &str) {
        let saved = row(
            &self.db,
            "SELECT content,cover FROM note WHERE id=$1",
            vec![note.into()],
        )
        .await;
        assert_eq!(saved.try_get::<String>("", "cover").unwrap(), url);
        assert_eq!(
            saved.try_get::<String>("", "content").unwrap(),
            format!("![cover]({url})")
        );
        let _ = self.read_url(url).await;
    }
    async fn close(self) {
        transfers::stop();
        let tasks = saudade_blog::lifecycle::task_tracker();
        tasks.close();
        tokio::time::timeout(Duration::from_secs(5), tasks.wait())
            .await
            .unwrap();
        self.db.close().await.unwrap();
        execute(
            &self.admin,
            &format!("DROP SCHEMA {} CASCADE", self.schema),
            vec![],
        )
        .await;
        tokio::fs::remove_dir_all(&self.root).await.unwrap();
    }
}

async fn execute(db: &DatabaseConnection, query: &str, args: Vec<sea_orm::Value>) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        args,
    ))
    .await
    .unwrap();
}
async fn row(
    db: &DatabaseConnection,
    query: &str,
    args: Vec<sea_orm::Value>,
) -> sea_orm::QueryResult {
    db.query_one(Statement::from_sql_and_values(
        DbBackend::Postgres,
        query,
        args,
    ))
    .await
    .unwrap()
    .unwrap()
}
fn delta(before: [usize; 5], after: [usize; 5]) -> [usize; 5] {
    std::array::from_fn(|i| after[i] - before[i])
}

#[tokio::test]
async fn http_storage_roundtrip_copy_replay_and_failure_preserve_sources() {
    let url = match std::env::var("TEST_PG_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ => {
            assert!(std::env::var_os("CI").is_none(), "CI requires TEST_PG_URL");
            eprintln!("SKIP gallery_storage_e2e: TEST_PG_URL 未设置，未验证 PostgreSQL 链路");
            return;
        }
    };
    assert!(url.starts_with("postgres://") || url.starts_with("postgresql://"));
    let ctx = Fixture::new(url).await;
    let outcome =
        std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
            version_conflict_preserves_same_storage_source(&ctx).await;
            roundtrip_and_rejected_upload(&ctx).await;
        }))
        .catch_unwind()
        .await;
    ctx.close().await;
    match outcome {
        Ok(result) => result.expect("storage HTTP E2E exceeded its time budget"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn version_conflict_preserves_same_storage_source(ctx: &Fixture) {
    let id = ctx.seed("conflict.png").await;
    let folder = ctx
        .api(
            Method::POST,
            "/api/protect/gallery/folders",
            Some(&json!({"name":"target"})),
        )
        .await;
    let approval = ctx
        .prepare(id, "move", "local", folder["id"].as_i64().unwrap() as i32)
        .await;
    let job = ctx.submit(&approval).await;
    let job_id = job["id"].as_str().unwrap();
    let image = ctx.image(id).await;
    ctx.api(
        Method::PUT,
        &format!("/api/protect/gallery/images/{id}"),
        Some(&json!({
            "version": image["version"], "description":"concurrent edit",
        })),
    )
    .await;
    // Enqueue and edit before starting the real worker, so the version conflict is deterministic.
    transfers::start(SqlxPostgresConnector::from_sqlx_postgres_pool(
        ctx.db.get_postgres_connection_pool().clone(),
    ));
    for attempt in 1..=5 {
        let job = ctx.retry_pending(job_id, attempt).await;
        assert_eq!(
            job["status"],
            if attempt == 5 { "failed" } else { "copying" }
        );
        assert!(job["result"].is_null());
        assert_eq!(
            tokio::fs::read(ctx.root.join("conflict.png"))
                .await
                .unwrap(),
            IMAGE
        );
        assert_eq!(ctx.s3.counts(), [0; 5]);
        ctx.due_now(job_id).await;
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = row(
                &ctx.db,
                "SELECT finished_at IS NOT NULL AS done FROM image_transfer WHERE id=$1",
                vec![job_id.into()],
            )
            .await;
            if state.try_get::<bool>("", "done").unwrap() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("failed job cleanup did not finish");
    let image = ctx.readable(id).await;
    assert_eq!(image["storagePath"], "/api/protect/download/conflict.png");
    assert_eq!(image["folderId"], 0);
    assert_eq!(image["description"], "concurrent edit");
    assert_eq!(ctx.s3.counts(), [0; 5]);
}

async fn roundtrip_and_rejected_upload(ctx: &Fixture) {
    let id = ctx.seed("original.png").await;
    let original = "/api/protect/download/original.png";
    let note: i32 = row(&ctx.db, "INSERT INTO note(title,content,cover,created_at,updated_at) VALUES('storage-e2e',$1,$2,now(),now()) RETURNING id", vec![format!("![cover]({original})").into(), original.into()]).await.try_get("", "id").unwrap();
    let mut copied_remote = 0;
    let mut copied_local = 0;
    let mut stable_url = String::new();
    for (source, mode, target, expected) in [
        (id, "copy", "r2", [1, 1, 0, 1, 0]),
        (0, "copy", "local", [0, 0, 1, 0, 0]),
        (id, "move", "r2", [1, 1, 0, 1, 0]),
        (id, "move", "local", [0, 0, 1, 0, 1]),
    ] {
        let source = if source == 0 { copied_remote } else { source };
        let before = ctx.s3.counts();
        let files = ctx.files().await;
        let objects = ctx.s3.objects();
        let source_image = ctx.image(source).await;
        let approval = ctx.prepare(source, mode, target, 0).await;
        let queued = ctx.submit(&approval).await;
        let job_id = queued["id"].as_str().unwrap();
        assert_eq!(job_id, approval["version"]);
        assert_eq!(ctx.submit(&approval).await["id"], queued["id"]);
        let complete = ctx.complete(job_id).await;
        assert_eq!(
            delta(before, ctx.s3.counts()),
            expected,
            "{mode} to {target}: LIST/HEAD/GET/PUT/DELETE"
        );
        let changed = complete["result"]["imageIds"][0].as_i64().unwrap() as i32;
        let after = ctx.s3.counts();
        assert_eq!(
            ctx.submit(&approval).await,
            complete,
            "completed approval must replay the same job"
        );
        assert_eq!(ctx.s3.counts(), after, "replay caused provider I/O");
        let image = ctx.readable(changed).await;
        assert_eq!(image["storage"], target);
        if mode == "copy" {
            assert_ne!(changed, source);
            assert_eq!(ctx.image(source).await, source_image);
            for (key, value) in files {
                assert_eq!(ctx.files().await.get(&key), Some(&value));
            }
            for (key, value) in objects {
                assert_eq!(ctx.s3.objects().get(&key), Some(&value));
            }
            ctx.references(note, original).await;
            if target == "r2" {
                copied_remote = changed;
            } else {
                copied_local = changed;
            }
        } else {
            assert_eq!(changed, id);
            let url = image["imageUrl"].as_str().unwrap();
            if target == "r2" {
                assert!(!ctx.root.join("original.png").exists());
                assert!(url.starts_with("/api/public/media/"));
                stable_url = url.to_owned();
            } else {
                assert_eq!(
                    url, stable_url,
                    "roundtrip changed the public media identity"
                );
                assert!(!ctx
                    .s3
                    .objects()
                    .contains_key(source_image["storagePath"].as_str().unwrap()));
            }
            ctx.references(note, url).await;
        }
    }
    assert_eq!(
        ctx.s3.objects().len(),
        1,
        "the copied R2 object must survive moving a different image"
    );
    let before = ctx.image(copied_local).await;
    let files = ctx.files().await;
    let objects = ctx.s3.objects();
    let counts = ctx.s3.counts();
    let approval = ctx.prepare(copied_local, "move", "r2", 0).await;
    ctx.s3.0.lock().unwrap().reject_put = true;
    let job = ctx.submit(&approval).await;
    let job_id = job["id"].as_str().unwrap();
    let retry = ctx.retry_pending(job_id, 1).await;
    assert_eq!(retry["status"], "copying");
    assert!(retry["result"].is_null());
    assert_eq!(
        ctx.image(copied_local).await,
        before,
        "failed PUT published catalogue changes"
    );
    assert_eq!(
        ctx.files().await,
        files,
        "failed PUT removed the local source"
    );
    assert_eq!(ctx.s3.objects(), objects);
    assert_eq!(delta(counts, ctx.s3.counts()), [1, 1, 0, 1, 0]);
    let after_failure = ctx.s3.counts();
    assert_eq!(ctx.submit(&approval).await, retry);
    assert_eq!(
        ctx.s3.counts(),
        after_failure,
        "failed approval replay caused provider I/O"
    );
    ctx.readable(copied_local).await;
    ctx.references(note, &stable_url).await;
    ctx.s3.0.lock().unwrap().reject_put = false;
    ctx.due_now(job_id).await;
    // A previous error remains visible until the successful publication commits.
    let recovered = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let status = ctx.job(job_id).await;
            if status["status"] == "complete" {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("rejected PUT did not recover");
    assert_eq!(recovered["result"]["imageIds"], json!([copied_local]));
    assert!(recovered["error"].is_null());
    assert_eq!(
        delta(after_failure, ctx.s3.counts()),
        [1, 1, 0, 1, 0],
        "recovery repeated unrelated provider I/O"
    );
    let image = ctx.readable(copied_local).await;
    assert_eq!(image["storage"], "r2");
    assert_eq!(image["imageUrl"], before["imageUrl"]);
    assert!(!ctx
        .root
        .join(before["storagePath"].as_str().unwrap())
        .exists());
    assert_eq!(ctx.submit(&approval).await, recovered);
    eprintln!("S3 LIST/HEAD/GET/PUT/DELETE totals: {:?}", ctx.s3.counts());
}
