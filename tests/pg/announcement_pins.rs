use super::*;

#[tokio::test]
async fn pinned_announcements_merge_concurrent_toggles_and_hide_deleted_rows() {
    let Some((db, app_db)) = connect_pair().await else {
        return;
    };
    const FIRST: i32 = 920090001;
    const SECOND: i32 = 920090002;
    const ADMIN: i32 = 920090003;
    const READER: i32 = 920090004;
    make_user(&db, ADMIN, "admin").await;
    make_user(&db, READER, "user").await;
    exec(
        &db,
        "DELETE FROM web_info WHERE key_name='pinnedAnnouncements'",
    )
    .await;
    exec(
        &db,
        &format!("DELETE FROM announcement WHERE id IN ({FIRST},{SECOND})"),
    )
    .await;
    exec(&db, &format!("INSERT INTO announcement (id,title,content,created_at,updated_at) VALUES ({FIRST},'first pin','first body',NOW(),NOW()),({SECOND},'second pin','second body',NOW(),NOW())")).await;
    let app = test_app(app_db);
    let token = auth_jwt::create_token(ADMIN, "admin", 0);
    let first = format!("/api/protected/announcements/{FIRST}/pin");
    let second = format!("/api/protected/announcements/{SECOND}/pin");
    let (anonymous, _) = call(app.clone(), "PUT", &first, None, Some(r#"{"pinned":true}"#)).await;
    assert_eq!(anonymous, StatusCode::UNAUTHORIZED);
    let reader = auth_jwt::create_token(READER, "user", 0);
    let (forbidden, _) = call(
        app.clone(),
        "PUT",
        &first,
        Some(&reader),
        Some(r#"{"pinned":true}"#),
    )
    .await;
    assert_eq!(forbidden, StatusCode::FORBIDDEN);
    let ((_, left), (_, right)) = tokio::join!(
        call(
            app.clone(),
            "PUT",
            &first,
            Some(&token),
            Some(r#"{"pinned":true}"#)
        ),
        call(
            app.clone(),
            "PUT",
            &second,
            Some(&token),
            Some(r#"{"pinned":true}"#)
        ),
    );
    assert_eq!(left["code"], 200, "{left}");
    assert_eq!(right["code"], 200, "{right}");
    let (_, pinned) = call(
        app.clone(),
        "GET",
        "/api/public/pinned-announcements",
        None,
        None,
    )
    .await;
    assert_eq!(pinned["data"].as_array().unwrap().len(), 2, "{pinned}");
    assert_eq!(pinned["data"][0]["id"], SECOND);
    assert!(!pinned["data"][0]["createdAt"].as_str().unwrap().is_empty());
    let (_, again) = call(
        app.clone(),
        "PUT",
        &first,
        Some(&token),
        Some(r#"{"pinned":true}"#),
    )
    .await;
    assert_eq!(again["code"], 200, "{again}");
    let (_, unpin) = call(
        app.clone(),
        "PUT",
        &first,
        Some(&token),
        Some(r#"{"pinned":false}"#),
    )
    .await;
    assert_eq!(unpin["code"], 200, "{unpin}");
    let (_, pinned) = call(
        app.clone(),
        "GET",
        "/api/public/pinned-announcements",
        None,
        None,
    )
    .await;
    assert_eq!(pinned["data"].as_array().unwrap().len(), 1, "{pinned}");
    assert_eq!(pinned["data"][0]["id"], SECOND);
    exec(&db, &format!("DELETE FROM announcement WHERE id={SECOND}")).await;
    let (_, pinned) = call(
        app.clone(),
        "GET",
        "/api/public/pinned-announcements",
        None,
        None,
    )
    .await;
    assert_eq!(pinned["data"], serde_json::json!([]));
    let (_, missing) = call(
        app,
        "PUT",
        &second,
        Some(&token),
        Some(r#"{"pinned":true}"#),
    )
    .await;
    assert_ne!(missing["code"], 200);
    exec(
        &db,
        "DELETE FROM web_info WHERE key_name='pinnedAnnouncements'",
    )
    .await;
    exec(&db, &format!("DELETE FROM announcement WHERE id={FIRST}")).await;
}
