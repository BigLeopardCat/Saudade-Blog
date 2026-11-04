//! Assign an indexed image without rewriting article text or publication state.
use super::*;
use crate::routes::notes::drafts::{document_version, locked_document};
use sea_orm::{DatabaseTransaction, TransactionTrait};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub article_id: i32,
    pub title: String,
    pub cover_url: Option<String>,
    pub fit: Option<String>,
    pub version: String,
}

pub(super) async fn read_target(db: &DatabaseTransaction, id: i32) -> Result<Target, DbErr> {
    let (root, draft) = locked_document(db, id).await?;
    let version = document_version(db, &root, draft.as_ref()).await?;
    Ok(Target {
        article_id: root.id,
        title: root.title,
        cover_url: root.cover,
        fit: root.cover_fit,
        version,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub image_id: i32,
    pub image_version: String,
    pub fit: crate::routes::notes::CoverFit,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub before_version: String,
    pub image_id: i32,
    pub state: Target,
}

pub(super) async fn apply(
    db: &DatabaseTransaction,
    uid: i32,
    id: i32,
    input: Change,
) -> Result<Outcome, DbErr> {
    if id <= 0
        || input.image_id <= 0
        || !valid_version(&input.version)
        || !valid_version(&input.image_version)
    {
        return Err(DbErr::Custom("invalid cover selection".into()));
    }
    let before = read_target(db, id).await?;
    if before.article_id != id || before.version != input.version {
        return Err(DbErr::Custom("article changed".into()));
    }
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT image_key FROM images WHERE image_key=$1 FOR UPDATE",
        vec![input.image_id.into()],
    ))
    .await?
    .ok_or_else(|| DbErr::RecordNotFound("image missing".into()))?;
    let image = read(db, uid, input.image_id).await?;
    if image.version != input.image_version {
        return Err(DbErr::Custom("image changed".into()));
    }
    let fit = input.fit.as_str();
    let result = db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "UPDATE note SET cover=$1,cover_fit=$2,cover_focus_x=0.5,cover_focus_y=0.5,cover_zoom=1, \
         carousel_fit=$2,carousel_focus_x=0.5,carousel_focus_y=0.5,carousel_zoom=1,updated_at=localtimestamp \
         WHERE (id=$3 OR draft_of=$3) AND (cover IS DISTINCT FROM $1 OR cover_fit IS DISTINCT FROM $2)",
        vec![image.image_url.into(),fit.into(),id.into()])).await?;
    let state = read_target(db, id).await?;
    Ok(Outcome {
        changed: result.rows_affected() > 0,
        before_version: input.version,
        image_id: input.image_id,
        state,
    })
}

pub async fn target(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Json<ApiResponse<Target>> {
    let result = async {
        let txn = state.db.begin().await?;
        let value = read_target(&txn, id).await?;
        txn.commit().await?;
        Ok(value)
    }
    .await;
    response(result)
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(input): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    let result = async {
        let uid = actor(&state, &headers).await?;
        let txn = state.db.begin().await?;
        let outcome = apply(&txn, uid, id, input).await?;
        txn.commit().await?;
        Ok(outcome)
    }
    .await;
    response(result)
}
