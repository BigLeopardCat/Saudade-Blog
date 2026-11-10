use super::*;
use sea_orm::TransactionTrait;
use std::sync::LazyLock;
use tokio::sync::Semaphore;
static RUNNING: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

#[derive(FromQueryResult)]
struct Row {
    id: String,
    request: JsonValue,
    request_hash: String,
    status: String,
    output_hash: Option<String>,
    image_id: Option<i32>,
    image_removed: bool,
    gallery_url: Option<String>,
    error: Option<String>,
    usage: Option<JsonValue>,
    created_at: String,
    retry_of: Option<String>,
    retry_source_status: Option<String>,
    conversation_id: Option<i32>,
    event_version: String,
    save_storage: String,
}
pub(super) const STATUS: &str = "CASE WHEN status='generating' AND approved_at<now()-interval '5 minutes' THEN 'unknown' WHEN status='saving' AND reviewed_at<now()-interval '5 minutes' THEN 'review' WHEN status='pending' AND created_at<now()-interval '1 hour' THEN 'expired' ELSE status END";

pub async fn read(state: &AppState, uid: i32, id: &str) -> Result<Job, DbErr> {
    let row = Row::find_by_statement(stmt(format!("SELECT id::text AS id,request,request_hash,{STATUS} AS status,output_hash,image_id,CASE WHEN status='saving' AND reviewed_at<now()-interval '5 minutes' THEN '上次保存已中断，图片仍可预览，可重新确认保留。' ELSE error END AS error,usage,created_at::text AS created_at,retry_of::text AS retry_of,retry_source_status,conversation_id,save_storage,{} AS event_version, \
        (status='accepted' AND (image_id IS NULL OR EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=image_generation.image_id))) AS image_removed, \
        (SELECT i.image_url FROM images i WHERE i.image_key=image_generation.image_id \
         AND NOT EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=i.image_key)) AS gallery_url \
        FROM image_generation WHERE id::text=$1 AND owner_id=$2", chat::VERSION), vec![id.into(), uid.into()]))
        .one(&state.db)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("image job missing".into()))?;
    let mut request: Request =
        serde_json::from_value(row.request).map_err(|_| error("invalid job request"))?;
    for (slot, reference) in request.references.iter_mut().enumerate() {
        if ["pending", "generating", "review", "saving"].contains(&row.status.as_str()) {
            reference.preview_url = preview_url(uid, id, slot as i16, &reference.digest)?;
        }
    }
    let preview = if matches!(row.status.as_str(), "review" | "saving") {
        row.output_hash
            .as_ref()
            .map(|hash| preview_url(uid, id, -1, hash))
            .transpose()?
    } else if row.status == "accepted" && !row.image_removed {
        row.gallery_url
    } else {
        None
    };
    let job = Job {
        id: row.id,
        request: Some(request),
        request_hash: row.request_hash,
        status: row.status,
        output_hash: row.output_hash,
        image_id: row.image_id,
        image_removed: row.image_removed,
        error: row.error,
        usage: row.usage,
        preview_url: preview,
        created_at: row.created_at,
        retry_of: row.retry_of,
        retry_source_status: row.retry_source_status,
        conversation_id: row.conversation_id,
        event_version: row.event_version,
        save_storage: row.save_storage,
    };
    Ok(job)
}

pub async fn create(state: &AppState, uid: i32, input: Draft, origin: &str) -> Result<Job, DbErr> {
    let settings = settings::Settings::load().map_err(error)?;
    input.validate(&settings.models)?;
    if let Some(cid) = input.conversation_id {
        let owner = state
            .db
            .query_one(stmt(
                "SELECT id FROM conversation WHERE id=$1 AND user_id=$2",
                vec![cid.into(), uid.into()],
            ))
            .await?;
        if origin != "agent" || owner.is_none() {
            return Err(error("image conversation not owned"));
        }
    }
    // Retain pending previews for seven days; approval facts and hashes remain durable.
    state.db.execute(stmt("DELETE FROM image_generation_reference WHERE job_id IN (SELECT id FROM image_generation WHERE owner_id=$1 AND created_at<now()-interval '7 days' AND status NOT IN ('generating','saving'))",vec![uid.into()])).await?;
    state.db.execute(stmt("UPDATE image_generation SET output=NULL,status=CASE WHEN status='review' THEN 'rejected' ELSE status END WHERE owner_id=$1 AND created_at<now()-interval '7 days' AND output IS NOT NULL AND status NOT IN ('generating','saving')",vec![uid.into()])).await?;
    let mut references = Vec::new();
    let mut snapshots = Vec::new();
    for id in input.reference_ids {
        let (reference, mime, bytes) = references::snapshot(state, uid, id).await?;
        references.push(reference);
        snapshots.push((mime, bytes));
    }
    let request = Request {
        provider: settings.base.clone(),
        prompt: input.prompt,
        model: input.model,
        size: input.size,
        quality: input.quality,
        references,
    };
    let json = serde_json::to_value(&request).map_err(|_| error("invalid image request"))?;
    let hash = digest(&serde_json::to_vec(&request).map_err(|_| error("invalid image request"))?);
    let id = uuid::Uuid::new_v4().to_string();
    let txn = state.db.begin().await?;
    txn.execute(stmt(
        "INSERT INTO image_generation(id,owner_id,request,request_hash,origin,conversation_id) VALUES($1::uuid,$2,$3,$4,$5,$6)",
        vec![id.clone().into(), uid.into(), json.into(), hash.into(), origin.into(), input.conversation_id.into()],
    ))
    .await?;
    for (ordinal, (mime, bytes)) in snapshots.into_iter().enumerate() {
        txn.execute(stmt("INSERT INTO image_generation_reference(job_id,ordinal,mime,bytes) VALUES($1::uuid,$2,$3,$4)",vec![id.clone().into(),(ordinal as i16).into(),mime.into(),bytes.into()])).await?;
    }
    txn.commit().await?;
    read(state, uid, &id).await
}

pub async fn approve(
    state: Arc<AppState>,
    uid: i32,
    id: &str,
    input: Approval,
) -> Result<Job, DbErr> {
    if STOPPING.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(error("service is draining"));
    }
    let settings = settings::Settings::load().map_err(error)?;
    let current = read(&state, uid, id).await?;
    if current.request_hash != input.version {
        return Err(error("approval version mismatch"));
    }
    if current.status != "pending" {
        return Ok(current);
    }
    let permit = RUNNING
        .clone()
        .try_acquire_owned()
        .map_err(|_| error("生图任务繁忙，请稍后批准"))?;
    let txn = state.db.begin().await?;
    txn.execute(stmt("SELECT pg_advisory_xact_lock(54239186)", vec![]))
        .await?;
    let active=txn.query_one(stmt("SELECT count(*)::bigint AS n FROM image_generation WHERE status='generating' AND approved_at>now()-interval '5 minutes'",vec![])).await?.ok_or_else(||error("admission unavailable"))?;
    if active.try_get::<i64>("", "n")? >= 2 {
        return Err(error("生图任务繁忙，请稍后批准"));
    }
    let claimed=txn.execute(stmt("UPDATE image_generation SET status='generating',approved_at=now() WHERE id::text=$1 AND owner_id=$2 AND request_hash=$3 AND status='pending' AND created_at>now()-interval '1 hour'",vec![id.into(),uid.into(),input.version.into()])).await?;
    if claimed.rows_affected() == 0 {
        txn.rollback().await?;
        return read(&state, uid, id).await;
    }
    let request = current
        .request
        .ok_or_else(|| error("request unavailable"))?;
    if request.provider != settings.base || !settings.models.contains(&request.model) {
        return Err(error("approved model is no longer configured"));
    }
    let rows=txn.query_all(stmt("SELECT mime,bytes FROM image_generation_reference WHERE job_id::text=$1 ORDER BY ordinal",vec![id.into()])).await?;
    let refs = rows
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get::<String>("", "mime")?,
                row.try_get::<Vec<u8>>("", "bytes")?,
            ))
        })
        .collect::<Result<Vec<_>, DbErr>>()?;
    if refs.len() != request.references.len() {
        return Err(error("reference snapshot missing"));
    }
    txn.commit().await?;
    let job_id = id.to_owned();
    let worker = state.clone();
    crate::lifecycle::task_tracker().spawn(async move {
        let _permit = permit;
        tracing::info!(job_id=%job_id,owner_id=uid,model=%request.model,"approved image generation started");
        let result = provider::generate(settings, &request, &refs).await;
        match result {
            Ok((bytes, usage)) => {
                match result_storage::save(&worker.db, &job_id, uid, &current.request_hash, &bytes, &usage).await {
                    Ok(result_storage::Saved::Review) => {
                        tracing::info!(job_id=%job_id,"image result saved; awaiting user review");
                    }
                    Ok(result_storage::Saved::AlreadyStored) => {
                        tracing::info!(job_id=%job_id,"image result was already stored; existing job state preserved");
                    }
                    Ok(result_storage::Saved::Superseded) => {
                        tracing::warn!(job_id=%job_id,"image result not saved because the job state changed");
                    }
                    Err(failure) => {
                        tracing::error!(job_id=%job_id,error=%failure,"generated image persistence exhausted; outcome unknown; generation will not be repeated");
                        if let Err(failure) = result_storage::unknown(&worker.db, &job_id, uid, &current.request_hash,
                            "生图结果保存失败，结果未知。请按任务编号核对服务商记录后再创建付费任务。").await {
                            tracing::error!(job_id=%job_id,error=%failure,"image unknown-state persistence failed");
                        }
                    }
                }
            }
            Err(message) => {
                if let Err(failure) = result_storage::unknown(&worker.db, &job_id, uid, &current.request_hash, &message).await {
                    tracing::error!(job_id=%job_id,error=%failure,"image provider failure could not be persisted; outcome unknown");
                }
            }
        }
    });
    read(&state, uid, id).await
}

pub(super) use super::acceptance::accept;

pub async fn reject(state: &AppState, uid: i32, id: &str) -> Result<Job, DbErr> {
    let txn = state.db.begin().await?;
    txn.execute(stmt("UPDATE image_generation SET status='rejected',output=NULL,reviewed_at=now() WHERE id::text=$1 AND owner_id=$2 AND status IN ('pending','review')",vec![id.into(),uid.into()])).await?;
    txn.commit().await?;
    read(state, uid, id).await
}
