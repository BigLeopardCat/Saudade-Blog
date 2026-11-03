use super::*;
use serde_json::json;

const ADMIN: i32 = 910040001;
const ARTICLE: i32 = 910040002;

#[tokio::test]
async fn editor_versions_serialize_autosaves_and_publication_without_losing_drafts() {
    let Some((db, app_db)) = connect_pair().await else {
        return;
    };
    make_user(&db, ADMIN, "admin").await;
    make_owned_note(&db, ARTICLE, ADMIN).await;
    exec(&db, &format!("DELETE FROM note WHERE draft_of={ARTICLE}")).await;
    let app = test_app(app_db);
    let admin = auth_jwt::create_token(ADMIN, "admin", 0);
    let uri = format!("/api/protected/draft/editor/{ARTICLE}");
    let (_, initial) = call(app.clone(), "GET", &uri, Some(&admin), None).await;
    assert_eq!(initial["code"], 200, "{initial}");
    let version = initial["data"]["version"].as_str().unwrap();
    assert_eq!(version.len(), 64);
    let old_body = initial["data"]["note"]["noteContent"].clone();
    let first = json!({"id":ARTICLE,"expectedVersion":version,"noteContent":"first draft","description":"first summary"}).to_string();
    let second = json!({"id":ARTICLE,"expectedVersion":version,"noteContent":"second draft","description":"second summary"}).to_string();
    let ((_, a), (_, b)) = tokio::join!(
        call(
            app.clone(),
            "POST",
            "/api/protected/draft/autosave",
            Some(&admin),
            Some(&first)
        ),
        call(
            app.clone(),
            "POST",
            "/api/protected/draft/autosave",
            Some(&admin),
            Some(&second)
        )
    );
    let mut codes = vec![a["code"].as_i64().unwrap(), b["code"].as_i64().unwrap()];
    codes.sort();
    assert_eq!(codes, vec![200, 409], "{a} {b}");
    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM note WHERE draft_of={ARTICLE}")
        )
        .await,
        1
    );
    let winner = if a["code"] == 200 { a } else { b };
    let next_version = winner["data"]["version"].as_str().unwrap();
    assert_ne!(next_version, version);
    let shadow = winner["data"]["draftId"].as_i64().unwrap();
    let (_, opened) = call(
        app.clone(),
        "GET",
        &format!("/api/protected/draft/editor/{shadow}"),
        Some(&admin),
        None,
    )
    .await;
    assert_eq!(opened["data"]["version"], next_version);
    assert_eq!(opened["data"]["note"]["noteContent"], old_body);
    assert!(opened["data"]["draft"]["description"]
        .as_str()
        .unwrap()
        .ends_with("summary"));

    let missing = json!({"id":ARTICLE,"noteContent":"missing version"}).to_string();
    let (_, missing) = call(
        app.clone(),
        "POST",
        "/api/protected/draft/autosave",
        Some(&admin),
        Some(&missing),
    )
    .await;
    assert_eq!(missing["code"], 409);
    let publish_uri = format!("/api/protected/notes/{ARTICLE}");
    let stale = json!({"expectedVersion":version,"noteTitle":"stale","noteContent":"stale body","status":"public"}).to_string();
    let (_, stale) = call(
        app.clone(),
        "POST",
        &publish_uri,
        Some(&admin),
        Some(&stale),
    )
    .await;
    assert_eq!(stale["code"], 409);
    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM note WHERE draft_of={ARTICLE}")
        )
        .await,
        1
    );

    let publish = json!({"expectedVersion":next_version,"noteTitle":"reviewed title","noteContent":"reviewed body",
        "description":"reviewed summary","status":"public"}).to_string();
    let (_, published) = call(
        app.clone(),
        "POST",
        &publish_uri,
        Some(&admin),
        Some(&publish),
    )
    .await;
    assert_eq!(published["code"], 200, "{published}");
    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM note WHERE draft_of={ARTICLE}")
        )
        .await,
        0
    );
    let old_save =
        json!({"id":ARTICLE,"expectedVersion":next_version,"noteContent":"late save"}).to_string();
    let (_, late) = call(
        app.clone(),
        "POST",
        "/api/protected/draft/autosave",
        Some(&admin),
        Some(&old_save),
    )
    .await;
    assert_eq!(late["code"], 409);
    let (_, final_copy) = call(app.clone(), "GET", &uri, Some(&admin), None).await;
    assert_eq!(final_copy["data"]["note"]["noteContent"], "reviewed body");
    assert_eq!(
        final_copy["data"]["note"]["description"],
        "reviewed summary"
    );
    assert!(final_copy["data"]["draft"].is_null());
    let (unauthorized, _) = call(app, "GET", &uri, None, None).await;
    assert_eq!(unauthorized, StatusCode::UNAUTHORIZED);
    exec(
        &db,
        &format!("DELETE FROM note WHERE id={ARTICLE} OR draft_of={ARTICLE}"),
    )
    .await;
    exec(&db, &format!("DELETE FROM \"user\" WHERE id={ADMIN}")).await;
}
