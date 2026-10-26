//! The real application pool must preserve local wall time on every connection.

#[tokio::test]
async fn application_pool_applies_timezone_after_sqlx_startup() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let pool = saudade_blog::database::connect(&url).await.unwrap();
    let mut first = pool.acquire().await.unwrap();
    let mut second = pool.acquire().await.unwrap();
    for connection in [&mut *first, &mut *second] {
        let timezone: String = sqlx::query_scalar("SHOW TimeZone")
            .fetch_one(connection)
            .await
            .unwrap();
        assert_eq!(timezone, "Asia/Shanghai");
    }
    drop((first, second));

    let mut transaction = pool.begin().await.unwrap();
    sqlx::query("CREATE TEMP TABLE timestamp_probe (created_at timestamp DEFAULT CURRENT_TIMESTAMP) ON COMMIT DROP")
        .execute(&mut *transaction).await.unwrap();
    let correct: bool = sqlx::query_scalar("INSERT INTO timestamp_probe DEFAULT VALUES RETURNING created_at = CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'")
        .fetch_one(&mut *transaction).await.unwrap();
    assert!(
        correct,
        "DEFAULT timestamps must use the site's local wall time"
    );
    transaction.rollback().await.unwrap();
    pool.close().await;
}
