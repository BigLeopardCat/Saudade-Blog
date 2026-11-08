use super::*;

fn source(body: &str) -> Document {
    Document {
        kind: Kind::Note,
        id: 19,
        title: "标题".into(),
        body: body.into(),
        metadata: json!({}),
    }
}

#[test]
fn shared_commonmark_sources_have_identical_offsets_and_document_hashes() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-reading.json"
    ))
    .unwrap();
    for case in cases {
        let title = case["title"].as_str().unwrap();
        let body = case["content"].as_str().unwrap();
        assert_eq!(
            serde_json::to_value(sections::outline(body, title)).unwrap(),
            case["sections"],
            "{}",
            case["name"]
        );
        assert_eq!(content_revision(title, body), case["contentRevision"]);
        assert_eq!(sections::SCHEMA, case["sectionSchema"]);
    }
}

#[test]
fn bounded_unicode_reads_roundtrip_all_kinds_and_keep_images_verbatim() {
    let body = "![猫](https://example.test/猫.png)\r\n🐈 é，原始正文。";
    for kind in [Kind::Note, Kind::Talk, Kind::Board, Kind::Announcement] {
        let revision = content_revision("标题", body);
        let mut offset = 0;
        let mut joined = String::new();
        loop {
            let mut doc = source(body);
            doc.kind = kind;
            let value = frame(
                doc,
                ReadQuery {
                    offset: Some(offset),
                    limit: Some(7),
                    revision: Some(revision.clone()),
                    section_schema: Some(sections::SCHEMA.into()),
                    ..Default::default()
                },
            )
            .unwrap();
            let fragment = value["content"].as_str().unwrap();
            assert!(fragment.chars().count() <= 7);
            assert_eq!(value["source"]["offset"], offset);
            joined.push_str(fragment);
            let Some(next) = value["nextOffset"].as_u64() else {
                assert_eq!(value["readComplete"], true);
                break;
            };
            assert!(next as usize > offset);
            offset = next as usize;
        }
        assert_eq!(joined, body);
    }
}

#[test]
fn ambiguous_titles_and_stale_section_views_never_read_an_arbitrary_section() {
    let body = "## Parent\n### Repeat\nfirst\n### Repeat\nsecond\n## Empty\n";
    let first = frame(source(body), ReadQuery::default()).unwrap();
    let duplicate = frame(
        source(body),
        ReadQuery {
            section: Some("Repeat".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(duplicate["content"], "");
    assert!(duplicate["source"].is_null());
    let selected = frame(
        source(body),
        ReadQuery {
            section: Some("s3".into()),
            revision: Some(first["contentRevision"].as_str().unwrap().into()),
            section_schema: Some(sections::SCHEMA.into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(selected["content"], "second\n");
    let missing = frame(
        source(body),
        ReadQuery {
            section: Some("s3".into()),
            ..Default::default()
        },
    );
    assert_eq!(missing.unwrap_err().0, StatusCode::BAD_REQUEST);
    for query in [
        ReadQuery {
            revision: Some("a".repeat(64)),
            ..Default::default()
        },
        ReadQuery {
            section_schema: Some("future-parser".into()),
            ..Default::default()
        },
    ] {
        assert_eq!(
            frame(source(body), query).unwrap_err().0,
            StatusCode::CONFLICT
        );
    }
}

fn state(db: sea_orm::DatabaseConnection) -> Arc<AppState> {
    Arc::new(AppState {
        db,
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 300, 900),
        post_limiter: crate::risk::PostRateLimiter::new(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

#[tokio::test]
async fn bad_ranges_fail_before_database_and_missing_rows_remain_404() {
    use sea_orm::{DatabaseBackend, MockDatabase, MockExecResult};
    for query in [
        ReadQuery {
            limit: Some(24001),
            ..Default::default()
        },
        ReadQuery {
            offset: Some(1),
            ..Default::default()
        },
    ] {
        let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        assert_eq!(
            read(State(state(db)), Path((Kind::Note, 19)), Query(query))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([MockExecResult::default()])
        .append_query_results([Vec::<note::Model>::new()])
        .into_connection();
    let response = read(
        State(state(db)),
        Path((Kind::Note, 19)),
        Query(ReadQuery::default()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn postgres_public_reads_keep_source_type_and_visibility_without_private_metadata() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("SKIP bounded document read PostgreSQL: TEST_PG_URL not set");
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let prefix = format!("document_read_{}", uuid::Uuid::new_v4().simple());
    let user=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'fixture','user') RETURNING id",
        vec![prefix.clone().into()])).await.unwrap().unwrap();
    let uid: i32 = user.try_get("", "id").unwrap();
    let text = "## 标题\r\n![🐈](https://example.test/a.png) é👩🏽‍💻\r\n".repeat(80);
    let article=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) VALUES ($1,$2,'public',true,localtimestamp,localtimestamp) RETURNING id",
        vec![prefix.clone().into(),text.clone().into()])).await.unwrap().unwrap();
    let article_id: i32 = article.try_get("", "id").unwrap();
    let note = document(&tx, Kind::Note, article_id)
        .await
        .unwrap()
        .unwrap();
    let part = frame(
        note,
        ReadQuery {
            limit: Some(23),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(part["content"], text.chars().take(23).collect::<String>());
    assert_eq!(part["contentRevision"], content_revision(&prefix, &text));
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET is_public=false WHERE id=$1",
        vec![article_id.into()],
    ))
    .await
    .unwrap();
    assert!(document(&tx, Kind::Note, article_id)
        .await
        .unwrap()
        .is_none());
    for (kind, src) in [(Kind::Board, "board"), (Kind::Talk, "talk")] {
        for approved in [1i16, 0, 2] {
            let row=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,created_at,updated_at) VALUES ($1,$2,'愿',0,'public display',$3,$4,$5,localtimestamp,localtimestamp) RETURNING id",
                vec![prefix.clone().into(),text.clone().into(),uid.into(),src.into(),approved.into()])).await.unwrap().unwrap();
            let id: i32 = row.try_get("", "id").unwrap();
            let doc = document(&tx, kind, id).await.unwrap();
            assert_eq!(doc.is_some(), approved == 1);
            if let Some(doc) = doc {
                let part = frame(
                    doc,
                    ReadQuery {
                        limit: Some(23),
                        ..Default::default()
                    },
                )
                .unwrap();
                assert_eq!(part["content"], text.chars().take(23).collect::<String>());
                assert!(part["metadata"].get("userId").is_none());
                assert!(part["metadata"].get("username").is_none());
            }
            let wrong = if kind == Kind::Talk {
                Kind::Board
            } else {
                Kind::Talk
            };
            assert!(document(&tx, wrong, id).await.unwrap().is_none());
        }
    }
    let announcement=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO announcement(title,content,created_at,updated_at) VALUES ($1,$2,localtimestamp,localtimestamp) RETURNING id",
        vec![prefix.clone().into(),text.clone().into()])).await.unwrap().unwrap();
    let id: i32 = announcement.try_get("", "id").unwrap();
    let doc = document(&tx, Kind::Announcement, id)
        .await
        .unwrap()
        .unwrap();
    let part = frame(
        doc,
        ReadQuery {
            limit: Some(23),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(part["content"], text.chars().take(23).collect::<String>());
    assert_eq!(part["readComplete"], false);
    assert_eq!(part["nextOffset"], 23);
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn metadata_bounds_are_explicit_and_never_return_broken_urls_or_private_keys() {
    use sea_orm::{DatabaseBackend, MockDatabase};
    let mut row: note::Model = serde_json::from_value(json!({
        "id": 19, "title": "T", "content": "body", "is_public": true,
        "created_at": "2026-11-01T12:00:00", "updated_at": "2026-11-01T12:00:00"
    }))
    .unwrap();
    row.description = Some("概".repeat(2001));
    row.cover = Some(format!("https://example.test/{}", "x".repeat(2048)));
    row.cover_focus_x = Some(0.25);
    row.cover_focus_y = Some(f64::NAN);
    row.cover_zoom = Some(2.0);
    row.cover_fit = Some("contain".into());
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    let value = metadata::article(&db, &row).await.unwrap();
    assert_eq!(value["description"].as_str().unwrap().chars().count(), 2000);
    assert_eq!(value["descriptionTruncated"], true);
    assert!(value["cover"].is_null());
    assert_eq!(value["coverTruncated"], true);
    assert_eq!(value["coverFocusX"], 0.25);
    assert!(value["coverFocusY"].is_null());
    assert_eq!(value["coverZoom"], 2.0);
    assert_eq!(value["coverFit"], "contain");
    assert!(value["authorName"].is_null());
    for key in [
        "authorId", "userId", "username", "email", "password", "role",
    ] {
        assert!(value.get(key).is_none());
    }
}

#[tokio::test]
async fn postgres_public_read_attribution_matches_existing_public_author_projection() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("SKIP article display metadata PostgreSQL: TEST_PG_URL not set");
        return;
    };
    let db = Database::connect(url)
        .await
        .expect("configured test database is reachable");
    let tx = db.begin().await.unwrap();
    let marker = format!("metadata_{}", uuid::Uuid::new_v4().simple());
    let user = tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,nickname,avatar,password,role) VALUES ($1,$2,$3,'private fixture','user') RETURNING id",
        vec![marker.clone().into(),"  公开署名  ".into()," https://example.test/author.png ".into()])).await.unwrap().unwrap();
    let uid: i32 = user.try_get("", "id").unwrap();
    let article = tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,description,cover,cover_focus_x,cover_focus_y,cover_zoom,cover_fit,user_id,status,is_public,created_at,updated_at) VALUES ($1,'original body','现有摘要','/cover.png',0.25,0.75,1.5,'contain',$2,'public',true,localtimestamp,localtimestamp) RETURNING id",
        vec![marker.clone().into(),uid.into()])).await.unwrap().unwrap();
    let id: i32 = article.try_get("", "id").unwrap();
    let public_document = document(&tx, Kind::Note, id).await.unwrap().unwrap();
    let value = frame(
        public_document,
        ReadQuery {
            limit: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    let public_author = super::super::notes::authors::profiles(&tx, vec![uid])
        .await
        .unwrap()
        .remove(&uid)
        .unwrap();
    assert_eq!(value["metadata"]["authorName"], public_author.name);
    assert_eq!(value["metadata"]["authorName"], "公开署名");
    assert_eq!(
        value["metadata"]["authorAvatar"],
        "https://example.test/author.png"
    );
    assert_eq!(value["metadata"]["authorAvatar"], public_author.avatar);
    assert_eq!(value["metadata"]["description"], "现有摘要");
    assert_eq!(value["metadata"]["cover"], "/cover.png");
    assert_eq!(value["metadata"]["coverFocusX"], 0.25);
    assert_eq!(value["metadata"]["coverFocusY"], 0.75);
    assert_eq!(value["metadata"]["coverZoom"], 1.5);
    assert_eq!(value["metadata"]["coverFit"], "contain");
    assert_eq!(value["content"], "o");
    assert_eq!(value["source"]["offset"], 0);
    assert_eq!(value["source"]["end"], 1);
    assert_eq!(value["nextOffset"], 1);
    for key in [
        "authorId", "userId", "username", "email", "password", "role",
    ] {
        assert!(value["metadata"].get(key).is_none());
    }
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET nickname='',avatar=NULL WHERE id=$1",
        vec![uid.into()],
    ))
    .await
    .unwrap();
    let changed = document(&tx, Kind::Note, id).await.unwrap().unwrap();
    assert_eq!(changed.metadata["authorName"], marker);
    assert_eq!(changed.metadata["authorAvatar"], "");
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET is_public=false WHERE id=$1",
        vec![id.into()],
    ))
    .await
    .unwrap();
    assert!(document(&tx, Kind::Note, id).await.unwrap().is_none());
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn attribution_database_failures_are_not_anonymous_or_empty_metadata() {
    use sea_orm::{DatabaseBackend, DbErr, MockDatabase};
    let row: note::Model = serde_json::from_value(json!({
        "id":19,"title":"T","content":"body","is_public":true,"user_id":7,
        "created_at":"2026-11-01T12:00:00","updated_at":"2026-11-01T12:00:00"
    }))
    .unwrap();
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("profile unavailable".into())])
        .into_connection();
    assert!(metadata::article(&db, &row).await.is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<std::collections::BTreeMap<String, sea_orm::Value>>::new()])
        .append_query_errors([DbErr::Custom("fallback unavailable".into())])
        .into_connection();
    assert!(metadata::article(&db, &row).await.is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([
            Vec::<std::collections::BTreeMap<String, sea_orm::Value>>::new(),
            Vec::<std::collections::BTreeMap<String, sea_orm::Value>>::new(),
        ])
        .append_query_errors([DbErr::Custom("site owner unavailable".into())])
        .into_connection();
    assert!(metadata::article(&db, &row).await.is_err());
}

#[test]
fn directory_pages_are_complete_and_do_not_claim_a_body_read() {
    let body = (1..=25)
        .map(|i| format!("## Section {i}\nbody {i}\n"))
        .collect::<String>();
    let revision = content_revision("标题", &body);
    let first = frame(source(&body), ReadQuery::default()).unwrap();
    assert_eq!(first["sections"].as_array().unwrap().len(), 12);
    assert_eq!(first["sectionsOffset"], 0);
    assert_eq!(first["nextSectionsOffset"], 12);
    let mut offset = 0;
    let mut identifiers = Vec::new();
    loop {
        let page = frame(
            source(&body),
            ReadQuery {
                view: View::Outline,
                offset: Some(offset),
                revision: Some(revision.clone()),
                section_schema: Some(sections::SCHEMA.into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page["view"], "outline");
        assert_eq!(page["content"], "");
        assert!(page["source"].is_null());
        assert_eq!(page["readComplete"], false);
        assert_eq!(page["readOffset"], 0);
        assert!(page["nextOffset"].is_null());
        assert_eq!(page["sectionsOffset"], offset);
        assert_eq!(page["sectionCount"], 25);
        identifiers.extend(
            page["sections"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_str().unwrap().to_string()),
        );
        let Some(next) = page["nextSectionsOffset"].as_u64() else {
            break;
        };
        assert!(next as usize > offset);
        offset = next as usize;
    }
    assert_eq!(
        identifiers,
        (1..=25).map(|i| format!("s{i}")).collect::<Vec<_>>()
    );
    let selected = frame(
        source(&body),
        ReadQuery {
            section: Some("s22".into()),
            revision: Some(revision),
            section_schema: Some(sections::SCHEMA.into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(selected["content"], "body 22\n");
    assert_eq!(selected["source"]["section_id"], "s22");
}

#[test]
fn directory_continuations_reject_wrong_revision_and_invalid_combinations() {
    let body = "## One\nbody\n";
    for query in [
        ReadQuery {
            view: View::Outline,
            offset: Some(1),
            ..Default::default()
        },
        ReadQuery {
            view: View::Outline,
            section: Some("s1".into()),
            ..Default::default()
        },
        ReadQuery {
            view: View::Outline,
            offset: Some(2),
            revision: Some(content_revision("标题", body)),
            section_schema: Some(sections::SCHEMA.into()),
            ..Default::default()
        },
    ] {
        assert_eq!(
            frame(source(body), query).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        frame(
            source(body),
            ReadQuery {
                view: View::Outline,
                revision: Some("0".repeat(64)),
                ..Default::default()
            }
        )
        .unwrap_err()
        .0,
        StatusCode::CONFLICT
    );
}

#[test]
fn metadata_is_not_a_body_read_and_rejects_body_ranges() {
    let mut doc = source("## Private looking text\nbody must not be returned");
    doc.metadata = json!({"authorName":null,"description":"existing summary",
        "authorNameTruncated":false,"descriptionTruncated":false});
    let page = frame(
        doc,
        ReadQuery {
            view: View::Metadata,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(page["metadata"]["description"], "existing summary");
    assert!(page["metadata"]["authorName"].is_null());
    assert!(page.get("content").is_none());
    assert_eq!(page["readComplete"], false);
    assert!(page["source"].is_null());
    assert!(page.get("sections").is_none());
    assert!(page.get("totalChars").is_none());
    for input in [
        json!({"view":"metadata","offset":1}),
        json!({"view":"metadata","section":"title"}),
        json!({"view":"metadata","limit":1}),
    ] {
        let query: ReadQuery = serde_json::from_value(input).unwrap();
        assert!(frame(source("body"), query).is_err());
    }
}
