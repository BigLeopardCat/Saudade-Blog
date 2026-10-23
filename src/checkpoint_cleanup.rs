//! Transactional outbox for conversation checkpoint deletion.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, FromQueryResult, Statement};
use std::time::Duration;

#[derive(Debug, FromQueryResult)]
struct Job {
    conversation_id: i32,
    user_id: i32,
    attempts: i32,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("internal HTTP client")
}

pub(crate) async fn enqueue<C: ConnectionTrait>(
    db: &C,
    conversation_id: i32,
    uid: i32,
) -> Result<(), DbErr> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO agent_checkpoint_cleanup(conversation_id,user_id) VALUES($1,$2) \
         ON CONFLICT(conversation_id) DO NOTHING",
        vec![conversation_id.into(), uid.into()],
    ))
    .await?;
    Ok(())
}

async fn claim<C: ConnectionTrait>(db: &C, id: Option<i32>) -> Result<Option<Job>, DbErr> {
    // Short atomic lease; a crashed worker releases no lock across the HTTP call.
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "WITH due AS (SELECT conversation_id FROM agent_checkpoint_cleanup \
         WHERE next_attempt_at<=CURRENT_TIMESTAMP AND ($1::integer IS NULL OR conversation_id=$1) \
         ORDER BY next_attempt_at,conversation_id LIMIT 1 FOR UPDATE SKIP LOCKED) \
         UPDATE agent_checkpoint_cleanup j SET attempts=attempts+1, \
         next_attempt_at=CURRENT_TIMESTAMP+interval '90 seconds' FROM due \
         WHERE j.conversation_id=due.conversation_id \
         RETURNING j.conversation_id,j.user_id,j.attempts",
            vec![id.into()],
        ))
        .await?;
    row.map(|row| Job::from_query_result(&row, "")).transpose()
}

async fn request(
    client: &reqwest::Client,
    base: &str,
    job: &Job,
    assertion: &str,
) -> Result<(), &'static str> {
    let response = client
        .delete(format!(
            "{base}/checkpoint/{}?uid={}",
            job.conversation_id, job.user_id
        ))
        .header("X-Agent-Assertion", assertion)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| "transport")?;
    if !response.status().is_success() {
        return Err("http_status");
    }
    let body: serde_json::Value = response.json().await.map_err(|_| "invalid_response")?;
    if body.get("deleted").and_then(|value| value.as_bool()) != Some(true) {
        return Err("deletion_unverified");
    }
    Ok(())
}

async fn finish<C: ConnectionTrait>(
    db: &C,
    job: &Job,
    outcome: Result<(), &'static str>,
) -> Result<(), DbErr> {
    match outcome {
        Ok(()) => {
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "DELETE FROM agent_checkpoint_cleanup WHERE conversation_id=$1 AND attempts=$2",
                vec![job.conversation_id.into(), job.attempts.into()],
            ))
            .await?;
        }
        Err(reason) => {
            let delay = (5_i32.saturating_mul(2_i32.pow(job.attempts.clamp(0, 6) as u32))).min(300);
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE agent_checkpoint_cleanup SET last_error=$3, \
                 next_attempt_at=CURRENT_TIMESTAMP+($4*interval '1 second') \
                 WHERE conversation_id=$1 AND attempts=$2",
                vec![
                    job.conversation_id.into(),
                    job.attempts.into(),
                    reason.into(),
                    delay.into(),
                ],
            ))
            .await?;
            tracing::warn!(
                conversation_id = job.conversation_id,
                attempt = job.attempts,
                reason,
                "checkpoint 删除待重试"
            );
        }
    }
    Ok(())
}

async fn deliver(
    db: &DatabaseConnection,
    client: &reqwest::Client,
    id: Option<i32>,
) -> Result<bool, DbErr> {
    let Some(job) = claim(db, id).await? else {
        return Ok(false);
    };
    let assertion = crate::auth_jwt::create_agent_assertion(job.user_id, None);
    let outcome = request(
        client,
        &crate::routes::graph::agent_base_url(),
        &job,
        &assertion,
    )
    .await;
    finish(db, &job, outcome).await?;
    Ok(true)
}

pub(crate) async fn dispatch(db: &DatabaseConnection, ids: &[i32]) {
    let client = client();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    for id in ids {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        if let Err(error) = deliver(db, &client, Some(*id)).await {
            tracing::warn!(%error, conversation_id=id, "checkpoint 删除交付失败，任务仍在队列中");
        }
    }
}

pub fn start(db: DatabaseConnection) {
    tokio::spawn(async move {
        let client = client();
        let mut ticks = tokio::time::interval(Duration::from_secs(5));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            for _ in 0..20 {
                match deliver(&db, &client, None).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        tracing::error!(%error, "checkpoint 删除队列处理失败");
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
#[path = "checkpoint_cleanup_tests.rs"]
mod tests;
