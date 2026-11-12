//! Explicit first-install bootstrap. Credentials are read from a private JSON file.
use serde::Deserialize;
use sqlx::{postgres::PgPoolOptions, Row};
use std::{env, fs::File, io::Read, process::ExitCode, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    username: String,
    nickname: String,
    password: String,
}

impl Credentials {
    fn validate(&self) -> Result<(), &'static str> {
        if !(3..=64).contains(&self.username.len())
            || !self
                .username
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            || self.nickname.trim().is_empty()
            || self.nickname.chars().count() > 64
            || !(12..=1024).contains(&self.password.len())
        {
            return Err("invalid administrator credentials");
        }
        Ok(())
    }
}

async fn run() -> Result<(), &'static str> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err("usage: saudade-bootstrap-admin PRIVATE_JSON_FILE");
    }
    let file = File::open(&args[0]).map_err(|_| "cannot read administrator credential file")?;
    let mut bytes = Vec::new();
    file.take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read credential file")?;
    if bytes.len() > 16_384 {
        return Err("administrator credential file is too large");
    }
    let credentials: Credentials =
        serde_json::from_slice(&bytes).map_err(|_| "invalid administrator credential JSON")?;
    credentials.validate()?;
    let url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    if !(url.starts_with("postgres://") || url.starts_with("postgresql://")) {
        return Err("PostgreSQL is required");
    }
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&url)
        .await
        .map_err(|_| "cannot connect to bootstrap database")?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| "cannot start bootstrap transaction")?;
    sqlx::query("SET LOCAL lock_timeout = '5s'")
        .execute(&mut *tx)
        .await
        .map_err(|_| "cannot set bootstrap lock timeout")?;
    sqlx::query("LOCK TABLE public.\"user\" IN EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await
        .map_err(|_| "cannot lock administrator table")?;
    let row = sqlx::query("SELECT count(*) AS total, count(*) FILTER (WHERE role = 'admin') AS admins FROM public.\"user\"")
        .fetch_one(&mut *tx).await.map_err(|_| "cannot check administrator state")?;
    if row.get::<i64, _>("admins") > 0 {
        println!("Administrator already exists; credentials and roles unchanged");
        return Ok(());
    }
    if row.get::<i64, _>("total") != 0 {
        return Err("bootstrap requires an empty user table; no existing account was changed");
    }
    let password = saudade_blog::utils::hash_password(&credentials.password);
    sqlx::query("INSERT INTO public.\"user\" (username, nickname, password, role) VALUES ($1, $2, $3, 'admin')")
        .bind(&credentials.username).bind(&credentials.nickname).bind(password)
        .execute(&mut *tx).await.map_err(|_| "cannot create first administrator")?;
    tx.commit()
        .await
        .map_err(|_| "cannot commit administrator bootstrap")?;
    println!("First administrator created with Argon2id");
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_weak_credentials_and_unknown_privilege_fields() {
        let mut credentials = Credentials {
            username: "admin".into(),
            nickname: "站长".into(),
            password: "short".into(),
        };
        assert!(credentials.validate().is_err());
        credentials.password = "a private password".into();
        assert!(credentials.validate().is_ok());
        credentials.username = "admin; DROP TABLE user".into();
        assert!(credentials.validate().is_err());
        assert!(serde_json::from_str::<Credentials>(
            r#"{"username":"admin","nickname":"站长","password":"a private password","role":"admin"}"#
        ).is_err());
    }
}
