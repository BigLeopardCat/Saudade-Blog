use crate::{
    r2,
    routes::gallery::{actions::ActionError, Image},
    utils::upload_dir,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseTransaction, Statement, Value};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Target {
    pub image_id: i32,
    pub storage_kind: String,
    pub storage_scope: String,
    pub storage_bucket: Option<String>,
    pub storage_key: String,
}

pub(crate) fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && matches!(
            (
                Path::new(value).components().next(),
                Path::new(value).components().count()
            ),
            (Some(Component::Normal(_)), 1)
        )
}

pub(super) async fn local_root() -> Result<PathBuf, ActionError> {
    let absolute = std::path::absolute(upload_dir()).map_err(|_| ActionError::Storage)?;
    match tokio::fs::canonicalize(&absolute).await {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(absolute),
        Err(_) => Err(ActionError::Storage),
    }
}

pub(super) fn endpoint(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(value.trim_end_matches('/').to_string())
}

pub(crate) async fn targets(
    db: &DatabaseTransaction,
    images: &[Image],
) -> Result<Vec<Target>, ActionError> {
    let ids: Vec<_> = images.iter().map(|v| v.image_key).collect();
    let placeholders = crate::routes::gallery::placeholders(1, ids.len());
    let duplicate=db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        format!("SELECT 1 FROM images i WHERE i.image_key NOT IN ({placeholders}) \
         AND NOT EXISTS(SELECT 1 FROM image_deletion d WHERE d.image_id=i.image_key) \
         AND EXISTS(SELECT 1 FROM images selected WHERE selected.image_key IN ({placeholders}) AND selected.image_url=i.image_url) LIMIT 1"),
        ids.iter().map(|id|(*id).into()).collect::<Vec<Value>>())).await?;
    if duplicate.is_some() {
        return Err(ActionError::Conflict);
    }
    let cfg = r2::load_config(db).await?;
    let creds = r2::load_creds();
    let root = local_root().await?;
    let mut result = Vec::new();
    for image in images {
        if let Some(key) = image
            .image_url
            .strip_prefix("/api/protect/download/")
            .filter(|key| safe_filename(key))
        {
            result.push(Target {
                image_id: image.image_key,
                storage_kind: "local".into(),
                storage_scope: root.to_string_lossy().into_owned(),
                storage_bucket: None,
                storage_key: key.into(),
            });
        } else {
            if !cfg.active() {
                return Err(ActionError::Storage);
            }
            let key = r2::r2_key_of(&image.image_url, &cfg).ok_or(ActionError::Storage)?;
            if key.is_empty() || key.split('/').any(|v| !safe_filename(v)) {
                return Err(ActionError::Storage);
            }
            let credentials = creds.as_ref().ok_or(ActionError::Storage)?;
            let scope = endpoint(&credentials.endpoint).ok_or(ActionError::Storage)?;
            result.push(Target {
                image_id: image.image_key,
                storage_kind: "r2".into(),
                storage_scope: scope,
                storage_bucket: Some(cfg.bucket.clone()),
                storage_key: key,
            });
        }
    }
    Ok(result)
}
