//! User approval claims a storage job before returning; no network I/O holds a database lock.
use super::{errors::JobError, *};
use sea_orm::TransactionTrait;
use std::{sync::LazyLock, time::Duration};
use tokio::sync::Semaphore;

static SAVING: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

pub(super) async fn accept(
    state: &Arc<AppState>,
    uid: i32,
    id: &str,
    input: Approval,
) -> Result<Job, JobError> {
    let current = jobs::read(state, uid, id).await?;
    if current.output_hash.as_deref() != Some(input.version.as_str()) {
        return Err(JobError::Conflict("生成结果版本已变化，请重新查看并确认"));
    }
    if matches!(current.status.as_str(), "accepted" | "saving") {
        return Ok(current);
    }
    if current.status != "review" {
        return Err(JobError::Conflict("当前没有可保留的生成结果"));
    }
    if STOPPING.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(JobError::Conflict("服务正在更新，请稍后再确认保留"));
    }
    let permit = SAVING
        .clone()
        .try_acquire_owned()
        .map_err(|_| JobError::Conflict("图库保存繁忙，请稍后确认"))?;
    let claimed = state
        .db
        .query_one(stmt(
            "UPDATE image_generation SET status='saving',reviewed_at=now(),error=NULL \
         WHERE id::text=$1 AND owner_id=$2 AND output_hash=$3 AND output IS NOT NULL \
         AND (status='review' OR (status='saving' AND reviewed_at<now()-interval '5 minutes')) \
         RETURNING output,request,origin",
            vec![id.into(), uid.into(), input.version.clone().into()],
        ))
        .await?;
    let Some(row) = claimed else {
        return Ok(jobs::read(state, uid, id).await?);
    };
    let bytes: Vec<u8> = row.try_get("", "output")?;
    let request: Request = serde_json::from_value(row.try_get("", "request")?)
        .map_err(|_| JobError::Invalid("生图请求记录不可读取"))?;
    let origin: String = row.try_get("", "origin")?;
    let worker = state.clone();
    let job_id = id.to_owned();
    crate::lifecycle::task_tracker().spawn(async move {
        let _permit = permit;
        let result = tokio::time::timeout(Duration::from_secs(120),
            complete(&worker, uid, &job_id, &input.version, &request, &origin, &bytes)).await;
        if !matches!(result, Ok(Ok(()))) {
            let failure = match &result {
                Err(_) => "deadline",
                Ok(Err(_)) => "storage_or_database",
                Ok(Ok(())) => unreachable!(),
            };
            tracing::warn!(job_id=%job_id,owner_id=uid,failure,"image gallery save incomplete; original preview retained");
            // A timed-out commit may have succeeded. Never undo an accepted result.
            if let Err(error) = worker.db.execute(stmt(
                "UPDATE image_generation SET status='review',error=$4 \
                 WHERE id::text=$1 AND owner_id=$2 AND output_hash=$3 AND status='saving'",
                vec![job_id.into(),uid.into(),input.version.into(),
                    "保存未完成，图片仍可预览。可再次确认保留，不会重新调用生图 API。".into()],
            )).await {
                tracing::error!(error=%error,"could not record incomplete gallery save");
            }
        }
    });
    Ok(jobs::read(state, uid, id).await?)
}

async fn folder<C: ConnectionTrait>(db: &C, parent: i32, name: &str) -> Result<i32, DbErr> {
    db.query_one(stmt("INSERT INTO image_folder(parent_id,name) VALUES(NULLIF($1,0),$2) \
        ON CONFLICT ((COALESCE(parent_id,0)),(lower(name))) DO UPDATE SET name=EXCLUDED.name RETURNING id",
        vec![parent.into(),name.into()])).await?.ok_or_else(||error("image folder unavailable"))?.try_get("","id")
}

async fn complete(
    state: &Arc<AppState>,
    uid: i32,
    id: &str,
    version: &str,
    request: &Request,
    origin: &str,
    bytes: &[u8],
) -> Result<(), DbErr> {
    if digest(bytes) != version {
        return Err(error("image result hash mismatch"));
    }
    let name = format!("ai-{id}.png");
    let started = std::time::Instant::now();
    let url = crate::routes::upload::persist_generated(state, &name, bytes).await?;
    tracing::info!(
        job_id = id,
        storage_seconds = started.elapsed().as_secs_f64(),
        "generated image storage ready"
    );
    let txn = state.db.begin().await?;
    let image = txn
        .query_one(stmt(
            "SELECT image_key FROM images WHERE image_url=$1",
            vec![url.into()],
        ))
        .await?
        .ok_or_else(|| error("gallery registration missing"))?;
    let image_id: i32 = image.try_get("", "image_key")?;
    let root = folder(&txn, 0, "AI 生图").await?;
    let folder_id = if origin == "agent" {
        folder(&txn, root, "Agent 生成").await?
    } else {
        root
    };
    let description: String = request.prompt.chars().take(2000).collect();
    txn.execute(stmt("INSERT INTO image_metadata(image_id,display_name,description,folder_id) VALUES($1,$2,$3,$4) \
        ON CONFLICT(image_id) DO UPDATE SET folder_id=COALESCE(image_metadata.folder_id,EXCLUDED.folder_id)",
        vec![image_id.into(),name.into(),description.into(),folder_id.into()])).await?;
    let changed = txn
        .execute(stmt(
            "UPDATE image_generation SET status='accepted',image_id=$4,output=NULL,error=NULL \
        WHERE id::text=$1 AND owner_id=$2 AND output_hash=$3 AND status='saving'",
            vec![id.into(), uid.into(), version.into(), image_id.into()],
        ))
        .await?;
    if changed.rows_affected() != 1 {
        return Err(error("image acceptance state changed"));
    }
    txn.commit().await?;
    tracing::info!(
        job_id = id,
        image_id,
        "generated image accepted into gallery"
    );
    Ok(())
}
