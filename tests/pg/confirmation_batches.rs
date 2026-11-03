use super::*;
use serde_json::json;

const OWNER: i32 = 910050001;
const OTHER: i32 = 910050002;

#[tokio::test]
async fn selected_todo_batch_is_atomic_version_bound_and_owner_scoped() {
    let Some((db, app_db)) = connect_pair().await else {
        return;
    };
    make_user(&db, OWNER, "admin").await;
    make_user(&db, OTHER, "admin").await;
    exec(
        &db,
        &format!("DELETE FROM dashboard_todo WHERE user_id IN ({OWNER},{OTHER})"),
    )
    .await;
    let app = test_app(app_db);
    let token = auth_jwt::create_token(OWNER, "admin", 0);
    let other = auth_jwt::create_token(OTHER, "admin", 0);
    let mut rows = Vec::new();
    for name in ["first", "second", "third"] {
        let (_, response) = call(
            app.clone(),
            "POST",
            "/api/protected/todos/item",
            Some(&token),
            Some(&json!({"text":name}).to_string()),
        )
        .await;
        assert_eq!(response["code"], 200, "{response}");
        rows.push(response["data"].clone());
    }
    let (_, response) = call(
        app.clone(),
        "POST",
        "/api/protected/todos/item",
        Some(&other),
        Some(&json!({"text":"other owner"}).to_string()),
    )
    .await;
    assert_eq!(response["code"], 200, "{response}");
    let foreign = response["data"].clone();
    let ids = rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>();
    let (_, prepared) = call(
        app.clone(),
        "POST",
        "/api/protected/todos/batch/prepare",
        Some(&token),
        Some(&json!({"ids":ids}).to_string()),
    )
    .await;
    assert_eq!(prepared["code"], 200, "{prepared}");
    assert_eq!(prepared["data"].as_array().unwrap().len(), 3);
    let item = |row: &serde_json::Value| json!({"id":row["id"],"version":row["version"],"text":row["text"]});
    let items = rows.iter().map(item).collect::<Vec<_>>();

    let mut stale = items.clone();
    stale[1]["version"] = json!("1990-01-01 00:00:00.000001");
    let (_, rejected) = call(
        app.clone(),
        "DELETE",
        "/api/protected/todos/batch",
        Some(&token),
        Some(&json!({"items":stale}).to_string()),
    )
    .await;
    assert_ne!(rejected["code"], 200);
    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM dashboard_todo WHERE user_id={OWNER}")
        )
        .await,
        3,
        "a later stale item must roll back earlier deletions"
    );

    let (_, foreign_rejected) = call(
        app.clone(),
        "DELETE",
        "/api/protected/todos/batch",
        Some(&token),
        Some(&json!({"items":[items[0],item(&foreign)]}).to_string()),
    )
    .await;
    assert_ne!(foreign_rejected["code"], 200);
    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM dashboard_todo WHERE user_id={OWNER}")
        )
        .await,
        3
    );
    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM dashboard_todo WHERE user_id={OTHER}")
        )
        .await,
        1
    );

    let selected = json!({"items":[items[0],items[2]]}).to_string();
    let (_, removed) = call(
        app.clone(),
        "DELETE",
        "/api/protected/todos/batch",
        Some(&token),
        Some(&selected),
    )
    .await;
    assert_eq!(removed["code"], 200, "{removed}");
    assert_eq!(removed["data"].as_array().unwrap().len(), 2);
    assert_eq!(
        count_of(
            &db,
            &format!("SELECT COUNT(*) FROM dashboard_todo WHERE user_id={OWNER}")
        )
        .await,
        1
    );
    assert_eq!(
        count_of(
            &db,
            &format!(
                "SELECT COUNT(*) FROM dashboard_todo WHERE id={}",
                rows[1]["id"]
            )
        )
        .await,
        1
    );
    let (_, replay) = call(
        app,
        "DELETE",
        "/api/protected/todos/batch",
        Some(&token),
        Some(&selected),
    )
    .await;
    assert_ne!(replay["code"], 200);
    exec(
        &db,
        &format!("DELETE FROM dashboard_todo WHERE user_id IN ({OWNER},{OTHER})"),
    )
    .await;
    exec(
        &db,
        &format!("DELETE FROM \"user\" WHERE id IN ({OWNER},{OTHER})"),
    )
    .await;
}
