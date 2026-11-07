//! Bounded, idempotent persistence of an already generated image; never retries generation.

use super::{digest, error, stmt, JsonValue};
use sea_orm::{ConnectionTrait, DbErr};
use std::time::Duration;
use tokio::time::{sleep, timeout};

const SAVE_TIMEOUT: Duration = Duration::from_secs(2);
const SAVE_ATTEMPTS: usize = 3;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Saved {
    Review,
    AlreadyStored,
    Superseded,
}

async fn save_once<C: ConnectionTrait>(
    db: &C,
    id: &str,
    owner: i32,
    request_hash: &str,
    bytes: &[u8],
    output_hash: &str,
    usage: &JsonValue,
) -> Result<Saved, DbErr> {
    let changed = db.execute(stmt(
        "UPDATE image_generation SET status='review',output=$4,output_hash=$5,usage=$6,finished_at=now() \
         WHERE id::text=$1 AND owner_id=$2 AND request_hash=$3 AND status='generating' AND output IS NULL",
        vec![id.into(), owner.into(), request_hash.into(), bytes.to_vec().into(),
             output_hash.into(), usage.clone().into()],
    )).await?;
    if changed.rows_affected() == 1 {
        return Ok(Saved::Review);
    }
    // An earlier timed-out SQL statement may have committed; acceptance must not be undone.
    let current = db.query_one(stmt(
        "SELECT status,output_hash FROM image_generation WHERE id::text=$1 AND owner_id=$2 AND request_hash=$3",
        vec![id.into(), owner.into(), request_hash.into()],
    )).await?;
    if let Some(row) = current {
        let status: String = row.try_get("", "status")?;
        let stored: Option<String> = row.try_get("", "output_hash")?;
        if matches!(status.as_str(), "review" | "accepted")
            && stored.as_deref() == Some(output_hash)
        {
            return Ok(Saved::AlreadyStored);
        }
    }
    Ok(Saved::Superseded)
}

pub(super) async fn save<C: ConnectionTrait>(
    db: &C,
    id: &str,
    owner: i32,
    request_hash: &str,
    bytes: &[u8],
    usage: &JsonValue,
) -> Result<Saved, DbErr> {
    let output_hash = digest(bytes);
    for attempt in 0..SAVE_ATTEMPTS {
        let result = timeout(
            SAVE_TIMEOUT,
            save_once(db, id, owner, request_hash, bytes, &output_hash, usage),
        )
        .await
        .unwrap_or_else(|_| Err(error("image result storage timed out")));
        match result {
            Ok(saved) => return Ok(saved),
            Err(failure) if attempt + 1 == SAVE_ATTEMPTS => return Err(failure),
            Err(_) => {
                tracing::warn!(
                    job_id = id,
                    owner_id = owner,
                    attempt = attempt + 1,
                    "image result storage failed; retrying persistence only"
                );
                sleep(Duration::from_millis(if attempt == 0 { 100 } else { 300 })).await;
            }
        }
    }
    unreachable!("persistence attempts are nonzero")
}

pub(super) async fn unknown<C: ConnectionTrait>(
    db: &C,
    id: &str,
    owner: i32,
    request_hash: &str,
    message: &str,
) -> Result<(), DbErr> {
    timeout(
        SAVE_TIMEOUT,
        db.execute(stmt(
            "UPDATE image_generation SET status='unknown',error=$4,finished_at=now() \
         WHERE id::text=$1 AND owner_id=$2 AND request_hash=$3 AND status='generating'",
            vec![id.into(), owner.into(), request_hash.into(), message.into()],
        )),
    )
    .await
    .map_err(|_| error("image unknown-state storage timed out"))??;
    Ok(())
}

#[cfg(test)]
mod tests;
