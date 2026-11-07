use super::{input, references, ActionError, Intent};
use crate::routes::gallery::{deletions, Image, SELECT};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseTransaction, FromQueryResult, Statement, Value,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub id: i32,
    pub name: String,
    pub parent_id: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub image_id: i32,
    pub display_name: Option<String>,
    pub folder_id: i32,
    pub is_favorite: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: String,
    pub expires_at: i64,
    pub intent: Intent,
    pub matched_ids: Vec<i32>,
    pub preview: Vec<Preview>,
    pub preview_truncated: bool,
    pub destination: Option<Destination>,
}

pub(super) struct Planned {
    pub prepared: Prepared,
    pub images: Vec<Image>,
    pub storage: Vec<deletions::Target>,
}

use crate::routes::gallery::placeholders;

pub(super) async fn read_many(
    db: &DatabaseTransaction,
    uid: i32,
    ids: &[i32],
) -> Result<Vec<Image>, ActionError> {
    let mut args: Vec<Value> = vec![uid.into()];
    args.extend(ids.iter().map(|id| (*id).into()));
    let images=Image::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        format!("{SELECT} WHERE i.image_key IN ({}) AND NOT EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=i.image_key) ORDER BY i.image_key",placeholders(2,ids.len())),args)).all(db).await?;
    if images.len() != ids.len() {
        return Err(ActionError::Conflict);
    }
    Ok(images)
}

async fn folders(
    db: &DatabaseTransaction,
    intent: &Intent,
    locked: bool,
) -> Result<Vec<Destination>, ActionError> {
    let wanted = intent.folders();
    let ids: Vec<_> = wanted.iter().copied().filter(|id| *id > 0).collect();
    let mut result = Vec::new();
    if wanted.contains(&0) {
        result.push(Destination {
            id: 0,
            name: "未分类".into(),
            parent_id: 0,
        });
    }
    if !ids.is_empty() {
        let rows=db.query_all(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            format!("SELECT id,name,COALESCE(parent_id,0) AS parent_id FROM image_folder WHERE id IN ({}) ORDER BY id{}",placeholders(1,ids.len()),if locked{" FOR SHARE"}else{""}),
            ids.iter().map(|id|(*id).into()).collect::<Vec<Value>>())).await?;
        if rows.len() != ids.len() {
            return Err(ActionError::Conflict);
        }
        for row in rows {
            result.push(Destination {
                id: row.try_get("", "id")?,
                name: row.try_get("", "name")?,
                parent_id: row.try_get("", "parent_id")?,
            });
        }
    }
    Ok(result)
}

pub(super) async fn build(
    db: &DatabaseTransaction,
    uid: i32,
    intent: Intent,
    expires_at: i64,
    locked: bool,
) -> Result<Planned, ActionError> {
    let ids = intent.ids();
    if locked {
        if matches!(intent, Intent::Delete { .. }) {
            references::fence(db, true).await?;
        }
        // Lock first, then read joined metadata in a fresh READ COMMITTED snapshot.
        let locked_rows=db.query_all(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            format!("SELECT image_key FROM images WHERE image_key IN ({}) ORDER BY image_key FOR UPDATE",placeholders(1,ids.len())),ids.iter().map(|id|(*id).into()).collect::<Vec<Value>>())).await?;
        if locked_rows.len() != ids.len() {
            return Err(ActionError::Conflict);
        }
    }
    let images = read_many(db, uid, &ids).await?;
    let destinations = folders(db, &intent, locked).await?;
    let storage = if matches!(intent, Intent::Delete { .. }) {
        if let Some(reference) = references::first_use(db, &images).await? {
            return Err(ActionError::Referenced(reference));
        }
        deletions::targets(db, &images).await?
    } else {
        Vec::new()
    };
    let versions: Vec<_> = images.iter().map(|v| (v.image_key, &v.version)).collect();
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(uid, &intent, expires_at, versions, &destinations, &storage))
            .map_err(|_| ActionError::Invalid)?,
    ));
    let preview = images
        .iter()
        .take(input::PREVIEW_LIMIT)
        .map(|v| Preview {
            image_id: v.image_key,
            display_name: v.display_name.clone(),
            folder_id: v.folder_id,
            is_favorite: v.is_favorite,
        })
        .collect();
    let destination = if matches!(intent, Intent::Move { .. }) {
        destinations.into_iter().next()
    } else {
        None
    };
    Ok(Planned {
        prepared: Prepared {
            version,
            expires_at,
            intent,
            matched_ids: ids,
            preview,
            preview_truncated: images.len() > input::PREVIEW_LIMIT,
            destination,
        },
        images,
        storage,
    })
}
