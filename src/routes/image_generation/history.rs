use super::{errors::JobError, *};
use sea_orm::TransactionTrait;

pub(super) async fn remove(state: &AppState, uid: i32, id: &str) -> Result<(), JobError> {
    let txn = state.db.begin().await?;
    let row = txn.query_one(stmt(
        format!("SELECT {} AS status FROM image_generation WHERE id::text=$1 AND owner_id=$2 FOR UPDATE",jobs::STATUS),
        vec![id.into(), uid.into()],
    )).await?.ok_or(JobError::Missing)?;
    let status: String = row.try_get("", "status")?;
    if matches!(status.as_str(), "generating" | "saving") {
        return Err(JobError::Conflict("执行中的生图任务不能删除"));
    }
    // Gallery assets have their own lifecycle; deleting history only removes this job.
    txn.execute(stmt(
        "DELETE FROM image_generation WHERE id::text=$1 AND owner_id=$2",
        vec![id.into(), uid.into()],
    ))
    .await?;
    txn.commit().await?;
    Ok(())
}

pub(super) async fn retry(
    state: &AppState,
    uid: i32,
    id: &str,
    settings: &settings::Settings,
) -> Result<Job, JobError> {
    let txn = state.db.begin().await?;
    let row = txn.query_one(stmt(
        format!("SELECT request,request_hash,{} AS status,origin FROM image_generation WHERE id::text=$1 AND owner_id=$2 FOR UPDATE",jobs::STATUS),
        vec![id.into(), uid.into()],
    )).await?.ok_or(JobError::Missing)?;
    let status: String = row.try_get("", "status")?;
    if matches!(status.as_str(), "generating" | "saving") {
        return Err(JobError::Conflict("任务正在执行，请先等待实际结果"));
    }
    let original: JsonValue = row.try_get("", "request")?;
    let request: Request = serde_json::from_value(original.clone())
        .map_err(|_| JobError::Invalid("原生图请求不可读取"))?;
    if request.provider != settings.base || !settings.models.contains(&request.model) {
        return Err(JobError::Conflict(
            "原服务地址或模型已不可用，请新建请求并重新选择",
        ));
    }
    let refs = txn.query_all(stmt(
        "SELECT ordinal,mime,bytes FROM image_generation_reference WHERE job_id::text=$1 ORDER BY ordinal",
        vec![id.into()],
    )).await?;
    if refs.len() != request.references.len() {
        return Err(JobError::Conflict(
            "原参考图快照已清理，请新建请求并重新选择参考图",
        ));
    }
    for (index, row) in refs.iter().enumerate() {
        let ordinal: i16 = row.try_get("", "ordinal")?;
        let bytes: Vec<u8> = row.try_get("", "bytes")?;
        if ordinal as usize != index || digest(&bytes) != request.references[index].digest {
            return Err(JobError::Conflict("原参考图快照校验失败，请新建请求"));
        }
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    let hash: String = row.try_get("", "request_hash")?;
    let origin: String = row.try_get("", "origin")?;
    txn.execute(stmt("INSERT INTO image_generation(id,owner_id,request,request_hash,origin,retry_of,retry_source_status) \
        VALUES($1::uuid,$2,$3,$4,$5,$6::uuid,$7)", vec![new_id.clone().into(),uid.into(),original.into(),
            hash.into(),origin.into(),id.into(),status.into()])).await?;
    txn.execute(stmt(
        "INSERT INTO image_generation_reference(job_id,ordinal,mime,bytes) \
        SELECT $1::uuid,ordinal,mime,bytes FROM image_generation_reference WHERE job_id::text=$2",
        vec![new_id.clone().into(), id.into()],
    ))
    .await?;
    txn.commit().await?;
    // Creating a retry never approves it and never contacts the paid provider.
    Ok(jobs::read(state, uid, &new_id).await?)
}
