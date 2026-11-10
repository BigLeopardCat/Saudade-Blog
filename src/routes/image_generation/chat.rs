//! Durable image completions are relayed by the open chat, never inferred from client text.
use super::*;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageEvent {
    pub job_id: String,
    pub version: String,
}

impl ImageEvent {
    pub fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.job_id).is_ok()
            && self.version.len() == 64
            && self.version.bytes().all(|b| b.is_ascii_hexdigit())
    }
    pub fn turn_id(&self) -> String {
        format!(
            "image_{}",
            digest(format!("{}:{}", self.job_id, self.version).as_bytes())
        )
    }
}

pub(super) const VERSION: &str = "encode(sha256(convert_to(\
    jsonb_build_array(status,output_hash,image_id,error)::text,'UTF8')),'hex')";

pub(super) fn reportable(job: &Job) -> bool {
    matches!(
        job.status.as_str(),
        "review" | "accepted" | "failed" | "unknown"
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationQuery {
    pub conversation_id: i32,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchItem {
    pub id: String,
    pub status: String,
    pub event_version: String,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ConversationQuery>,
) -> Json<ApiResponse<Vec<WatchItem>>> {
    response(
        async {
            let uid = crate::routes::gallery::actor(&state, &headers).await?;
            let rows = state
                .db
                .query_all(stmt(
                    format!(
                        "SELECT id::text AS id,{} AS status,{VERSION} AS event_version \
             FROM image_generation WHERE owner_id=$1 AND conversation_id=$2 \
             AND EXISTS(SELECT 1 FROM conversation c WHERE c.id=$2 AND c.user_id=$1) \
             AND status IN ('generating','saving','review','accepted','unknown','failed') \
             AND reported_version IS DISTINCT FROM {VERSION} \
             ORDER BY created_at LIMIT 20",
                        jobs::STATUS
                    ),
                    vec![uid.into(), query.conversation_id.into()],
                ))
                .await?;
            let mut result = Vec::new();
            for row in rows {
                result.push(WatchItem {
                    id: row.try_get("", "id")?,
                    status: row.try_get("", "status")?,
                    event_version: row.try_get("", "event_version")?,
                });
            }
            Ok(result)
        }
        .await,
    )
}

pub async fn verify(
    state: &AppState,
    uid: i32,
    cid: i32,
    event: &ImageEvent,
) -> Result<bool, DbErr> {
    if !event.valid() {
        return Err(error("invalid image event"));
    }
    let job = jobs::read(state, uid, &event.job_id).await?;
    if job.conversation_id != Some(cid) || job.event_version != event.version || !reportable(&job) {
        return Err(error("image event changed"));
    }
    let row = state.db.query_one(stmt(
        "SELECT reported_version FROM image_generation WHERE id::text=$1 AND owner_id=$2 AND conversation_id=$3",
        vec![event.job_id.clone().into(), uid.into(), cid.into()])).await?
        .ok_or_else(||error("image event missing"))?;
    let reported: Option<String> = row.try_get("", "reported_version")?;
    Ok(reported.as_deref() != Some(&event.version))
}
