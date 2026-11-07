use super::*;
use sea_orm::{Database, MockDatabase};

#[tokio::test]
async fn failed_relationship_read_is_not_an_absent_relationship() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("unavailable".into())])
        .into_connection();
    assert!(state(&db, 7, 19).await.is_err());
}

#[tokio::test]
async fn postgres_favorite_facts_are_owned_visibility_safe_and_idempotent() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let mut owners = Vec::new();
    for _ in 0..2 {
        let row = tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\"(username,password,role) VALUES($1,'fixture','user') RETURNING id",
            [uuid::Uuid::new_v4().simple().to_string().into()])).await.unwrap().unwrap();
        owners.push(row.try_get::<i32>("", "id").unwrap());
    }
    let id = tx.query_one(Statement::from_string(DatabaseBackend::Postgres,
        "INSERT INTO note(title,content,status,is_public,created_at,updated_at) \
         VALUES('public title','BODY_MUST_NOT_TRANSFER','public',true,localtimestamp,localtimestamp) RETURNING id"))
        .await.unwrap().unwrap().try_get::<i32>("", "id").unwrap();
    let first = add_in(&tx, owners[0], id).await.unwrap();
    let repeated = add_in(&tx, owners[0], id).await.unwrap();
    assert!(first.changed && first.is_favorite && !repeated.changed && repeated.is_favorite);
    assert_eq!(first.owner_user_id, owners[0]);
    assert!(!state(&tx, owners[1], id).await.unwrap().is_favorite);
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE note SET status='private',is_public=false,title='SECRET_TITLE' WHERE id=$1",
        [id.into()],
    ))
    .await
    .unwrap();
    let hidden = state(&tx, owners[0], id).await.unwrap();
    assert!(hidden.is_favorite && !hidden.article_available && hidden.title.is_none());
    let outsider = remove_in(&tx, owners[1], id).await.unwrap();
    assert!(!outsider.changed);
    assert!(state(&tx, owners[0], id).await.unwrap().is_favorite);
    assert!(add_in(&tx, owners[1], id).await.is_err());
    let removed = remove_in(&tx, owners[0], id).await.unwrap();
    assert!(removed.changed && !removed.is_favorite);
    assert!(!remove_in(&tx, owners[0], id).await.unwrap().changed);
    assert!(add_in(&tx, owners[0], 0).await.is_err());
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn postgres_favorite_list_handler_excludes_hidden_revisions_and_other_owners() {
    use crate::rate_limiter::LoginRateLimiter;
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let mut owners = Vec::new();
    for _ in 0..2 {
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\"(username,password,role,status) VALUES($1,'fixture','user',0) RETURNING id",
            [uuid::Uuid::new_v4().simple().to_string().into()])).await.unwrap().unwrap();
        owners.push(row.try_get::<i32>("", "id").unwrap());
    }
    let mut ids = Vec::new();
    for (title, status, visible) in [
        ("public", "public", true),
        ("published", "published", true),
        ("private", "private", false),
        ("draft", "draft", false),
        ("revision", "public", true),
        ("other owner", "public", true),
    ] {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO note(title,content,status,is_public,created_at,updated_at) \
             VALUES($1,'BODY_MUST_NOT_TRANSFER',$2,$3,localtimestamp,localtimestamp) RETURNING id",
                [title.into(), status.into(), visible.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        ids.push(row.try_get::<i32>("", "id").unwrap());
    }
    db.execute(statement(
        "UPDATE note SET draft_of=$1 WHERE id=$2",
        ids[0],
        ids[4],
    ))
    .await
    .unwrap();
    for (index, id) in ids.iter().enumerate() {
        let owner = if index == 5 { owners[1] } else { owners[0] };
        db.execute(statement(
            "INSERT INTO user_favorite(user_id,note_id) VALUES($1,$2)",
            owner,
            *id,
        ))
        .await
        .unwrap();
    }
    let app = Arc::new(AppState {
        db,
        rate_limiter: LoginRateLimiter::new(1, 60, 60),
        post_limiter: crate::risk::PostRateLimiter::default(),
        report_limiter: LoginRateLimiter::new(1, 60, 60),
    });
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        format!(
            "Bearer {}",
            crate::auth_jwt::create_token(owners[0], "user", 0)
        )
        .parse()
        .unwrap(),
    );
    let response = list_favorites(State(app.clone()), headers).await.0;
    let mut actual: Vec<_> = response.data.iter().map(|item| item.note_id).collect();
    actual.sort_unstable();
    // Clean committed fixtures before asserting the handler result.
    for owner in &owners {
        app.db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM user_favorite WHERE user_id=$1",
                [(*owner).into()],
            ))
            .await
            .unwrap();
    }
    for id in ids.iter().rev() {
        app.db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM note WHERE id=$1",
                [(*id).into()],
            ))
            .await
            .unwrap();
    }
    for owner in &owners {
        app.db
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM \"user\" WHERE id=$1",
                [(*owner).into()],
            ))
            .await
            .unwrap();
    }
    assert_eq!(response.code, 200);
    assert_eq!(actual, ids[..2]);
    assert!(response
        .data
        .iter()
        .all(|item| matches!(item.title.as_str(), "public" | "published")));
}
