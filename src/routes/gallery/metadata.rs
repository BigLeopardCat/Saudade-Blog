use super::*;
use sea_orm::TransactionTrait;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub folder_id: Option<i32>,
    pub is_favorite: Option<bool>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub before_version: String,
    pub state: Image,
}

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    id: i32,
    input: Change,
) -> Result<Outcome, DbErr> {
    if !valid_version(&input.version)
        || input.folder_id.is_some_and(|v| v < 0)
        || input
            .display_name
            .as_ref()
            .is_some_and(|v| v.trim().is_empty() || v.chars().count() > 255)
        || input
            .description
            .as_ref()
            .is_some_and(|v| v.chars().count() > 2000)
        || (input.display_name.is_none()
            && input.description.is_none()
            && input.folder_id.is_none()
            && input.is_favorite.is_none())
    {
        return Err(DbErr::Custom("invalid image metadata".into()));
    }
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT image_key FROM images WHERE image_key=$1 FOR UPDATE",
        vec![id.into()],
    ))
    .await?
    .ok_or_else(|| DbErr::RecordNotFound("image missing".into()))?;
    let before = read(db, uid, id).await?;
    if before.version != input.version {
        return Err(DbErr::Custom("image changed".into()));
    }
    let name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .map(str::to_owned)
        .or(before.display_name);
    let description = input.description.unwrap_or(before.description);
    let folder = input.folder_id.unwrap_or(before.folder_id);
    db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO image_metadata(image_id,display_name,description,folder_id) VALUES($1,$2,$3,NULLIF($4,0)) \
         ON CONFLICT(image_id) DO UPDATE SET display_name=EXCLUDED.display_name,description=EXCLUDED.description,folder_id=EXCLUDED.folder_id",
        vec![id.into(),name.into(),description.into(),folder.into()])).await?;
    if let Some(favorite) = input.is_favorite {
        let sql = if favorite {
            "INSERT INTO image_favorite(image_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING"
        } else {
            "DELETE FROM image_favorite WHERE image_id=$1 AND user_id=$2"
        };
        db.execute(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![id.into(), uid.into()],
        ))
        .await?;
    }
    let state = read(db, uid, id).await?;
    Ok(Outcome {
        changed: state.version != input.version,
        before_version: input.version,
        state,
    })
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(input): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    let result = async {
        let uid = actor(&state, &headers).await?;
        let txn = state
            .db
            .begin_with_config(Some(sea_orm::IsolationLevel::ReadCommitted), None)
            .await?;
        let outcome = apply(&txn, uid, id, input).await?;
        txn.commit().await?;
        Ok(outcome)
    }
    .await;
    response(result)
}
