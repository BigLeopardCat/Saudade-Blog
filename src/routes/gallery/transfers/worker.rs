use super::{publish, sql, Mode, Spec};
use crate::routes::gallery::storage;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr};
use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
static STOP: LazyLock<CancellationToken> = LazyLock::new(CancellationToken::new);
static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

struct Job {
    id: String,
    lease: String,
    status: String,
    spec: Spec,
    attempts: i32,
}
async fn claim(db: &DatabaseConnection) -> Result<Option<Job>, DbErr> {
    let lease = uuid::Uuid::new_v4().to_string();
    let row=db.query_one(sql("WITH due AS (SELECT id FROM image_transfer WHERE (status IN ('queued','copying','published') OR (status='failed' AND finished_at IS NULL)) AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED) \
        UPDATE image_transfer j SET lease=$1::uuid,attempts=attempts+1,status=CASE WHEN status='queued' THEN 'copying' ELSE status END,next_attempt_at=now()+interval '120 seconds' FROM due WHERE j.id=due.id RETURNING j.id,j.status,j.spec,j.attempts",vec![lease.clone().into()])).await?;
    row.map(|row| {
        Ok(Job {
            id: row.try_get("", "id")?,
            lease,
            status: row.try_get("", "status")?,
            spec: serde_json::from_value(row.try_get("", "spec")?).map_err(|_| storage::error())?,
            attempts: row.try_get("", "attempts")?,
        })
    })
    .transpose()
}
async fn renew(db: &DatabaseConnection, job: &Job) -> Result<(), DbErr> {
    if db.execute(sql("UPDATE image_transfer SET next_attempt_at=now()+interval '120 seconds' WHERE id=$1 AND lease::text=$2 AND status<>'complete' AND finished_at IS NULL",vec![job.id.clone().into(),job.lease.clone().into()])).await?.rows_affected()!=1 {return Err(storage::error());}
    Ok(())
}
async fn work(db: &DatabaseConnection, job: &Job) -> Result<(), DbErr> {
    let spec = &job.spec;
    if job.status == "failed" {
        for loc in &spec.destinations {
            renew(db, job).await?;
            tokio::time::timeout(Duration::from_secs(40), storage::remove(db, loc))
                .await
                .map_err(|_| storage::error())??;
        }
        db.execute(sql("UPDATE image_transfer SET finished_at=now() WHERE id=$1 AND lease::text=$2 AND status='failed'",vec![job.id.clone().into(),job.lease.clone().into()])).await?;
        return Ok(());
    }

    if job.status == "copying" {
        let actor = db
            .query_one(sql(
                "SELECT role,status FROM \"user\" WHERE id=$1",
                vec![spec.owner.into()],
            ))
            .await?
            .ok_or_else(storage::error)?;
        if !crate::authz::can_access_console(&actor.try_get::<String>("", "role")?)
            || actor.try_get::<i16>("", "status")? != crate::authz::STATUS_ACTIVE
        {
            return Err(storage::error());
        }

        let r2_guard = if spec
            .destinations
            .iter()
            .zip(&spec.sources)
            .any(|(dest, source)| dest != source && dest.storage == storage::Kind::R2)
        {
            Some(crate::routes::upload::R2_UPLOAD_LOCK.lock().await)
        } else {
            None
        };
        let quota = if r2_guard.is_some() {
            let config = crate::r2::load_config(db).await?;
            let creds = crate::r2::load_creds().ok_or_else(storage::error)?;
            let used = crate::r2::list_used_bytes(&creds, &config.bucket, &config.prefix)
                .await
                .map_err(|_| storage::error())?;
            Some((used, config.quota_bytes))
        } else {
            None
        };
        let mut incoming = 0u64;
        for (source, dest) in spec.sources.iter().zip(&spec.destinations) {
            if source == dest {
                continue;
            }
            renew(db, job).await?;
            let body = tokio::time::timeout(Duration::from_secs(40), storage::read(db, source))
                .await
                .map_err(|_| storage::error())??;
            if dest.storage == storage::Kind::R2 {
                incoming = incoming
                    .checked_add((body.len() as u64).saturating_sub(storage::size(db, dest).await?))
                    .ok_or_else(storage::error)?;
                if quota
                    .is_some_and(|(used, limit)| crate::r2::quota_exceeded(used, incoming, limit))
                {
                    return Err(storage::error());
                }
            }
            tokio::time::timeout(Duration::from_secs(40), storage::put(db, dest, body))
                .await
                .map_err(|_| storage::error())??;
        }
        renew(db, job).await?;
        publish::publish(db, &job.id, &job.lease, spec).await?;
    }
    // Publication has committed before source cleanup. A crash now resumes cleanup, never copies again.
    if spec.intent.mode == Mode::Move {
        for ((before, source), dest) in spec
            .images
            .iter()
            .zip(&spec.sources)
            .zip(&spec.destinations)
        {
            if source == dest {
                continue;
            }
            renew(db, job).await?;
            let shared=db.query_one(sql("SELECT 1 FROM images i LEFT JOIN image_location l ON l.image_id=i.image_key WHERE NOT EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=i.image_key) AND (l.location=$1 OR (i.image_url=$2 AND i.image_key<>$3)) LIMIT 1",
                vec![serde_json::to_value(source).map_err(|_|storage::error())?.into(),before.image_url.clone().into(),before.image_key.into()])).await?;
            if shared.is_none() {
                tokio::time::timeout(Duration::from_secs(40), storage::remove(db, source))
                    .await
                    .map_err(|_| storage::error())??;
            }
        }
    }
    db.execute(sql("UPDATE image_transfer SET status='complete',finished_at=now(),last_error=NULL WHERE id=$1 AND lease::text=$2 AND status='published'",vec![job.id.clone().into(),job.lease.clone().into()])).await?;
    Ok(())
}
async fn deliver(db: &DatabaseConnection) -> Result<bool, DbErr> {
    let Some(job) = claim(db).await? else {
        return Ok(false);
    };
    if work(db, &job).await.is_err() {
        // Published files stay usable if cleanup fails. Pending transfers retain all source files.
        let current = db
            .query_one(sql(
                "SELECT status FROM image_transfer WHERE id=$1 AND lease::text=$2",
                vec![job.id.clone().into(), job.lease.clone().into()],
            ))
            .await?;
        if let Some(row) = current {
            let status: String = row.try_get("", "status")?;
            let failed = job.attempts >= 5 && status == "copying";
            let message = if failed {
                "本次传输未发布，请核对图库与存储设置后重新准备"
            } else if status == "published" {
                "图库已更新，源文件清理等待后台重试"
            } else if status == "failed" {
                "传输未发布，临时副本清理等待后台重试"
            } else {
                "传输暂未完成，后台将重试"
            };
            db.execute(sql("UPDATE image_transfer SET status=CASE WHEN $3 THEN 'failed' ELSE status END,last_error=$4,next_attempt_at=now()+interval '30 seconds' WHERE id=$1 AND lease::text=$2",
                vec![job.id.clone().into(),job.lease.clone().into(),failed.into(),message.into()])).await?;
            tracing::warn!(event="gallery_transfer_retry",job_id=%job.id,attempt=job.attempts,status,"gallery transfer remains recorded");
        }
    }
    Ok(true)
}
pub fn start(db: DatabaseConnection) {
    let db = Arc::new(db);
    crate::lifecycle::task_tracker().spawn(async move{
        let mut ticks=tokio::time::interval(Duration::from_secs(2));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop{tokio::select!{biased;_=STOP.cancelled()=>break,_=ticks.tick()=>{
            if let Ok(permit)=SLOT.try_acquire(){let db=db.clone();crate::lifecycle::task_tracker().spawn(async move{let _permit=permit;if deliver(&db).await.is_err(){tracing::error!(event="gallery_transfer_failed",reason="database","transfer remains persisted");}});}
        }}}
    });
}
pub fn stop() {
    STOP.cancel();
}

#[cfg(test)]
mod tests;
