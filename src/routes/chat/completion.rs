//! A completion reference identifies existing work; it cannot approve new effects.
use super::{ImageEvent, TaskEvent};
use crate::routes::AppState;
use sea_orm::{ConnectionTrait, DatabaseBackend, DbErr, Statement};

#[derive(Clone)]
pub(super) enum CompletionEvent {
    Image(ImageEvent),
    Task(TaskEvent),
}
impl CompletionEvent {
    pub fn turn_id(&self) -> String {
        match self {
            Self::Image(e) => e.turn_id(),
            Self::Task(e) => e.turn_id(),
        }
    }
    pub async fn verify(&self, state: &AppState, uid: i32, cid: i32) -> Result<bool, DbErr> {
        match self {
            Self::Image(e) => {
                crate::routes::image_generation::chat::verify(state, uid, cid, e).await
            }
            Self::Task(e) => crate::routes::chat_completions::verify(state, uid, cid, e).await,
        }
    }
    pub async fn claim<C: ConnectionTrait>(
        &self,
        db: &C,
        uid: i32,
        cid: i32,
    ) -> Result<bool, DbErr> {
        let (table, column, id, version) = match self {
            Self::Image(e) => ("image_generation", "id::text", &e.job_id, &e.version),
            Self::Task(e) => ("chat_task_result", "run_id", &e.run_id, &e.version),
        };
        // Both SQL identifiers come only from the closed variants above.
        let row = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                format!(
                    "SELECT reported_version FROM {table} WHERE {column}=$1 AND owner_id=$2 \
                     AND conversation_id=$3 FOR UPDATE"
                ),
                [id.clone().into(), uid.into(), cid.into()],
            ))
            .await?
            .ok_or_else(|| DbErr::RecordNotFound("completion missing".into()))?;
        let reported: Option<String> = row.try_get("", "reported_version")?;
        if reported.as_deref() == Some(version) {
            return Ok(false);
        }
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("UPDATE {table} SET reported_version=$2 WHERE {column}=$1 AND owner_id=$3 AND conversation_id=$4"),
            [id.clone().into(), version.clone().into(), uid.into(), cid.into()],
        ))
        .await?;
        Ok(true)
    }
}
