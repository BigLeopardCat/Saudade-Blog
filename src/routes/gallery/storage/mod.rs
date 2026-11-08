//! Stable media identities resolve to typed provider paths; credentials never enter catalogue data.
use super::{deletions, Image};
use crate::{r2, utils::upload_dir};
use object_store::{local::LocalFileSystem, path::Path, ObjectStore, ObjectStoreExt};
use sea_orm::{ConnectionTrait, DatabaseBackend, DbErr, Statement};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Local,
    R2,
}
impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::R2 => "r2",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Location {
    pub storage: Kind,
    pub scope: String,
    pub bucket: Option<String>,
    pub key: String,
}
pub(crate) fn error() -> DbErr {
    DbErr::Custom("图片存储暂不可用，请核对图库与存储设置".into())
}
fn key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && value.split('/').all(deletions::safe_filename)
}
async fn root() -> Result<String, DbErr> {
    tokio::fs::create_dir_all(upload_dir())
        .await
        .map_err(|_| error())?;
    Ok(tokio::fs::canonicalize(upload_dir())
        .await
        .map_err(|_| error())?
        .to_string_lossy()
        .into_owned())
}
pub(crate) async fn destination<C: ConnectionTrait>(
    db: &C,
    storage: Kind,
    name: &str,
) -> Result<Location, DbErr> {
    if !deletions::safe_filename(name) {
        return Err(error());
    }
    match storage {
        Kind::Local => Ok(Location {
            storage,
            scope: root().await?,
            bucket: None,
            key: name.into(),
        }),
        Kind::R2 => {
            let cfg = r2::load_config(db).await?;
            let creds = r2::load_creds().ok_or_else(error)?;
            if !cfg.active() {
                return Err(error());
            }
            Ok(Location {
                storage,
                scope: creds.endpoint,
                bucket: Some(cfg.bucket),
                key: format!("{}/{name}", cfg.prefix),
            })
        }
    }
}
pub(crate) async fn resolve<C: ConnectionTrait>(db: &C, image: &Image) -> Result<Location, DbErr> {
    if let Some(row) = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT location FROM image_location WHERE image_id=$1",
            [image.image_key.into()],
        ))
        .await?
    {
        return serde_json::from_value(row.try_get("", "location")?).map_err(|_| error());
    }
    if let Some(name) = image
        .image_url
        .strip_prefix("/api/protect/download/")
        .filter(|n| deletions::safe_filename(n))
    {
        return destination(db, Kind::Local, name).await;
    }
    let cfg = r2::load_config(db).await?;
    let object = r2::r2_key_of(&image.image_url, &cfg)
        .filter(|v| key(v) && v.starts_with(&format!("{}/", cfg.prefix)))
        .ok_or_else(error)?;
    let creds = r2::load_creds().ok_or_else(error)?;
    Ok(Location {
        storage: Kind::R2,
        scope: creds.endpoint,
        bucket: Some(cfg.bucket),
        key: object,
    })
}
pub(crate) async fn store<C: ConnectionTrait>(
    db: &C,
    loc: &Location,
) -> Result<Arc<dyn ObjectStore>, DbErr> {
    if !key(&loc.key) {
        return Err(error());
    }
    match loc.storage {
        Kind::Local => {
            if !deletions::safe_filename(&loc.key)
                || loc.bucket.is_some()
                || root().await? != loc.scope
            {
                return Err(error());
            }
            if let Ok(meta) =
                tokio::fs::symlink_metadata(std::path::Path::new(&loc.scope).join(&loc.key)).await
            {
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err(error());
                }
            }
            Ok(Arc::new(
                LocalFileSystem::new_with_prefix(&loc.scope)
                    .map_err(|_| error())?
                    .with_fsync(true),
            ))
        }
        Kind::R2 => {
            let cfg = r2::load_config(db).await?;
            let creds = r2::load_creds().ok_or_else(error)?;
            if creds.endpoint != loc.scope
                || loc.bucket.as_deref() != Some(cfg.bucket.as_str())
                || !loc.key.starts_with(&format!("{}/", cfg.prefix))
            {
                return Err(error());
            }
            r2::store(&creds, &cfg.bucket).map_err(|_| error())
        }
    }
}
pub(crate) async fn read<C: ConnectionTrait>(
    db: &C,
    loc: &Location,
) -> Result<axum::body::Bytes, DbErr> {
    let store = store(db, loc).await?;
    let result = store
        .get(&Path::parse(&loc.key).map_err(|_| error())?)
        .await
        .map_err(|_| error())?;
    if result.meta.size > crate::routes::upload::IMAGE_MAX_BYTES as u64 {
        return Err(error());
    }
    result.bytes().await.map_err(|_| error())
}
pub(crate) async fn put<C: ConnectionTrait>(
    db: &C,
    loc: &Location,
    data: axum::body::Bytes,
) -> Result<(), DbErr> {
    if data.len() > crate::routes::upload::IMAGE_MAX_BYTES
        || crate::utils::sniff_image_ext(&data).is_none()
    {
        return Err(error());
    }
    let store = store(db, loc).await?;
    let ext = crate::utils::sniff_image_ext(&data).ok_or_else(error)?;
    let content_type = if ext == "jpg" {
        "image/jpeg".into()
    } else {
        format!("image/{ext}")
    };
    let mut attributes = object_store::Attributes::new();
    if loc.storage == Kind::R2 {
        attributes.insert(object_store::Attribute::ContentType, content_type.into());
    }
    store
        .put_opts(
            &Path::parse(&loc.key).map_err(|_| error())?,
            data.into(),
            object_store::PutOptions {
                attributes,
                ..Default::default()
            },
        )
        .await
        .map_err(|_| error())?;
    Ok(())
}
pub(crate) async fn size<C: ConnectionTrait>(db: &C, loc: &Location) -> Result<u64, DbErr> {
    let store = store(db, loc).await?;
    match store
        .head(&Path::parse(&loc.key).map_err(|_| error())?)
        .await
    {
        Ok(meta) => Ok(meta.size),
        Err(object_store::Error::NotFound { .. }) => Ok(0),
        Err(_) => Err(error()),
    }
}
pub(crate) async fn remove<C: ConnectionTrait>(db: &C, loc: &Location) -> Result<(), DbErr> {
    let store = store(db, loc).await?;
    match store
        .delete(&Path::parse(&loc.key).map_err(|_| error())?)
        .await
    {
        Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
        Err(_) => Err(error()),
    }
}
pub fn media_url(id: uuid::Uuid) -> String {
    format!("/api/public/media/{id}")
}
pub fn public_id(url: &str) -> Option<uuid::Uuid> {
    let raw = url.strip_prefix("/api/public/media/")?;
    let id = uuid::Uuid::parse_str(raw).ok()?;
    (id.to_string() == raw).then_some(id)
}

pub async fn media(
    axum::extract::State(state): axum::extract::State<Arc<crate::routes::AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let Some(public_id) = public_id(&format!("/api/public/media/{id}")) else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    let result = state
        .db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT image_id FROM image_location WHERE public_id=$1::uuid",
            [public_id.to_string().into()],
        ))
        .await;
    match result {
        Ok(Some(row)) => match row.try_get::<i32>("", "image_id") {
            Ok(id) => serve(state, id, true).await,
            Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
        },
        Ok(None) => axum::http::StatusCode::NOT_FOUND.into_response(),
        Err(_) => axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

pub async fn content(
    axum::extract::State(state): axum::extract::State<Arc<crate::routes::AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
) -> axum::response::Response {
    serve(state, id, false).await
}

async fn serve(
    state: Arc<crate::routes::AppState>,
    id: i32,
    redirect: bool,
) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse};
    let result = async {
        let image = super::read(&state.db, 0, id).await?;
        let loc = resolve(&state.db, &image).await?;
        if redirect && loc.storage == Kind::R2 {
            let cfg = r2::load_config(&state.db).await?;
            let creds = r2::load_creds().ok_or_else(error)?;
            if loc.bucket.as_deref() != Some(cfg.bucket.as_str())
                || loc.scope != creds.endpoint
                || !loc.key.starts_with(&format!("{}/", cfg.prefix))
            {
                return Err(error());
            }
            let url = reqwest::Url::parse(&r2::public_url(&cfg.public_base, &loc.key))
                .map_err(|_| error())?;
            return Ok::<_, DbErr>(
                (
                    [("cache-control", "public,max-age=300")],
                    axum::response::Redirect::temporary(url.as_str()),
                )
                    .into_response(),
            );
        }
        let bytes = read(&state.db, &loc).await?;
        let ext = crate::utils::sniff_image_ext(&bytes).ok_or_else(error)?;
        let ct = if ext == "jpg" {
            "image/jpeg".to_owned()
        } else {
            format!("image/{ext}")
        };
        Ok::<_, DbErr>(
            (
                [
                    ("content-type", ct),
                    ("x-content-type-options", "nosniff".into()),
                    ("cache-control", "public,max-age=300".into()),
                ],
                bytes,
            )
                .into_response(),
        )
    };
    match tokio::time::timeout(std::time::Duration::from_secs(30), result).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::GATEWAY_TIMEOUT.into_response(),
    }
}
#[cfg(test)]
mod tests;
