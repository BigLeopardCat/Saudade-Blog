//! Durable cleanup of immutable storage objects after a committed catalogue deletion.
mod target;
mod worker;
pub(crate) use target::{safe_filename, targets, Target};
pub(crate) use worker::{start, stop, wake};

use crate::routes::gallery::{actions::ActionError, references, Image};
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseTransaction, Statement};
use serde::Serialize;

#[derive(Serialize)]
struct Entry<'a> {
    image_id: i32,
    image_url: &'a str,
    decoded_url: String,
    requested_by: i32,
    storage_kind: &'a str,
    storage_scope: &'a str,
    storage_bucket: Option<&'a str>,
    storage_key: &'a str,
}

pub(crate) async fn enqueue(
    db: &DatabaseTransaction,
    uid: i32,
    images: &[Image],
    targets: &[Target],
) -> Result<(), ActionError> {
    if images.len() != targets.len() {
        return Err(ActionError::Conflict);
    }
    let mut entries = Vec::with_capacity(images.len());
    for (image, target) in images.iter().zip(targets) {
        if image.image_key != target.image_id {
            return Err(ActionError::Conflict);
        }
        entries.push(Entry {
            image_id: image.image_key,
            image_url: &image.image_url,
            decoded_url: references::decoded(&image.image_url),
            requested_by: uid,
            storage_kind: &target.storage_kind,
            storage_scope: &target.storage_scope,
            storage_bucket: target.storage_bucket.as_deref(),
            storage_key: &target.storage_key,
        });
    }
    let inserted = db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO image_deletion(image_id,image_url,decoded_url,requested_by,storage_kind,storage_scope,storage_bucket,storage_key) \
         SELECT image_id,image_url,decoded_url,requested_by,storage_kind,storage_scope,storage_bucket,storage_key \
         FROM jsonb_to_recordset($1::jsonb) AS v(image_id integer,image_url text,decoded_url text,requested_by integer, \
         storage_kind text,storage_scope text,storage_bucket text,storage_key text)",
         [serde_json::to_value(entries).map_err(|_|ActionError::Invalid)?.into()])).await?;
    if inserted.rows_affected() != images.len() as u64 {
        return Err(ActionError::Conflict);
    }
    let ids: Vec<_> = images.iter().map(|v| v.image_key).collect();
    // A removed asset no longer occupies a visible folder; its descriptive history is retained.
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "UPDATE image_metadata SET folder_id=NULL WHERE image_id IN ({})",
            crate::routes::gallery::placeholders(1, ids.len())
        ),
        ids.into_iter().map(Into::into).collect::<Vec<_>>(),
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
