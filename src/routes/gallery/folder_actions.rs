//! Folder approvals use the existing hierarchy service; deletion is restricted to empty folders.
use super::*;
use sea_orm::{DatabaseTransaction, IsolationLevel, TransactionTrait};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Delete,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub action: Action,
    pub id: Option<i32>,
    pub name: Option<String>,
    #[serde(default)]
    pub parent_id: i32,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: String,
    pub before: Option<folders::Folder>,
    pub parent: Option<folders::Folder>,
    pub child_count: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub intent: Intent,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub before_version: String,
    pub folder: Option<folders::Folder>,
}
fn invalid() -> DbErr {
    DbErr::Custom("文件夹操作、名字、父目录或目标无效".into())
}
async fn read(db: &DatabaseTransaction, id: i32) -> Result<folders::Folder, DbErr> {
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id FROM image_folder WHERE id=$1 FOR UPDATE",
        [id.into()],
    ))
    .await?
    .ok_or_else(invalid)?;
    folders::Folder::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT f.id,COALESCE(f.parent_id,0) AS parent_id,f.name,count(m.image_id)::bigint AS image_count \
         FROM image_folder f LEFT JOIN image_metadata m ON m.folder_id=f.id WHERE f.id=$1 GROUP BY f.id",[id.into()]))
        .one(db).await?.ok_or_else(invalid)
}
async fn plan(db: &DatabaseTransaction, intent: &Intent) -> Result<Prepared, DbErr> {
    let (before, parent, child_count) = match intent.action {
        Action::Create => {
            let name = intent.name.as_deref().ok_or_else(invalid)?;
            if intent.id.is_some()
                || name != name.trim()
                || name.is_empty()
                || name.chars().count() > 80
                || name.contains(['/', '\\', '\0'])
                || matches!(name, "." | "..")
                || intent.parent_id < 0
            {
                return Err(invalid());
            }
            folders::creation_name(
                db,
                &folders::Create {
                    name: name.to_owned(),
                    parent_id: intent.parent_id,
                },
            )
            .await?;
            let duplicate=db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "SELECT id FROM image_folder WHERE COALESCE(parent_id,0)=$1 AND lower(name)=lower($2)",
                [intent.parent_id.into(),name.into()])).await?;
            if duplicate.is_some() {
                return Err(DbErr::Custom(
                    "父目录下已有同名文件夹，请使用现有目录".into(),
                ));
            }
            let parent = if intent.parent_id > 0 {
                Some(read(db, intent.parent_id).await?)
            } else {
                None
            };
            (None, parent, 0)
        }
        Action::Delete => {
            if intent.name.is_some() || intent.parent_id != 0 || intent.id.is_none_or(|v| v <= 0) {
                return Err(invalid());
            }
            let before = read(db, intent.id.unwrap()).await?;
            let children: i64 = db
                .query_one(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "SELECT count(*) AS n FROM image_folder WHERE parent_id=$1",
                    [before.id.into()],
                ))
                .await?
                .ok_or_else(invalid)?
                .try_get("", "n")?;
            if before.image_count != 0 || children != 0 {
                return Err(DbErr::Custom(
                    "文件夹不为空，请先移动图片和子文件夹；不会递归删除".into(),
                ));
            }
            (Some(before), None, children)
        }
    };
    let parent_key = parent.as_ref().map(|v| (v.id, v.parent_id, &v.name));
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(intent, &before, parent_key, child_count))
            .map_err(|e| DbErr::Custom(e.to_string()))?,
    ));
    Ok(Prepared {
        version,
        before,
        parent,
        child_count,
    })
}
pub(in crate::routes) async fn apply(
    db: &DatabaseTransaction,
    change: &Change,
) -> Result<Outcome, DbErr> {
    let plan = plan(db, &change.intent).await?;
    if change.version.len() != 64 || change.version != plan.version {
        return Err(DbErr::Custom("文件夹状态已变化，请重新确认".into()));
    }
    let folder = match change.intent.action {
        Action::Create => Some(
            folders::create_in(
                db,
                folders::Create {
                    name: change.intent.name.clone().unwrap(),
                    parent_id: change.intent.parent_id,
                },
            )
            .await?,
        ),
        Action::Delete => {
            let removed=db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "DELETE FROM image_folder f WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM image_folder c WHERE c.parent_id=f.id) \
                 AND NOT EXISTS(SELECT 1 FROM image_metadata m WHERE m.folder_id=f.id)",
                [change.intent.id.unwrap().into()])).await?;
            if removed.rows_affected() != 1 {
                return Err(invalid());
            }
            None
        }
    };
    Ok(Outcome {
        changed: true,
        before_version: change.version.clone(),
        folder,
    })
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(intent): Json<Intent>,
) -> Json<ApiResponse<Prepared>> {
    response(
        async {
            actor(&state, &headers).await?;
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
                .await?;
            let result = plan(&txn, &intent).await?;
            txn.commit().await?;
            Ok(result)
        }
        .await,
    )
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    response(
        async {
            actor(&state, &headers).await?;
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::Serializable), None)
                .await?;
            let result = apply(&txn, &change).await?;
            txn.commit().await?;
            Ok(result)
        }
        .await,
    )
}
#[cfg(test)]
mod tests;
