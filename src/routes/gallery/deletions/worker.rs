use super::target;
use crate::r2;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, FromQueryResult, Statement,
};
use std::{sync::LazyLock, time::Duration};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

static STOP: LazyLock<CancellationToken> = LazyLock::new(CancellationToken::new);
static SLOTS: Semaphore = Semaphore::const_new(2);

#[derive(Debug, FromQueryResult)]
pub(super) struct Job {
    pub(super) image_id: i32,
    pub(super) storage_kind: String,
    pub(super) storage_scope: String,
    pub(super) storage_bucket: Option<String>,
    pub(super) storage_key: String,
    pub(super) attempts: i32,
}

pub(super) async fn claim<C: ConnectionTrait>(db: &C) -> Result<Option<Job>, DbErr> {
    db.query_one(Statement::from_string(DatabaseBackend::Postgres,
        "WITH due AS (SELECT image_id FROM image_deletion WHERE finished_at IS NULL AND next_attempt_at<=CURRENT_TIMESTAMP \
         ORDER BY next_attempt_at,image_id LIMIT 1 FOR UPDATE SKIP LOCKED) \
         UPDATE image_deletion d SET attempts=d.attempts+1,next_attempt_at=CURRENT_TIMESTAMP+interval '90 seconds' FROM due \
         WHERE d.image_id=due.image_id RETURNING d.image_id,d.storage_kind,d.storage_scope,d.storage_bucket,d.storage_key,d.attempts".to_string())).await?
        .map(|row|Job::from_query_result(&row,"")).transpose()
}

pub(super) async fn remove(db: &DatabaseConnection, job: &Job) -> Result<(), &'static str> {
    match job.storage_kind.as_str() {
        "local" => {
            if !target::safe_filename(&job.storage_key) {
                return Err("unsafe_path");
            }
            let root = target::local_root()
                .await
                .map_err(|_| "local_configuration")?;
            if root.to_string_lossy() != job.storage_scope {
                return Err("target_changed");
            }
            let path = root.join(&job.storage_key);
            match tokio::fs::symlink_metadata(&path).await {
                Ok(info) if !info.file_type().is_file() => return Err("unsafe_path"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(_) => return Err("local_metadata"),
                _ => {}
            }
            match tokio::fs::remove_file(path).await {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("local_delete"),
            }
        }
        "r2" => {
            let cfg = r2::load_config(db)
                .await
                .map_err(|_| "configuration_read")?;
            let creds = r2::load_creds().ok_or("storage_credentials")?;
            if !cfg.active()
                || job.storage_bucket.as_deref() != Some(cfg.bucket.as_str())
                || target::endpoint(&creds.endpoint).as_deref() != Some(job.storage_scope.as_str())
            {
                return Err("target_changed");
            }
            r2::delete_object(
                &creds,
                job.storage_bucket
                    .as_deref()
                    .ok_or("storage_configuration")?,
                &job.storage_key,
            )
            .await
            .map_err(|_| "storage_delete")
        }
        _ => Err("storage_kind"),
    }
}

pub(super) async fn finish<C: ConnectionTrait>(
    db: &C,
    job: &Job,
    result: Result<(), &'static str>,
) -> Result<(), DbErr> {
    let (sql,args)=match result {
        Ok(())=>("UPDATE image_deletion SET finished_at=CURRENT_TIMESTAMP,last_error=NULL WHERE image_id=$1 AND attempts=$2 AND finished_at IS NULL",
            vec![job.image_id.into(),job.attempts.into()]),
        Err(reason)=>{
            let delay=(5_i32.saturating_mul(2_i32.pow(job.attempts.clamp(0,6) as u32))).min(300);
            tracing::warn!(event="gallery_cleanup_retry",image_id=job.image_id,attempt=job.attempts,reason,"image cleanup remains queued");
            ("UPDATE image_deletion SET last_error=$3,next_attempt_at=CURRENT_TIMESTAMP+($4*interval '1 second') WHERE image_id=$1 AND attempts=$2 AND finished_at IS NULL",
             vec![job.image_id.into(),job.attempts.into(),reason.into(),delay.into()])
        }
    };
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        args,
    ))
    .await?;
    Ok(())
}

pub(super) async fn deliver(db: &DatabaseConnection) -> Result<bool, DbErr> {
    let Some(job) = claim(db).await? else {
        return Ok(false);
    };
    let result = tokio::time::timeout(Duration::from_secs(20), remove(db, &job))
        .await
        .unwrap_or(Err("storage_timeout"));
    finish(db, &job, result).await?;
    Ok(true)
}

async fn drain(db: &DatabaseConnection) {
    let Ok(_permit) = SLOTS.try_acquire() else {
        return;
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    for _ in 0..20 {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match deliver(db).await {
            Ok(true) => {}
            Ok(false) => break,
            Err(_) => {
                tracing::error!(
                    event = "gallery_cleanup_failed",
                    reason = "database",
                    "image cleanup remains persisted"
                );
                break;
            }
        }
    }
}

pub(crate) fn wake(db: DatabaseConnection) {
    crate::lifecycle::task_tracker().spawn(async move {
        drain(&db).await;
    });
}

pub(crate) fn start(db: DatabaseConnection) {
    crate::lifecycle::task_tracker().spawn(async move {
        let mut ticks = tokio::time::interval(Duration::from_secs(5));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {biased;_ = STOP.cancelled()=>break,_ = ticks.tick()=>wake(db.clone())}
        }
    });
}

pub(crate) fn stop() {
    STOP.cancel();
}
