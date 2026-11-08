use super::{sql, Mode, Spec};
use crate::routes::gallery::{self, storage};
use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr, TransactionTrait};

pub(crate) async fn bind(
    db: &DatabaseTransaction,
    id: i32,
    source_url: &str,
    location: &storage::Location,
    rewrite_references: bool,
) -> Result<String, DbErr> {
    let row=db.query_one(sql("INSERT INTO image_location(image_id,location,source_url) VALUES($1,$2,$3) ON CONFLICT(image_id) DO UPDATE SET location=EXCLUDED.location RETURNING public_id::text AS public_id",
        vec![id.into(),serde_json::to_value(location).map_err(|_|storage::error())?.into(),Some(source_url).filter(|_|rewrite_references && storage::public_id(source_url).is_none()).into()])).await?.ok_or_else(storage::error)?;
    let public_id: String = row.try_get("", "public_id")?;
    let url = storage::media_url(uuid::Uuid::parse_str(&public_id).map_err(|_| storage::error())?);
    if rewrite_references && source_url != url {
        rewrite(db, source_url, &url).await?;
    }
    db.execute(sql(
        "UPDATE images SET image_url=$2 WHERE image_key=$1",
        vec![id.into(), url.clone().into()],
    ))
    .await?;
    Ok(url)
}
async fn rewrite(db: &DatabaseTransaction, from: &str, to: &str) -> Result<(), DbErr> {
    let mut aliases = vec![from.to_owned()];
    if let Ok(url) = reqwest::Url::parse(from) {
        if url.as_str() != from {
            aliases.push(url.to_string());
        }
    }
    for old in aliases {
        // Literal URL migration is confined to stored content fields, under the same fence as reference writes.
        for (table, column) in [
            ("note", "content"),
            ("note", "cover"),
            ("note_comment", "content"),
            ("user", "avatar"),
            ("web_info", "value"),
            ("announcement", "content"),
            ("talk", "content"),
            ("knowledge_base", "content"),
            ("user_notification", "content"),
            ("user_message", "content"),
            ("user_message_draft", "content"),
        ] {
            let revision = if table == "note" {
                ",updated_at=localtimestamp"
            } else {
                ""
            };
            db.execute(sql(&format!("UPDATE \"{table}\" SET \"{column}\"=replace(\"{column}\",$1,$2){revision} WHERE position($1 in \"{column}\")>0"),vec![old.clone().into(),to.into()])).await?;
        }
    }
    Ok(())
}
pub(super) async fn publish(
    db: &DatabaseConnection,
    id: &str,
    lease: &str,
    spec: &Spec,
) -> Result<(), DbErr> {
    let tx = db.begin().await?;
    let row = tx
        .query_one(sql(
            "SELECT status FROM image_transfer WHERE id=$1 AND lease::text=$2 FOR UPDATE",
            vec![id.into(), lease.into()],
        ))
        .await?
        .ok_or_else(storage::error)?;
    if row.try_get::<String>("", "status")? != "copying" {
        return Err(storage::error());
    }
    let actor = tx
        .query_one(sql(
            "SELECT role,status FROM \"user\" WHERE id=$1 FOR SHARE",
            vec![spec.owner.into()],
        ))
        .await?
        .ok_or_else(storage::error)?;
    if !crate::authz::can_access_console(&actor.try_get::<String>("", "role")?)
        || actor.try_get::<i16>("", "status")? != crate::authz::STATUS_ACTIVE
    {
        return Err(storage::error());
    }
    gallery::references::fence(&tx, true).await?;
    let ids = spec
        .intent
        .image_ids
        .iter()
        .copied()
        .map(Into::into)
        .collect::<Vec<sea_orm::Value>>();
    tx.query_all(sql(
        &format!(
            "SELECT image_key FROM images WHERE image_key IN ({}) ORDER BY image_key FOR UPDATE",
            gallery::placeholders(1, ids.len())
        ),
        ids,
    ))
    .await?;
    if spec.intent.folder_id > 0 {
        tx.query_one(sql(
            "SELECT id FROM image_folder WHERE id=$1 FOR SHARE",
            vec![spec.intent.folder_id.into()],
        ))
        .await?
        .ok_or_else(storage::error)?;
    }
    let mut changed = Vec::<i32>::new();
    for ((before, source), dest) in spec
        .images
        .iter()
        .zip(&spec.sources)
        .zip(&spec.destinations)
    {
        let fresh = gallery::read(&tx, spec.owner, before.image_key).await?;
        if fresh.version != before.version || storage::resolve(&tx, &fresh).await? != *source {
            return Err(storage::error());
        }
        let image_id = if spec.intent.mode == Mode::Copy {
            let row = tx
                .query_one(sql(
                    "INSERT INTO images(image_url) VALUES($1) RETURNING image_key",
                    vec![format!("transfer:{id}:{}", before.image_key).into()],
                ))
                .await?
                .ok_or_else(storage::error)?;
            row.try_get("", "image_key")?
        } else {
            before.image_key
        };
        let old = if spec.intent.mode == Mode::Copy {
            format!("transfer:{id}:{}", before.image_key)
        } else {
            before.image_url.clone()
        };
        bind(&tx, image_id, &old, dest, spec.intent.mode == Mode::Move).await?;
        tx.execute(sql("INSERT INTO image_metadata(image_id,display_name,description,folder_id) VALUES($1,$2,$3,NULLIF($4,0)) ON CONFLICT(image_id) DO UPDATE SET folder_id=EXCLUDED.folder_id",
            vec![image_id.into(),before.display_name.clone().into(),before.description.clone().into(),spec.intent.folder_id.into()])).await?;
        if spec.intent.mode == Mode::Copy && before.is_favorite {
            tx.execute(sql(
                "INSERT INTO image_favorite(image_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
                vec![image_id.into(), spec.owner.into()],
            ))
            .await?;
        }
        changed.push(image_id);
    }
    let result = serde_json::json!({"mode":spec.intent.mode,"sourceIds":spec.intent.image_ids,"imageIds":changed});
    tx.execute(sql("UPDATE image_transfer SET status='published',result=$3,last_error=NULL,next_attempt_at=now() WHERE id=$1 AND lease::text=$2",vec![id.into(),lease.into(),result.into()])).await?;
    tx.commit().await?;
    Ok(())
}
