use super::*;
use sea_orm::{Database, DatabaseBackend, Statement};
use serde_json::json;
fn intent(value: serde_json::Value) -> Intent {
    serde_json::from_value(value).unwrap()
}
#[test]
fn invalid_targets_and_content_fail_without_database_access() {
    for value in [
        json!({"action":"create"}),
        json!({"action":"create","id":1,"fields":{"content":"x"}}),
        json!({"action":"update","id":1}),
        json!({"action":"delete","id":1,"fields":{"title":"x"}}),
        json!({"action":"create","fields":{"content":" ","title":"x"}}),
        json!({"action":"create","fields":{"content":"x".repeat(501)}}),
        json!({"action":"create","fields":{"content":"x","title":"x\n"}}),
    ] {
        assert!(validate(&intent(value)).is_err());
    }
    assert!(serde_json::from_value::<Intent>(
        json!({"action":"create","fields":{"content":"x"},"authorId":99})
    )
    .is_err());
}
#[tokio::test]
async fn postgres_posts_preserve_author_reject_guestbook_and_stale_or_revoked_operations() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    let name = format!("post_{}", uuid::Uuid::new_v4().simple());
    let uid:i32=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO \"user\"(username,nickname,password,role) VALUES($1,$1,'fixture','admin') RETURNING id",
        [name.clone().into()])).await.unwrap().unwrap().try_get("","id").unwrap();
    let create =
        intent(json!({"action":"create","fields":{"title":"标题","content":" 原文\n😀 "}}));
    let prepared = plan(&txn, uid, &create).await.unwrap();
    assert!(prepared.before.is_none());
    let created = apply(
        &txn,
        uid,
        &Change {
            version: prepared.version,
            intent: create,
        },
    )
    .await
    .unwrap();
    let post = created.state.after.unwrap();
    let id = post.id.unwrap();
    assert_eq!(post.author_id, uid);
    assert_eq!(post.content, " 原文\n😀 ");
    let board:i32=txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO talk(content,cat,v,author,user_id,src,created_at,updated_at) VALUES('guestbook','愿',0,'display',$1,'board',localtimestamp,localtimestamp) RETURNING id",
        [uid.into()])).await.unwrap().unwrap().try_get("","id").unwrap();
    assert!(
        plan(&txn, uid, &intent(json!({"action":"delete","id":board})))
            .await
            .is_err()
    );
    assert!(talk::Entity::find_by_id(board)
        .one(&txn)
        .await
        .unwrap()
        .is_some());
    let update = intent(json!({"action":"update","id":id,"fields":{"content":"新正文"}}));
    let old = plan(&txn, uid, &update).await.unwrap();
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE talk SET title='changed' WHERE id=$1",
        [id.into()],
    ))
    .await
    .unwrap();
    assert!(apply(
        &txn,
        uid,
        &Change {
            version: old.version,
            intent: update.clone()
        }
    )
    .await
    .is_err());
    let fresh = plan(&txn, uid, &update).await.unwrap();
    let changed = apply(
        &txn,
        uid,
        &Change {
            version: fresh.version,
            intent: update,
        },
    )
    .await
    .unwrap();
    assert_eq!(changed.state.after.as_ref().unwrap().author_id, uid);
    assert_eq!(changed.state.after.unwrap().title, "changed");
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE \"user\" SET role='user' WHERE id=$1",
        [uid.into()],
    ))
    .await
    .unwrap();
    assert!(plan(&txn, uid, &intent(json!({"action":"delete","id":id})))
        .await
        .is_err());
    assert!(talk::Entity::find_by_id(id)
        .one(&txn)
        .await
        .unwrap()
        .is_some());
    txn.rollback().await.unwrap();
}
