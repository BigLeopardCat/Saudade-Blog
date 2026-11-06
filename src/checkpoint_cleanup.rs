//! Transactional outbox for conversation and stable user-turn cleanup.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, FromQueryResult, Statement};
use std::time::Duration;

#[derive(Debug, FromQueryResult)]
struct Job {
    conversation_id: i32,
    user_id: i32,
    attempts: i32,
    turn_id: String,
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
        "DELETE FROM agent_checkpoint_cleanup WHERE conversation_id=$1 AND turn_id<>''",
        vec![conversation_id.into()],
    ))
    .await?;
    enqueue_turn(db, conversation_id, uid, "").await
}

pub(crate) async fn enqueue_turn<C: ConnectionTrait>(
    db: &C,
    conversation_id: i32,
    uid: i32,
    turn_id: &str,
) -> Result<(), DbErr> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO agent_checkpoint_cleanup(conversation_id,user_id,turn_id) VALUES($1,$2,$3) \
         ON CONFLICT(conversation_id,turn_id) DO NOTHING",
        vec![conversation_id.into(), uid.into(), turn_id.into()],
    ))
    .await?;
    Ok(())
}

pub(crate) async fn has_pending_turn<C: ConnectionTrait>(
    db: &C,
    conversation_id: i32,
) -> Result<bool, DbErr> {
    Ok(db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM agent_checkpoint_cleanup WHERE conversation_id=$1 AND turn_id<>'' AND delivered_at IS NULL LIMIT 1",
        vec![conversation_id.into()])).await?.is_some())
}

pub(crate) async fn turn_discarded<C: ConnectionTrait>(
    db: &C,
    conversation_id: i32,
    turn_id: &str,
) -> Result<bool, DbErr> {
    Ok(db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM agent_checkpoint_cleanup WHERE conversation_id=$1 AND turn_id=$2 LIMIT 1",
        vec![conversation_id.into(),turn_id.into()])).await?.is_some())
}

async fn claim_matching<C: ConnectionTrait>(
    db: &C,
    id: Option<i32>,
    turn_id: Option<&str>,
) -> Result<Option<Job>, DbErr> {
    // Short atomic lease; no database lock spans the HTTP call.
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "WITH due AS (SELECT conversation_id,turn_id FROM agent_checkpoint_cleanup \
         WHERE delivered_at IS NULL AND next_attempt_at<=CURRENT_TIMESTAMP AND ($1::integer IS NULL OR conversation_id=$1) \
         AND ($2::text IS NULL OR turn_id=$2) ORDER BY next_attempt_at,conversation_id,turn_id LIMIT 1 FOR UPDATE SKIP LOCKED) \
         UPDATE agent_checkpoint_cleanup j SET attempts=attempts+1, \
         next_attempt_at=CURRENT_TIMESTAMP+interval '90 seconds' FROM due \
         WHERE j.conversation_id=due.conversation_id AND j.turn_id=due.turn_id \
         RETURNING j.conversation_id,j.user_id,j.attempts,j.turn_id",
            vec![id.into(),turn_id.into()],
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
    let request = if job.turn_id.is_empty() {
        client.delete(format!(
            "{base}/checkpoint/{}?uid={}",
            job.conversation_id, job.user_id
        ))
    } else {
        client
            .post(format!(
                "{base}/checkpoint/{}/drop_turn",
                job.conversation_id
            ))
            .json(&serde_json::json!({"uid":job.user_id,"turn_id":job.turn_id}))
    };
    let response = request
        .header("X-Agent-Assertion", assertion)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| "transport")?;
    if !response.status().is_success() {
        return Err("http_status");
    }
    let body: serde_json::Value = response.json().await.map_err(|_| "invalid_response")?;
    if body
        .get(if job.turn_id.is_empty() {
            "deleted"
        } else {
            "dropped"
        })
        .and_then(|value| value.as_bool())
        != Some(true)
    {
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
            // Acknowledged turn rows fence delayed requests until the conversation is deleted.
            let query = if job.turn_id.is_empty() {
                "DELETE FROM agent_checkpoint_cleanup WHERE conversation_id=$1 AND turn_id=$2 AND attempts=$3"
            } else {
                "UPDATE agent_checkpoint_cleanup SET delivered_at=CURRENT_TIMESTAMP,last_error=NULL \
                 WHERE conversation_id=$1 AND turn_id=$2 AND attempts=$3"
            };
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                query,
                vec![
                    job.conversation_id.into(),
                    job.turn_id.clone().into(),
                    job.attempts.into(),
                ],
            ))
            .await?;
        }
        Err(reason) => {
            let delay = (5_i32.saturating_mul(2_i32.pow(job.attempts.clamp(0, 6) as u32))).min(300);
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE agent_checkpoint_cleanup SET last_error=$4, \
                 next_attempt_at=CURRENT_TIMESTAMP+($5*interval '1 second') \
                 WHERE conversation_id=$1 AND turn_id=$2 AND attempts=$3",
                vec![
                    job.conversation_id.into(),
                    job.turn_id.clone().into(),
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
    turn_id: Option<&str>,
) -> Result<bool, DbErr> {
    let Some(job) = claim_matching(db, id, turn_id).await? else {
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
        if let Err(error) = deliver(db, &client, Some(*id), None).await {
            tracing::warn!(%error, conversation_id=id, "checkpoint 删除交付失败，任务仍在队列中");
        }
    }
}

pub(crate) async fn dispatch_turn(db: &DatabaseConnection, id: i32, turn_id: &str) {
    if let Err(error) = deliver(db, &client(), Some(id), Some(turn_id)).await {
        tracing::warn!(%error,conversation_id=id,turn_id=turn_id,"turn cleanup remains queued");
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
                match deliver(&db, &client, None, None).await {
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
