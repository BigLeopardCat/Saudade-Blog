//! PostgreSQL pool initialization for the site's existing local timestamp columns.

use sqlx::{postgres::PgPoolOptions, PgPool};

pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .after_connect(|connection, _| {
            Box::pin(async move {
                // SQLx sends TimeZone=UTC during startup, overriding startup options.
                sqlx::query("SET TIME ZONE 'Asia/Shanghai'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(url)
        .await
}
