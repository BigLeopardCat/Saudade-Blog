use super::{
    plan::{self, Planned},
    ActionError, Intent, Outcome,
};
use crate::routes::gallery::{deletions, Image};
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseTransaction, Statement, Value};
use serde::Serialize;

#[derive(Serialize)]
struct Resolved {
    id: i32,
    name: Option<String>,
    description: String,
    folder: i32,
    favorite: bool,
}

fn resolve(intent: &Intent, image: &Image) -> Resolved {
    let patch = intent.patch(image.image_key);
    Resolved {
        id: image.image_key,
        name: patch.display_name.or_else(|| image.display_name.clone()),
        description: patch
            .description
            .unwrap_or_else(|| image.description.clone()),
        folder: patch.folder_id.unwrap_or(image.folder_id),
        favorite: patch.is_favorite.unwrap_or(image.is_favorite),
    }
}

fn metadata_changed(before: &Image, after: &Resolved) -> bool {
    before.display_name != after.name
        || before.description != after.description
        || before.folder_id != after.folder
}

async fn favorite(
    db: &DatabaseTransaction,
    uid: i32,
    ids: &[i32],
    value: bool,
) -> Result<(), ActionError> {
    if ids.is_empty() {
        return Ok(());
    }
    let sql = if value {
        format!("INSERT INTO image_favorite(image_id,user_id) SELECT image_key,$1 FROM images WHERE image_key IN ({}) ON CONFLICT DO NOTHING",crate::routes::gallery::placeholders(2,ids.len()))
    } else {
        format!(
            "DELETE FROM image_favorite WHERE user_id=$1 AND image_id IN ({})",
            crate::routes::gallery::placeholders(2, ids.len())
        )
    };
    let mut args: Vec<Value> = vec![uid.into()];
    args.extend(ids.iter().map(|id| (*id).into()));
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        args,
    ))
    .await?;
    Ok(())
}

pub(super) async fn apply(
    db: &DatabaseTransaction,
    uid: i32,
    planned: Planned,
    before_version: &str,
) -> Result<Outcome, ActionError> {
    let prepared = planned.prepared;
    if matches!(prepared.intent, Intent::Delete { .. }) {
        deletions::enqueue(db, uid, &planned.images, &planned.storage).await?;
        return Ok(Outcome {
            action: "delete".into(),
            changed: true,
            before_version: before_version.into(),
            matched_ids: prepared.matched_ids.clone(),
            changed_ids: prepared.matched_ids.clone(),
            cleanup_pending_ids: prepared.matched_ids,
        });
    }
    let resolved: Vec<_> = planned
        .images
        .iter()
        .map(|image| resolve(&prepared.intent, image))
        .collect();
    let rows: Vec<_> = planned
        .images
        .iter()
        .zip(&resolved)
        .filter(|(before, after)| metadata_changed(before, after))
        .map(|(_, after)| after)
        .collect();
    if !rows.is_empty() {
        db.execute(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO image_metadata(image_id,display_name,description,folder_id) \
             SELECT v.id,v.name,v.description,NULLIF(v.folder,0) FROM jsonb_to_recordset($1::jsonb) \
             AS v(id integer,name text,description text,folder integer) \
             ON CONFLICT(image_id) DO UPDATE SET display_name=EXCLUDED.display_name,description=EXCLUDED.description,folder_id=EXCLUDED.folder_id",
            [serde_json::to_value(rows).map_err(|_|ActionError::Invalid)?.into()])).await?;
    }
    for value in [true, false] {
        let ids: Vec<_> = planned
            .images
            .iter()
            .zip(&resolved)
            .filter(|(before, after)| {
                before.is_favorite != after.favorite && after.favorite == value
            })
            .map(|(_, after)| after.id)
            .collect();
        favorite(db, uid, &ids, value).await?;
    }
    let after = plan::read_many(db, uid, &prepared.matched_ids).await?;
    for ((before, expected), actual) in planned.images.iter().zip(&resolved).zip(&after) {
        if actual.image_url != before.image_url
            || metadata_changed(actual, expected)
            || actual.is_favorite != expected.favorite
        {
            return Err(ActionError::Conflict);
        }
    }
    let changed_ids: Vec<_> = planned
        .images
        .iter()
        .zip(after)
        .filter(|(before, after)| before.version != after.version)
        .map(|(_, after)| after.image_key)
        .collect();
    Ok(Outcome {
        action: prepared.intent.name().into(),
        changed: !changed_ids.is_empty(),
        before_version: before_version.into(),
        matched_ids: prepared.matched_ids,
        changed_ids,
        cleanup_pending_ids: Vec::new(),
    })
}
