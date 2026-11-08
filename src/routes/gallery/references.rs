//! Literal asset references share a transaction fence with logical deletion.
use crate::entity::note;
use futures::TryStreamExt;
use sea_orm::{
    ActiveValue, ConnectionTrait, DatabaseBackend, DatabaseTransaction, DbErr, FromQueryResult,
    Statement,
};

const LOCK_NAMESPACE: i32 = 0x53415544;
const LOCK_RESOURCE: i32 = 0x494d4752;

pub(crate) async fn fence(db: &DatabaseTransaction, exclusive: bool) -> Result<(), DbErr> {
    let function = if exclusive {
        "pg_advisory_xact_lock"
    } else {
        "pg_advisory_xact_lock_shared"
    };
    db.query_one(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!("SELECT {function}($1::integer,$2::integer)"),
        [LOCK_NAMESPACE.into(), LOCK_RESOURCE.into()],
    ))
    .await?;
    Ok(())
}

pub(super) fn decoded(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8_lossy()
        .into_owned()
}

/// The shared fence lasts until the caller's short write transaction commits.
pub(crate) async fn guard_texts(db: &DatabaseTransaction, values: &[&str]) -> Result<(), DbErr> {
    fence(db, false).await?;
    let raw = values.join("\n");
    if raw.is_empty() {
        return Ok(());
    }
    let plain = decoded(&raw);
    if db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT image_id FROM image_deletion WHERE position(image_url in $1::text)>0 \
         OR position(decoded_url in $2::text)>0 LIMIT 1",
            [raw.into(), plain.into()],
        ))
        .await?
        .is_some()
    {
        return Err(DbErr::Custom(
            "图片已从图库移除，请选择有效图片后保存".into(),
        ));
    }
    if db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "SELECT image_id FROM image_location WHERE source_url IS NOT NULL AND source_url<>('/api/public/media/'||image_id::text) AND position(source_url in $1::text)>0 LIMIT 1",[values.join("\n").into()])).await?.is_some() {
        return Err(DbErr::Custom("图片地址已更新，请刷新编辑器或重新选择图库图片后保存".into()));
    }
    Ok(())
}

pub(crate) async fn guard_model(
    db: &DatabaseTransaction,
    model: &note::ActiveModel,
) -> Result<(), DbErr> {
    let content = match &model.content {
        ActiveValue::Set(v) | ActiveValue::Unchanged(v) => v.as_str(),
        _ => "",
    };
    let cover = match &model.cover {
        ActiveValue::Set(Some(v)) | ActiveValue::Unchanged(Some(v)) => v.as_str(),
        _ => "",
    };
    guard_texts(db, &[content, cover]).await
}

#[derive(Clone, Debug)]
pub(crate) struct Blocker {
    pub image_id: i32,
    pub resource: String,
    pub resource_id: String,
}

#[derive(FromQueryResult)]
struct Reference {
    resource: String,
    resource_id: String,
    content: String,
    cover: Option<String>,
}

/// Chat history is allowed to show an expired attachment; durable published content is not.
pub(super) async fn first_use(
    db: &DatabaseTransaction,
    images: &[super::Image],
) -> Result<Option<Blocker>, DbErr> {
    let aliases: Vec<_> = images
        .iter()
        .map(|image| (image.image_key, &image.image_url, decoded(&image.image_url)))
        .collect();
    let mut rows = Reference::find_by_statement(Statement::from_string(DatabaseBackend::Postgres,
        "SELECT 'article'::text AS resource,id::text AS resource_id,content,cover FROM note \
         UNION ALL SELECT 'comment',id::text,content,NULL::text FROM note_comment WHERE is_deleted=0 \
         UNION ALL SELECT 'talk',id::text,content,NULL::text FROM talk \
         UNION ALL SELECT 'announcement',id::text,content,NULL::text FROM announcement \
         UNION ALL SELECT 'message',id::text,content,NULL::text FROM user_message \
         UNION ALL SELECT 'message_draft',id::text,content,NULL::text FROM user_message_draft \
         UNION ALL SELECT 'notification',id::text,COALESCE(content,''),NULL::text FROM user_notification \
         UNION ALL SELECT 'knowledge',id::text,content,NULL::text FROM knowledge_base \
         UNION ALL SELECT 'user_avatar',id::text,''::text,avatar FROM \"user\" \
         UNION ALL SELECT 'site_avatar',key_name,''::text,value FROM web_info WHERE key_name='avatar'".to_string())).stream(db).await?;
    while let Some(row) = rows.try_next().await? {
        let raw = format!("{}\n{}", row.content, row.cover.as_deref().unwrap_or(""));
        let plain = decoded(&raw);
        if let Some((image_id, _, _)) = aliases.iter().find(|(_, url, decoded_url)| {
            raw.contains(url.as_str()) || plain.contains(decoded_url.as_str())
        }) {
            return Ok(Some(Blocker {
                image_id: *image_id,
                resource: row.resource,
                resource_id: row.resource_id,
            }));
        }
    }
    Ok(None)
}
