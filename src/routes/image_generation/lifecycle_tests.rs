use super::*;
use crate::rate_limiter::LoginRateLimiter;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::StreamExt;
use sea_orm::{Database, TransactionTrait};
use std::time::Duration;

struct Fixture {
    state: Arc<AppState>,
    uid: i32,
}

impl Fixture {
    async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "CI requires explicit TEST_PG_URL"
            );
            return None;
        };
        assert!(url.starts_with("postgres://") || url.starts_with("postgresql://"));
        assert!(!std::env::var("JWT_SECRET").unwrap_or_default().is_empty());
        let db = Database::connect(url).await.unwrap();
        assert!(
            !crate::r2::load_config(&db).await.unwrap().active(),
            "Use a disposable CI database with R2 disabled"
        );
        let uid = db.query_one(stmt(
            "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','admin') RETURNING id",
            vec![format!("image_lifecycle_{}", uuid::Uuid::new_v4().simple()).into()],
        )).await.unwrap().unwrap().try_get("", "id").unwrap();
        Some(Self {
            state: Arc::new(AppState {
                db,
                rate_limiter: LoginRateLimiter::new(1, 60, 60),
                post_limiter: crate::risk::PostRateLimiter::default(),
                report_limiter: LoginRateLimiter::new(1, 60, 60),
            }),
            uid,
        })
    }

    async fn seed(&self, status: &str, origin: &str, request: &Request) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let frozen = serde_json::to_value(request).unwrap();
        let hash = digest(&serde_json::to_vec(request).unwrap());
        self.state
            .db
            .execute(stmt(
                "INSERT INTO image_generation(id,owner_id,request,request_hash,status,origin) \
             VALUES($1::uuid,$2,$3,$4,$5,$6)",
                vec![
                    id.clone().into(),
                    self.uid.into(),
                    frozen.into(),
                    hash.into(),
                    status.into(),
                    origin.into(),
                ],
            ))
            .await
            .unwrap();
        id
    }

    async fn snapshot(&self, id: &str, bytes: &[u8]) {
        self.state.db.execute(stmt(
            "INSERT INTO image_generation_reference(job_id,ordinal,mime,bytes) VALUES($1::uuid,0,'image/png',$2)",
            vec![id.into(), bytes.to_vec().into()],
        )).await.unwrap();
    }

    async fn document(&self, id: &str) -> JsonValue {
        self.state
            .db
            .query_one(stmt(
                "SELECT to_jsonb(j) AS document FROM image_generation j WHERE id::text=$1",
                vec![id.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "document")
            .unwrap()
    }

    async fn count(&self) -> i64 {
        self.state
            .db
            .query_one(stmt(
                "SELECT count(*)::bigint AS n FROM image_generation WHERE owner_id=$1",
                vec![self.uid.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "n")
            .unwrap()
    }

    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!(
                "Bearer {}",
                crate::auth_jwt::create_token(self.uid, "admin", 0)
            )
            .parse()
            .unwrap(),
        );
        headers
    }

    async fn cleanup(&self) {
        self.state
            .db
            .execute(stmt(
                "DELETE FROM \"user\" WHERE id=$1",
                vec![self.uid.into()],
            ))
            .await
            .unwrap();
    }
}

fn settings() -> settings::Settings {
    settings::Settings {
        key: "never-sent-synthetic-key".into(),
        base: "https://image-provider.invalid/v1".into(),
        models: vec!["fixture-image-model".into()],
        proxy: None,
    }
}

fn png() -> Vec<u8> {
    STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2kAAAAASUVORK5CYII=").unwrap()
}

fn request(references: Vec<Reference>) -> Request {
    Request {
        provider: settings().base,
        prompt: "  冻结提示词：保留留白与原始标点。\nDo not rewrite.  ".into(),
        model: "fixture-image-model".into(),
        size: "1536x1024".into(),
        quality: "high".into(),
        references,
    }
}

#[tokio::test]
async fn accepted_history_reports_removed_images_without_losing_generation_facts() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let id = fixture.seed("accepted", "agent", &request(vec![])).await;
    let old = jobs::read(&fixture.state, fixture.uid, &id).await.unwrap();
    assert_eq!(old.status, "accepted");
    assert!(old.image_removed && old.image_id.is_none() && old.preview_url.is_none());
    let url = format!(
        "/api/protect/download/removed-history-{}.png",
        uuid::Uuid::new_v4().simple()
    );
    let image_id: i32 = fixture
        .state
        .db
        .query_one(stmt(
            "INSERT INTO images(image_url) VALUES($1) RETURNING image_key",
            vec![url.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "image_key")
        .unwrap();
    fixture
        .state
        .db
        .execute(stmt(
            "UPDATE image_generation SET image_id=$2 WHERE id::text=$1",
            vec![id.clone().into(), image_id.into()],
        ))
        .await
        .unwrap();
    let saved = jobs::read(&fixture.state, fixture.uid, &id).await.unwrap();
    assert!(!saved.image_removed);
    assert_eq!(saved.image_id, Some(image_id));
    assert_eq!(saved.preview_url.as_deref(), Some(url.as_str()));
    fixture.state.db.execute(stmt("INSERT INTO image_deletion(image_id,image_url,decoded_url,requested_by,storage_kind,storage_scope,storage_key) VALUES($1,$2,$2,$3,'local','/fixture','fixture.png')", vec![image_id.into(), url.into(), fixture.uid.into()])).await.unwrap();
    let removed = jobs::read(&fixture.state, fixture.uid, &id).await.unwrap();
    assert_eq!(removed.status, "accepted");
    assert_eq!(removed.image_id, Some(image_id));
    assert!(removed.image_removed && removed.preview_url.is_none());
    fixture.cleanup().await;
    fixture
        .state
        .db
        .execute(stmt(
            "DELETE FROM image_deletion WHERE image_id=$1",
            vec![image_id.into()],
        ))
        .await
        .unwrap();
    fixture
        .state
        .db
        .execute(stmt(
            "DELETE FROM images WHERE image_key=$1",
            vec![image_id.into()],
        ))
        .await
        .unwrap();
}

async fn storage_waiters(state: &AppState, key: i64) -> i64 {
    state
        .db
        .query_one(stmt(
            "SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype='advisory' AND classid=0 \
         AND objid::bigint=$1 AND objsubid=1 AND NOT granted",
            vec![key.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap()
}

#[tokio::test]
async fn saving_returns_without_storage_lock_and_commits_once_to_agent_gallery() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let state = &fixture.state;
    let bytes = png();
    let version = digest(&bytes);
    let frozen = request(vec![]);
    let id = fixture.seed("review", "agent", &frozen).await;
    let storage_prefix = crate::routes::upload::generation_prefix(&format!("ai-{id}.png"), &bytes);
    state
        .db
        .execute(stmt(
            "UPDATE image_generation SET output=$2,output_hash=$3 WHERE id::text=$1",
            vec![
                id.clone().into(),
                bytes.clone().into(),
                version.clone().into(),
            ],
        ))
        .await
        .unwrap();
    assert!(matches!(
        acceptance::accept(
            state,
            fixture.uid + 1,
            &id,
            Acceptance {
                storage: crate::routes::gallery::storage::Kind::Local,
                version: version.clone()
            }
        )
        .await,
        Err(errors::JobError::Missing)
    ));

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let trigger = format!("image_lifecycle_{suffix}");
    let key = (uuid::Uuid::new_v4().as_u128() as i64) & 0x7fff_ffff;
    state.db.execute(stmt(format!(
        "CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
         IF position('{storage_prefix}' in NEW.image_url)>0 THEN PERFORM pg_advisory_xact_lock({key}::bigint); END IF; \
         RETURN NEW; END $$"), vec![])).await.unwrap();
    state.db.execute(stmt(format!(
        "CREATE TRIGGER {trigger} BEFORE INSERT ON images FOR EACH ROW EXECUTE FUNCTION {trigger}()"),
        vec![])).await.unwrap();
    let blocked = state.db.begin().await.unwrap();
    blocked
        .execute(stmt("SELECT pg_advisory_xact_lock($1)", vec![key.into()]))
        .await
        .unwrap();

    let saving = tokio::time::timeout(
        Duration::from_secs(2),
        acceptance::accept(
            state,
            fixture.uid,
            &id,
            Acceptance {
                storage: crate::routes::gallery::storage::Kind::Local,
                version: version.clone(),
            },
        ),
    )
    .await
    .expect("Acceptance waited for storage instead of returning its durable saving state")
    .unwrap();
    assert_eq!(saving.status, "saving");
    let preview_token = saving
        .preview_url
        .as_ref()
        .unwrap()
        .split("?token=")
        .nth(1)
        .unwrap()
        .to_owned();
    let preview = super::preview(
        State(state.clone()),
        Path(id.clone()),
        Query(PreviewQuery {
            token: preview_token,
        }),
    )
    .await
    .into_response();
    assert_eq!(preview.status(), StatusCode::OK);
    assert_eq!(preview.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        axum::body::to_bytes(preview.into_body(), 1024)
            .await
            .unwrap()
            .as_ref(),
        bytes.as_slice()
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while storage_waiters(state, key).await != 1 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("The real gallery insertion never reached its targeted storage barrier");

    // Storage is blocked, but the job transaction has already committed and released its row lock.
    let probe = state.db.begin().await.unwrap();
    let row = probe
        .query_one(stmt(
            "SELECT status FROM image_generation WHERE id::text=$1 FOR UPDATE NOWAIT",
            vec![id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<String>("", "status").unwrap(), "saving");
    probe.rollback().await.unwrap();
    for _ in 0..3 {
        let repeated = acceptance::accept(
            state,
            fixture.uid,
            &id,
            Acceptance {
                storage: crate::routes::gallery::storage::Kind::Local,
                version: version.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(repeated.status, "saving");
    }
    assert_eq!(
        storage_waiters(state, key).await,
        1,
        "Repeated acceptance started duplicate storage"
    );
    assert!(matches!(
        history::remove(state, fixture.uid, &id).await,
        Err(errors::JobError::Conflict(_))
    ));
    assert!(matches!(
        history::retry(state, fixture.uid, &id, &settings()).await,
        Err(errors::JobError::Conflict(_))
    ));
    assert_eq!(fixture.document(&id).await["output_hash"], version);
    let observation = events::observe(
        State(state.clone()),
        fixture.headers(),
        Path(id.clone()),
        Query(events::WatchQuery {
            wait_seconds: Some(1),
        }),
    )
    .await
    .unwrap()
    .into_response();
    assert_eq!(observation.headers()["x-accel-buffering"], "no");
    assert_eq!(observation.headers()[header::CACHE_CONTROL], "no-store");
    let mut reader = observation.into_body().into_data_stream();
    let first = tokio::time::timeout(Duration::from_secs(1), reader.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let first = std::str::from_utf8(&first).unwrap();
    assert!(first.lines().any(|line| line
        .strip_prefix("event:")
        .is_some_and(|name| name.trim() == "image_job")));
    assert!(first.contains("\"status\":\"saving\""));
    // Releasing the SSE reader must not own or cancel the independently accepted storage job.
    drop(reader);
    blocked.rollback().await.unwrap();

    let accepted = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let job = jobs::read(state, fixture.uid, &id).await.unwrap();
            if job.status == "accepted" {
                break job;
            }
            assert_eq!(job.status, "saving");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Gallery storage did not finish after releasing its barrier");
    state
        .db
        .execute(stmt(format!("DROP TRIGGER {trigger} ON images"), vec![]))
        .await
        .unwrap();
    state
        .db
        .execute(stmt(format!("DROP FUNCTION {trigger}()"), vec![]))
        .await
        .unwrap();
    let image_id = accepted.image_id.unwrap();
    let gallery = state.db.query_one(stmt(
        "SELECT i.image_url,m.description,child.name AS folder,parent.name AS parent \
         FROM images i JOIN image_metadata m ON m.image_id=i.image_key \
         JOIN image_folder child ON child.id=m.folder_id JOIN image_folder parent ON parent.id=child.parent_id \
         WHERE i.image_key=$1", vec![image_id.into()],
    )).await.unwrap().unwrap();
    assert_eq!(
        gallery.try_get::<String>("", "description").unwrap(),
        frozen.prompt
    );
    assert_eq!(
        gallery.try_get::<String>("", "folder").unwrap(),
        "Agent 生成"
    );
    assert_eq!(gallery.try_get::<String>("", "parent").unwrap(), "AI 生图");
    let url: String = gallery.try_get("", "image_url").unwrap();
    let copies: i64 = state
        .db
        .query_one(stmt(
            "SELECT count(*)::bigint AS n FROM images i JOIN image_location l ON l.image_id=i.image_key WHERE l.source_url LIKE $1",
            vec![format!("%/{storage_prefix}%").into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap();
    assert_eq!(copies, 1);
    assert!(fixture.document(&id).await["output"].is_null());
    assert!(matches!(
        history::remove(state, fixture.uid + 1, &id).await,
        Err(errors::JobError::Missing)
    ));
    history::remove(state, fixture.uid, &id).await.unwrap();
    assert_eq!(fixture.count().await, 0);
    assert!(
        crate::routes::gallery::read(&state.db, fixture.uid, image_id)
            .await
            .is_ok(),
        "Deleting generation history must retain the accepted gallery image"
    );
    assert!(crate::routes::gallery::storage::public_id(&url).is_some());
    let image = crate::routes::gallery::read(&state.db, fixture.uid, image_id)
        .await
        .unwrap();
    let location = crate::routes::gallery::storage::resolve(&state.db, &image)
        .await
        .unwrap();
    let filename = location.key.as_str();
    assert!(filename.starts_with(&storage_prefix) && !filename.contains('/'));
    let path = crate::utils::upload_dir().join(filename);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    state
        .db
        .execute(stmt(
            "DELETE FROM images WHERE image_key=$1",
            vec![image_id.into()],
        ))
        .await
        .unwrap();
    tokio::fs::remove_file(path).await.unwrap();
    fixture.cleanup().await;
}

#[tokio::test]
async fn completion_reports_are_owned_versioned_and_caught_up_from_the_durable_list() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let id = fixture.seed("review", "agent", &request(vec![])).await;
    let cid: i32 = fixture
        .state
        .db
        .query_one(stmt(
            "INSERT INTO conversation(user_id,title) VALUES($1,'image completion') RETURNING id",
            vec![fixture.uid.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "id")
        .unwrap();
    fixture
        .state
        .db
        .execute(stmt(
            "UPDATE image_generation SET conversation_id=$2,output_hash=$3 WHERE id::text=$1",
            vec![id.clone().into(), cid.into(), "a".repeat(64).into()],
        ))
        .await
        .unwrap();
    let job = jobs::read(&fixture.state, fixture.uid, &id).await.unwrap();
    let event = chat::ImageEvent {
        job_id: id.clone(),
        version: job.event_version.clone(),
    };
    assert!(event.valid());
    assert!(chat::verify(&fixture.state, fixture.uid, cid, &event)
        .await
        .unwrap());
    assert!(chat::verify(&fixture.state, fixture.uid + 1, cid, &event)
        .await
        .is_err());
    assert!(chat::verify(&fixture.state, fixture.uid, cid + 1, &event)
        .await
        .is_err());
    let changed = chat::ImageEvent {
        version: "f".repeat(64),
        ..event.clone()
    };
    assert!(chat::verify(&fixture.state, fixture.uid, cid, &changed)
        .await
        .is_err());
    let list = chat::list(
        State(fixture.state.clone()),
        fixture.headers(),
        Query(chat::ConversationQuery {
            conversation_id: cid,
        }),
    )
    .await
    .0
    .data;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].event_version, event.version);
    fixture
        .state
        .db
        .execute(stmt(
            "UPDATE image_generation SET reported_version=$2 WHERE id::text=$1",
            vec![id.into(), event.version.clone().into()],
        ))
        .await
        .unwrap();
    assert!(!chat::verify(&fixture.state, fixture.uid, cid, &event)
        .await
        .unwrap());
    let list = chat::list(
        State(fixture.state.clone()),
        fixture.headers(),
        Query(chat::ConversationQuery {
            conversation_id: cid,
        }),
    )
    .await
    .0
    .data;
    assert!(list.is_empty());
    fixture
        .state
        .db
        .execute(stmt(
            "DELETE FROM conversation WHERE id=$1",
            vec![cid.into()],
        ))
        .await
        .unwrap();
    fixture.cleanup().await;
}

#[tokio::test]
async fn retry_freezes_original_prompt_and_references_without_approving_unknown_outcome() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let bytes = png();
    let frozen = request(vec![Reference {
        image_id: 123456,
        name: "冻结参考图.png".into(),
        digest: digest(&bytes),
        preview_url: String::new(),
    }]);
    let id = fixture.seed("generating", "agent", &frozen).await;
    fixture.snapshot(&id, &bytes).await;
    fixture
        .state
        .db
        .execute(stmt(
            "UPDATE image_generation SET approved_at=now() WHERE id::text=$1",
            vec![id.clone().into()],
        ))
        .await
        .unwrap();
    assert!(matches!(
        history::retry(&fixture.state, fixture.uid, &id, &settings()).await,
        Err(errors::JobError::Conflict(_))
    ));
    assert!(matches!(
        history::remove(&fixture.state, fixture.uid, &id).await,
        Err(errors::JobError::Conflict(_))
    ));
    fixture
        .state
        .db
        .execute(stmt(
            "UPDATE image_generation SET approved_at=now()-interval '6 minutes' WHERE id::text=$1",
            vec![id.clone().into()],
        ))
        .await
        .unwrap();
    let original = fixture.document(&id).await;
    assert!(matches!(
        history::retry(&fixture.state, fixture.uid + 1, &id, &settings()).await,
        Err(errors::JobError::Missing)
    ));
    let mut unavailable = settings();
    unavailable.models.clear();
    assert!(matches!(
        history::retry(&fixture.state, fixture.uid, &id, &unavailable).await,
        Err(errors::JobError::Conflict(_))
    ));
    assert_eq!(fixture.count().await, 1);
    let retried = history::retry(&fixture.state, fixture.uid, &id, &settings())
        .await
        .unwrap();
    assert_ne!(retried.id, id);
    assert_eq!(retried.status, "pending");
    assert_eq!(retried.retry_of.as_deref(), Some(id.as_str()));
    assert_eq!(retried.retry_source_status.as_deref(), Some("unknown"));
    assert_eq!(retried.request.as_ref().unwrap().prompt, frozen.prompt);
    let pending = fixture.document(&retried.id).await;
    assert_eq!(pending["request"], original["request"]);
    assert_eq!(pending["request_hash"], original["request_hash"]);
    assert_eq!(pending["origin"], "agent");
    for field in [
        "approved_at",
        "finished_at",
        "output",
        "output_hash",
        "image_id",
    ] {
        assert!(
            pending[field].is_null(),
            "Retry must not approve or produce a result: {field}"
        );
    }
    let reference = fixture
        .state
        .db
        .query_one(stmt(
            "SELECT ordinal,mime,bytes FROM image_generation_reference WHERE job_id::text=$1",
            vec![retried.id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reference.try_get::<i16>("", "ordinal").unwrap(), 0);
    assert_eq!(
        reference.try_get::<String>("", "mime").unwrap(),
        "image/png"
    );
    assert_eq!(reference.try_get::<Vec<u8>>("", "bytes").unwrap(), bytes);
    assert_eq!(
        fixture.document(&id).await,
        original,
        "Retry changed its source job"
    );
    assert_eq!(fixture.count().await, 2);
    fixture.cleanup().await;
}

#[tokio::test]
async fn retry_rejects_missing_corrupt_and_misordered_reference_snapshots() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let bytes = png();
    let frozen = request(vec![Reference {
        image_id: 1,
        name: "reference.png".into(),
        digest: digest(&bytes),
        preview_url: String::new(),
    }]);
    for failure in ["missing", "corrupt", "ordinal"] {
        let id = fixture.seed("unknown", "dashboard", &frozen).await;
        if failure != "missing" {
            fixture
                .snapshot(
                    &id,
                    if failure == "corrupt" {
                        b"changed"
                    } else {
                        &bytes
                    },
                )
                .await;
            if failure == "ordinal" {
                fixture
                    .state
                    .db
                    .execute(stmt(
                        "UPDATE image_generation_reference SET ordinal=1 WHERE job_id::text=$1",
                        vec![id.clone().into()],
                    ))
                    .await
                    .unwrap();
            }
        }
        let before = fixture.count().await;
        let original = fixture.document(&id).await;
        assert!(
            matches!(
                history::retry(&fixture.state, fixture.uid, &id, &settings()).await,
                Err(errors::JobError::Conflict(_))
            ),
            "Accepted {failure} reference snapshot"
        );
        assert_eq!(
            fixture.count().await,
            before,
            "Failed retry created a new pending job"
        );
        assert_eq!(fixture.document(&id).await, original);
    }
    fixture.cleanup().await;
}

#[tokio::test]
async fn postgres_sse_checks_owner_and_finishes_unchanged_jobs_at_its_deadline() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let Some(other) = Fixture::new().await else {
        unreachable!()
    };
    let id = fixture.seed("pending", "dashboard", &request(vec![])).await;
    let original = fixture.document(&id).await;
    let denied = events::observe(
        State(fixture.state.clone()),
        other.headers(),
        Path(id.clone()),
        Query(events::WatchQuery {
            wait_seconds: Some(1),
        }),
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(denied, errors::JobError::Missing));

    let response = events::observe(
        State(fixture.state.clone()),
        fixture.headers(),
        Path(id.clone()),
        Query(events::WatchQuery {
            wait_seconds: Some(1),
        }),
    )
    .await
    .unwrap()
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    let started = tokio::time::Instant::now();
    let body = tokio::time::timeout(
        Duration::from_secs(3),
        axum::body::to_bytes(response.into_body(), 64 * 1024),
    )
    .await
    .expect("Observation ignored its one-second deadline")
    .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(800));
    let text = std::str::from_utf8(&body).unwrap();
    let names: Vec<_> = text
        .lines()
        .filter_map(|line| line.strip_prefix("event:").map(str::trim))
        .collect();
    assert_eq!(names, ["image_job", "image_job_timeout"]);
    for line in text.lines().filter_map(|line| line.strip_prefix("data:")) {
        let job: JsonValue = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(job["id"], id);
        assert_eq!(job["status"], "pending");
    }
    assert_eq!(
        fixture.document(&id).await,
        original,
        "Observing or timing out changed a paid job"
    );

    let response = events::observe(
        State(fixture.state.clone()),
        fixture.headers(),
        Path(id.clone()),
        Query(events::WatchQuery {
            wait_seconds: Some(1),
        }),
    )
    .await
    .unwrap()
    .into_response();
    let mut reader = response.into_body().into_data_stream();
    reader.next().await.unwrap().unwrap();
    history::remove(&fixture.state, fixture.uid, &id)
        .await
        .unwrap();
    let error = tokio::time::timeout(Duration::from_secs(1), reader.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text = std::str::from_utf8(&error).unwrap();
    assert!(text.lines().any(|line| line
        .strip_prefix("event:")
        .is_some_and(|name| name.trim() == "image_job_error")));
    let payload: JsonValue = serde_json::from_str(
        text.lines()
            .find_map(|line| line.strip_prefix("data:"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(payload, serde_json::json!({"code":"unavailable"}));
    assert!(reader.next().await.is_none());
    fixture.cleanup().await;
    other.cleanup().await;
}
