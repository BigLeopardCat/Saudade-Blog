//! Owned background work projected from the same job state used by generation and saving.
use super::*;

#[derive(Serialize, FromQueryResult)]
#[serde(rename_all = "camelCase")]
pub struct ImageTask {
    pub id: String,
    pub conversation_id: Option<i32>,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub event_version: String,
    pub report_pending: bool,
    pub error: Option<String>,
    pub image_removed: bool,
}

pub async fn list(state: &AppState, uid: i32) -> Result<Vec<ImageTask>, DbErr> {
    ImageTask::find_by_statement(stmt(
        format!("SELECT id::text AS id,conversation_id, \
            left(request->>'prompt',80) AS title,{} AS status,created_at::text AS created_at, \
            {} AS event_version,(conversation_id IS NOT NULL AND reported_version \
                IS DISTINCT FROM {}) AS report_pending,error, \
            (status='accepted' AND (image_id IS NULL OR EXISTS(SELECT 1 FROM image_deletion d \
                WHERE d.image_id=image_generation.image_id))) AS image_removed \
            FROM image_generation WHERE owner_id=$1 \
            AND (status IN ('generating','saving','review','unknown') \
                 OR status IN ('accepted','failed','rejected') AND created_at>now()-interval '1 day') \
            ORDER BY CASE WHEN status IN ('generating','saving','review','unknown') \
                THEN 0 ELSE 1 END,created_at DESC LIMIT 21", jobs::STATUS, chat::VERSION, chat::VERSION),
        vec![uid.into()],
    )).all(&state.db).await
}
