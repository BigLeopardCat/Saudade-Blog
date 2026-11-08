//! Approval-bound catalogue transfers. Durable work is performed outside database transactions.
pub(crate) mod publish;
mod worker;
use super::{
    actor,
    storage::{self, Kind, Location},
    Image,
};
use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
pub use worker::{start, stop};
pub(crate) fn sql(query: &str, args: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, query, args)
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Move,
    Copy,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub mode: Mode,
    pub image_ids: Vec<i32>,
    pub storage: Option<Kind>,
    pub folder_id: i32,
}
impl Intent {
    fn normalize(mut self) -> Result<Self, DbErr> {
        self.image_ids.sort_unstable();
        if self.image_ids.is_empty()
            || self.image_ids.len() > 100
            || self.image_ids.iter().any(|id| *id <= 0)
            || self.image_ids.windows(2).any(|w| w[0] == w[1])
            || self.folder_id < 0
        {
            return Err(storage::error());
        }
        Ok(self)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub version: String,
    pub expires_at: i64,
    pub intent: Intent,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Spec {
    pub owner: i32,
    pub intent: Intent,
    pub images: Vec<Image>,
    pub sources: Vec<Location>,
    pub destinations: Vec<Location>,
    pub folder_name: String,
}
impl Spec {
    pub(super) fn file_transfers(&self) -> impl Iterator<Item = (&Image, &Location, &Location)> {
        self.images
            .iter()
            .zip(self.sources.iter().zip(&self.destinations))
            .filter_map(|(image, (source, destination))| {
                (source != destination).then_some((image, source, destination))
            })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    #[serde(flatten)]
    pub approval: Approval,
    pub destination_name: String,
    pub images: Vec<Image>,
}
async fn plan<C: ConnectionTrait>(db: &C, uid: i32, intent: Intent) -> Result<Spec, DbErr> {
    let folder_name = if intent.folder_id == 0 {
        "未分类".into()
    } else {
        db.query_one(sql(
            "SELECT name FROM image_folder WHERE id=$1",
            vec![intent.folder_id.into()],
        ))
        .await?
        .ok_or_else(storage::error)?
        .try_get("", "name")?
    };
    let mut images = Vec::new();
    let mut sources = Vec::new();
    let mut destinations = Vec::new();
    for id in &intent.image_ids {
        let image = super::read(db, uid, *id).await?;
        let source = storage::resolve(db, &image).await?;
        // Only generated immutable names enter a destination; neither a browser nor a model supplies filesystem paths.
        let ext = source
            .key
            .rsplit('.')
            .next()
            .filter(|v| crate::utils::image_ext_allowed(v))
            .ok_or_else(storage::error)?;
        let name = format!("transfer-{}-{}.{}", uuid::Uuid::new_v4().simple(), id, ext);
        let mut destination =
            storage::destination(db, intent.storage.unwrap_or(source.storage), &name).await?;
        if intent.mode == Mode::Move
            && source.storage == destination.storage
            && source.scope == destination.scope
            && source.bucket == destination.bucket
        {
            destination = source.clone();
        }
        images.push(image);
        sources.push(source);
        destinations.push(destination);
    }
    Ok(Spec {
        owner: uid,
        intent,
        images,
        sources,
        destinations,
        folder_name,
    })
}
fn digest(spec: &Spec, expires: i64) -> Result<String, DbErr> {
    // Destination keys are derived from the approval identity, not random values regenerated at execution.
    let config: Vec<_> = spec
        .destinations
        .iter()
        .map(|l| (l.storage, &l.scope, &l.bucket))
        .collect();
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            spec.owner,
            &spec.intent,
            &spec.images,
            &spec.sources,
            config,
            &spec.folder_name,
            expires,
        ))
        .map_err(|_| storage::error())?,
    )))
}
async fn prepare_in(db: &DatabaseConnection, uid: i32, intent: Intent) -> Result<Preview, DbErr> {
    let intent = intent.normalize()?;
    let spec = plan(db, uid, intent.clone()).await?;
    let expires_at = chrono::Utc::now().timestamp() + 900;
    let version = digest(&spec, expires_at)?;
    Ok(Preview {
        approval: Approval {
            version,
            expires_at,
            intent,
        },
        destination_name: spec.folder_name,
        images: spec.images,
    })
}
async fn enqueue(
    db: &DatabaseConnection,
    uid: i32,
    input: Approval,
) -> Result<serde_json::Value, DbErr> {
    let now = chrono::Utc::now().timestamp();
    if !super::valid_version(&input.version)
        || input.expires_at <= now
        || input.expires_at > now + 900
    {
        return Err(storage::error());
    }
    // A repeated accepted approval returns its existing job, even after source versions have changed.
    if let Some(row)=db.query_one(sql("SELECT id,status,result,last_error FROM image_transfer WHERE id=$1 AND requested_by=$2",vec![input.version.clone().into(),uid.into()])).await? {return job_value(row);}
    let mut spec = plan(db, uid, input.intent.normalize()?).await?;
    if digest(&spec, input.expires_at)? != input.version {
        return Err(storage::error());
    }
    for (i, loc) in spec.destinations.iter_mut().enumerate() {
        if *loc == spec.sources[i] {
            continue;
        }
        let ext = loc.key.rsplit('.').next().ok_or_else(storage::error)?;
        let name = format!("transfer-{}-{i}.{ext}", input.version);
        loc.key = match loc.storage {
            Kind::Local => name,
            Kind::R2 => format!("{}/{name}", r2_prefix(&loc.key)?),
        };
    }
    let tx = db.begin().await?;
    // A unique approval key provides idempotence; no I/O is performed while holding a database transaction.
    tx.execute(sql("INSERT INTO image_transfer(id,requested_by,spec) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",vec![input.version.clone().into(),uid.into(),serde_json::to_value(spec).map_err(|_|storage::error())?.into()])).await?;
    tx.commit().await?;
    status_in(db, uid, &input.version).await
}
fn r2_prefix(key: &str) -> Result<&str, DbErr> {
    key.rsplit_once('/').map(|v| v.0).ok_or_else(storage::error)
}
fn job_value(row: sea_orm::QueryResult) -> Result<serde_json::Value, DbErr> {
    Ok(
        serde_json::json!({"id":row.try_get::<String>("","id")?,"status":row.try_get::<String>("","status")?,"result":row.try_get::<Option<serde_json::Value>>("","result")?,"error":row.try_get::<Option<String>>("","last_error")?}),
    )
}
async fn status_in(
    db: &DatabaseConnection,
    uid: i32,
    id: &str,
) -> Result<serde_json::Value, DbErr> {
    job_value(db.query_one(sql("SELECT id,status,result,last_error FROM image_transfer WHERE id=$1 AND requested_by=$2",vec![id.into(),uid.into()])).await?.ok_or_else(storage::error)?)
}
fn respond<T: Serialize>(result: Result<T, DbErr>) -> Response {
    match result {
        Ok(value) => Json(ApiResponse::success(value)).into_response(),
        Err(_) => (
            StatusCode::CONFLICT,
            Json(ApiResponse::<serde_json::Value>::error(
                "图片或存储目标暂不可确认，请刷新后重试",
            )),
        )
            .into_response(),
    }
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(intent): Json<Intent>,
) -> Response {
    respond(async { prepare_in(&state.db, actor(&state, &headers).await?, intent).await }.await)
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Approval>,
) -> Response {
    respond(async { enqueue(&state.db, actor(&state, &headers).await?, input).await }.await)
}
pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    respond(async { status_in(&state.db, actor(&state, &headers).await?, &id).await }.await)
}
#[cfg(test)]
mod tests;

pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    respond(async {
        let uid=actor(&state,&headers).await?;
        let rows=state.db.query_all(sql("SELECT id,status,result,last_error FROM image_transfer WHERE requested_by=$1 ORDER BY created_at DESC LIMIT 20",vec![uid.into()])).await?;
        rows.into_iter().map(job_value).collect::<Result<Vec<_>,DbErr>>()
    }.await)
}
