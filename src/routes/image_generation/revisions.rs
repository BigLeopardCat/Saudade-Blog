//! Editing an unpaid draft creates a new immutable approval version, never a generation.
use super::{errors::JobError, *};
use sea_orm::TransactionTrait;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub version: String,
    pub conversation_id: i32,
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub quality: String,
}
impl Revision {
    fn validate(&self, settings: &settings::Settings) -> Result<(), DbErr> {
        Draft {
            prompt: self.prompt.clone(),
            model: self.model.clone(),
            size: self.size.clone(),
            quality: self.quality.clone(),
            reference_ids: vec![],
            conversation_reference_ids: vec![],
            conversation_id: Some(self.conversation_id),
        }
        .validate(&settings.models)
    }
}

pub(super) async fn revise(
    state: &AppState,
    uid: i32,
    id: &str,
    input: Revision,
    settings: &settings::Settings,
) -> Result<Job, JobError> {
    input.validate(settings)?;
    let txn = state.db.begin().await?;
    let row = txn
        .query_one(stmt(
            format!(
                "SELECT request,request_hash,{} AS status FROM image_generation \
            WHERE id::text=$1 AND owner_id=$2 AND conversation_id=$3 AND origin='agent' \
            AND EXISTS(SELECT 1 FROM conversation c WHERE c.id=$3 AND c.user_id=$2) FOR UPDATE",
                jobs::STATUS
            ),
            vec![id.into(), uid.into(), input.conversation_id.into()],
        ))
        .await?
        .ok_or(JobError::Missing)?;
    let old_hash: String = row.try_get("", "request_hash")?;
    if old_hash != input.version {
        return Err(JobError::Conflict("确认版本已变化"));
    }
    let mut request: Request = serde_json::from_value(row.try_get("", "request")?)
        .map_err(|_| JobError::Invalid("原请求不可读取"))?;
    if request.provider != settings.base {
        return Err(JobError::Conflict("生图服务配置已变化"));
    }
    request.prompt = input.prompt;
    request.model = input.model;
    request.size = input.size;
    request.quality = input.quality;
    for reference in &mut request.references {
        reference.preview_url.clear();
    }
    let json = serde_json::to_value(&request).map_err(|_| JobError::Invalid("请求无效"))?;
    let hash = digest(&serde_json::to_vec(&request).map_err(|_| JobError::Invalid("请求无效"))?);
    if let Some(revised) = txn.query_one(stmt(
        "SELECT id::text AS id,request_hash FROM image_generation WHERE revised_from::text=$1 AND owner_id=$2",
        vec![id.into(),uid.into()],
    )).await? {
        if revised.try_get::<String>("", "request_hash")? != hash {
            return Err(JobError::Conflict("此卡片已被其他修改替换，请刷新"));
        }
        let id: String = revised.try_get("", "id")?;
        txn.commit().await?;
        return Ok(jobs::read(state,uid,&id).await?);
    }
    if row.try_get::<String>("", "status")? != "pending" {
        return Err(JobError::Conflict("仅等待批准的请求可以修改"));
    }
    let refs = txn.query_all(stmt("SELECT ordinal,bytes FROM image_generation_reference WHERE job_id::text=$1 ORDER BY ordinal", vec![id.into()])).await?;
    if refs.len() != request.references.len() {
        return Err(JobError::Conflict("参考图快照已失效"));
    }
    for (index, row) in refs.iter().enumerate() {
        if row.try_get::<i16>("", "ordinal")? as usize != index
            || digest(&row.try_get::<Vec<u8>>("", "bytes")?) != request.references[index].digest
        {
            return Err(JobError::Conflict("参考图快照校验失败"));
        }
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    txn.execute(stmt("INSERT INTO image_generation(id,owner_id,request,request_hash,origin,conversation_id,revised_from) VALUES($1::uuid,$2,$3,$4,'agent',$5,$6::uuid)",
        vec![new_id.clone().into(),uid.into(),json.into(),hash.into(),input.conversation_id.into(),id.into()])).await?;
    txn.execute(stmt("INSERT INTO image_generation_reference(job_id,ordinal,mime,bytes) SELECT $1::uuid,ordinal,mime,bytes FROM image_generation_reference WHERE job_id::text=$2",
        vec![new_id.clone().into(),id.into()])).await?;
    txn.execute(stmt("UPDATE image_generation SET status='rejected' WHERE id::text=$1 AND owner_id=$2 AND status='pending'",vec![id.into(),uid.into()])).await?;
    txn.commit().await?;
    Ok(jobs::read(state, uid, &new_id).await?)
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Revision>,
) -> Result<Json<ApiResponse<Job>>, JobError> {
    let uid = crate::routes::gallery::actor(&state, &headers)
        .await
        .map_err(|_| JobError::Unauthorized)?;
    let settings = settings::Settings::load().map_err(|_| JobError::Invalid("生图服务未配置"))?;
    Ok(Json(ApiResponse::success(
        revise(&state, uid, &id, input, &settings).await?,
    )))
}
