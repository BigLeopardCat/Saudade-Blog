//! Exercise the mounted customer and staff routes with disposable PostgreSQL and blog identities.
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use saudade_blog::{
    auth_jwt::create_token, create_router, rate_limiter::LoginRateLimiter, risk::PostRateLimiter,
    AppState,
};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let body = match body {
        Some(value) => {
            req = req.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let raw = to_bytes(res.into_body(), 1_000_000).await.unwrap();
    (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
}

async fn account(db: &DatabaseConnection, role: &str) -> (i32, String) {
    let name = format!("support-{}", Uuid::new_v4().simple());
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'x',$2) RETURNING id",
            [name.into(), role.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let id: i32 = row.try_get("", "id").unwrap();
    (id, create_token(id, role, 0))
}

#[tokio::test]
async fn consultation_escalation_staff_handoff_and_private_retries() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("skipped: set TEST_PG_URL to a disposable database");
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let (uid, owner) = account(&db, "user").await;
    let (other_id, other) = account(&db, "user").await;
    let (staff_id, staff) = account(&db, "admin").await;
    let app = create_router(AppState {
        db: Database::connect(std::env::var("TEST_PG_URL").unwrap())
            .await
            .unwrap(),
        rate_limiter: LoginRateLimiter::new(30, 60, 60),
        post_limiter: PostRateLimiter::new(),
        report_limiter: LoginRateLimiter::new(120, 60, 60),
    });
    let user_cases = "/api/protected/support/cases";
    let staff_cases = "/api/protected/admin/support/cases";
    let (status, topics) = call(&app, "GET", "/api/public/support/topics", None, None).await;
    assert_eq!(status, 200);
    assert!(topics["data"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == "guestbook"));
    assert_eq!(call(&app, "GET", user_cases, None, None).await.0, 401);
    assert_eq!(
        call(&app, "GET", staff_cases, Some(&owner), None).await.0,
        403
    );
    let first = json!({"subject":"登录协助","kind":"question","body":"仅提交人和客服可读","requestId":Uuid::new_v4().to_string()});
    let (one, two) = tokio::join!(
        call(&app, "POST", user_cases, Some(&owner), Some(first.clone())),
        call(&app, "POST", user_cases, Some(&owner), Some(first.clone()))
    );
    assert_eq!((one.0, two.0), (200, 200));
    let id = one.1["data"]["id"].as_i64().unwrap();
    assert_eq!(two.1["data"]["id"], id);
    let mut changed = first.clone();
    changed["body"] = json!("another question");
    assert_eq!(
        call(&app, "POST", user_cases, Some(&owner), Some(changed))
            .await
            .0,
        409
    );
    let mine = format!("{user_cases}/{id}");
    let desk = format!("{staff_cases}/{id}");
    let writes = format!("{mine}/events");
    let staff_writes = format!("{desk}/events");
    let write_guidance = |topic: &str| {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT public.support_record_guidance($1,$2)",
            [(id as i32).into(), topic.to_owned().into()],
        )
    };
    db.execute(write_guidance("find-article")).await.unwrap();
    db.execute(write_guidance("guestbook")).await.unwrap();
    let (_, guided) = call(&app, "GET", &mine, Some(&owner), None).await;
    assert_eq!(guided["data"]["guidance"]["topic"]["id"], "find-article");
    assert_eq!(guided["data"]["case"]["version"], 1);
    assert_eq!(call(&app, "GET", &mine, Some(&other), None).await.0, 404);
    let (_, other_list) = call(&app, "GET", user_cases, Some(&other), None).await;
    assert!(other_list["data"]["items"].as_array().unwrap().is_empty());
    let action = |name: &str, version: i32, text: &str| json!({"action":name,"body":text,"version":version,"requestId":Uuid::new_v4().to_string()});
    let escalation = action("escalate", 1, "");
    assert_eq!(
        call(
            &app,
            "POST",
            &writes,
            Some(&other),
            Some(escalation.clone())
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &staff_writes,
            Some(&owner),
            Some(escalation.clone())
        )
        .await
        .0,
        403
    );
    let (status, promoted) = call(&app, "POST", &writes, Some(&owner), Some(escalation)).await;
    assert_eq!(status, 200);
    assert_eq!(promoted["data"]["kind"], "ticket");
    let reply = action("reply", 2, "已受理，请补充出现问题的页面");
    assert_eq!(
        call(
            &app,
            "POST",
            &staff_writes,
            Some(&staff),
            Some(reply.clone())
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(&app, "POST", &staff_writes, Some(&staff), Some(reply))
            .await
            .0,
        200
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &writes,
            Some(&owner),
            Some(action("resolve", 2, ""))
        )
        .await
        .0,
        409
    );
    let (status, history) = call(&app, "GET", &mine, Some(&owner), None).await;
    assert_eq!(status, 200);
    assert_eq!(history["data"]["case"]["status"], "waiting_user");
    let events = history["data"]["events"]["items"].as_array().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[2]["sender"], "staff");
    assert_eq!(
        call(
            &app,
            "POST",
            &writes,
            Some(&owner),
            Some(action("reply", 3, "已补充"))
        )
        .await
        .1["data"]["status"],
        "waiting_staff"
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &staff_writes,
            Some(&staff),
            Some(action("resolve", 4, ""))
        )
        .await
        .1["data"]["status"],
        "resolved"
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &writes,
            Some(&owner),
            Some(action("reply", 5, "closed"))
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &writes,
            Some(&owner),
            Some(action("reopen", 5, ""))
        )
        .await
        .1["data"]["version"],
        6
    );
    let mut ticket = first;
    ticket["kind"] = json!("ticket");
    ticket["requestId"] = json!(Uuid::new_v4().to_string());
    let (_, direct) = call(&app, "POST", user_cases, Some(&owner), Some(ticket)).await;
    assert_eq!(direct["data"]["kind"], "ticket");
    assert_eq!(direct["data"]["assignee"], "assistant");
    let direct_id = direct["data"]["id"].as_i64().unwrap() as i32;
    let (_, staff_queue) = call(&app, "GET", staff_cases, Some(&staff), None).await;
    assert!(staff_queue["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["id"] != direct_id));
    let pending = || {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT event_id, version FROM public.support_pending_turn WHERE case_id=$1",
            [direct_id.into()],
        )
    };
    let source = db.query_one(pending()).await.unwrap().unwrap();
    let publish = |event_id: i32, version: i32, handoff: bool| {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT public.support_publish_assistant($1,$2,$3,'公开解答',$4) AS accepted",
            [
                direct_id.into(),
                event_id.into(),
                version.into(),
                handoff.into(),
            ],
        )
    };
    assert_eq!(source.try_get::<i32>("", "version").unwrap(), 1);
    let source_id: i32 = source.try_get("", "event_id").unwrap();
    for _ in 0..2 {
        let receipt = db
            .query_one(publish(source_id, 1, false))
            .await
            .unwrap()
            .unwrap();
        assert!(receipt.try_get::<bool>("", "accepted").unwrap());
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT public.support_record_guidance($1,'guestbook')",
        [direct_id.into()],
    ))
    .await
    .unwrap();
    let (_, handled) = call(
        &app,
        "GET",
        &format!("{user_cases}/{direct_id}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(handled["data"]["guidance"], Value::Null);
    assert_eq!(handled["data"]["case"]["kind"], "ticket");
    assert_eq!(handled["data"]["case"]["status"], "waiting_user");
    assert_eq!(handled["data"]["case"]["assignee"], "assistant");
    let timeline = handled["data"]["events"]["items"].as_array().unwrap();
    assert_eq!(timeline.len(), 2);
    assert_eq!(timeline[1]["sender"], "assistant");
    let direct_writes = format!("{user_cases}/{direct_id}/events");
    assert_eq!(
        call(
            &app,
            "POST",
            &direct_writes,
            Some(&owner),
            Some(action("reply", 2, "需要人工核实"))
        )
        .await
        .0,
        200
    );
    let updated = db.query_one(pending()).await.unwrap().unwrap();
    let next_source: i32 = updated.try_get("", "event_id").unwrap();
    let receipt = db
        .query_one(publish(next_source, 3, true))
        .await
        .unwrap()
        .unwrap();
    assert!(receipt.try_get::<bool>("", "accepted").unwrap());
    assert!(db.query_one(pending()).await.unwrap().is_none());
    let (_, staff_queue) = call(&app, "GET", staff_cases, Some(&staff), None).await;
    assert!(staff_queue["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == direct_id && item["assignee"] == "staff"));
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE \"user\" SET role='user' WHERE id=$1",
        [staff_id.into()],
    ))
    .await
    .unwrap();
    assert_eq!(call(&app, "GET", &desk, Some(&staff), None).await.0, 403);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM \"user\" WHERE id IN ($1,$2,$3)",
        [uid.into(), other_id.into(), staff_id.into()],
    ))
    .await
    .unwrap();
}
