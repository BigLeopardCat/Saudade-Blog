//! Human approval owns paid generation and acceptance; Agent proposes only immutable jobs.
mod jobs;
mod provider;
mod references;
mod settings;
#[cfg(test)]
mod tests;

use crate::{routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use sea_orm::{ConnectionTrait, DatabaseBackend, DbErr, FromQueryResult, Statement, Value};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn error(message: impl Into<String>) -> DbErr {
    DbErr::Custom(message.into())
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn stmt(sql: &str, args: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, args)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub quality: String,
    #[serde(default)]
    pub reference_ids: Vec<i32>,
}
impl Draft {
    fn validate(&self, models: &[String]) -> Result<(), DbErr> {
        if self.prompt.trim().is_empty()
            || self.prompt.chars().count() > 32000
            || !models.contains(&self.model)
            || !["1024x1024", "1536x1024", "1024x1536"].contains(&self.size.as_str())
            || !["low", "medium", "high", "auto"].contains(&self.quality.as_str())
            || self.reference_ids.len() > 4
            || self.reference_ids.iter().any(|id| *id <= 0)
            || self
                .reference_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.reference_ids.len()
        {
            return Err(error("请核对提示词、模型、尺寸、质量和参考图片"));
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub image_id: i32,
    pub name: String,
    pub digest: String,
    #[serde(default)]
    pub preview_url: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub quality: String,
    pub references: Vec<Reference>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub request: Option<Request>,
    pub request_hash: String,
    pub status: String,
    pub preview_url: Option<String>,
    pub output_hash: Option<String>,
    pub image_id: Option<i32>,
    pub error: Option<String>,
    pub usage: Option<JsonValue>,
    pub created_at: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub version: String,
}

fn response<T: Default>(result: Result<T, DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(v) => Json(ApiResponse::success(v)),
        Err(e) => {
            tracing::warn!(error=%e,"image generation operation failed");
            Json(ApiResponse::error(
                "生图请求无效、服务未配置或任务已变化，请刷新后核对",
            ))
        }
    }
}

pub async fn options() -> Json<ApiResponse<settings::Options>> {
    let value = match settings::Settings::load() {
        Ok(s) => settings::Options {
            configured: true,
            default_model: s.models[0].clone(),
            models: s.models,
        },
        Err(_) => settings::Options::default(),
    };
    Json(ApiResponse::success(value))
}
pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Draft>,
) -> Json<ApiResponse<Job>> {
    response(
        async {
            let uid = crate::routes::gallery::actor(&state, &headers).await?;
            jobs::create(&state, uid, input).await
        }
        .await,
    )
}
pub async fn detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Json<ApiResponse<Job>> {
    response(
        async {
            let uid = crate::routes::gallery::actor(&state, &headers).await?;
            jobs::read(&state, uid, &id).await
        }
        .await,
    )
}
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<Job>>> {
    response(async {
        let uid=crate::routes::gallery::actor(&state,&headers).await?;
        let rows=state.db.query_all(stmt("SELECT id::text AS id FROM image_generation WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 30",vec![uid.into()])).await?;
        let mut result=Vec::new();for row in rows {result.push(jobs::read(&state,uid,&row.try_get::<String>("","id")?).await?);}Ok(result)
    }.await)
}
pub async fn approve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Approval>,
) -> Json<ApiResponse<Job>> {
    response(
        async {
            let uid = crate::routes::gallery::actor(&state, &headers).await?;
            jobs::approve(state, uid, &id, input).await
        }
        .await,
    )
}
pub async fn accept(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Approval>,
) -> Json<ApiResponse<Job>> {
    response(
        async {
            let uid = crate::routes::gallery::actor(&state, &headers).await?;
            jobs::accept(&state, uid, &id, input).await
        }
        .await,
    )
}
pub async fn reject(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Json<ApiResponse<Job>> {
    response(
        async {
            let uid = crate::routes::gallery::actor(&state, &headers).await?;
            jobs::reject(&state, uid, &id).await
        }
        .await,
    )
}

#[derive(Serialize, Deserialize)]
struct PreviewClaims {
    sub: String,
    job: String,
    slot: i16,
    digest: String,
    exp: usize,
}
fn preview_url(uid: i32, id: &str, slot: i16, digest: &str) -> Result<String, DbErr> {
    let key = std::env::var("JWT_SECRET").map_err(|_| error("preview signing unavailable"))?;
    if key.is_empty() {
        return Err(error("preview signing unavailable"));
    }
    let claims = PreviewClaims {
        sub: uid.to_string(),
        job: id.into(),
        slot,
        digest: digest.into(),
        exp: (chrono::Utc::now().timestamp() + 900) as usize,
    };
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(key.as_bytes()),
    )
    .map_err(|_| error("preview signing failed"))?;
    Ok(format!(
        "/api/public/image-generation/{id}/preview?token={token}"
    ))
}
#[derive(Deserialize)]
pub struct PreviewQuery {
    token: String,
}
pub async fn preview(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<PreviewQuery>,
) -> impl IntoResponse {
    let read=async {
        let key=std::env::var("JWT_SECRET").map_err(|_|())?;
        if key.is_empty(){return Err(());}
        let claims=jsonwebtoken::decode::<PreviewClaims>(&q.token,&jsonwebtoken::DecodingKey::from_secret(key.as_bytes()),&jsonwebtoken::Validation::default()).map_err(|_|())?.claims;
        if claims.job!=id{return Err(());}
        let uid=claims.sub.parse::<i32>().map_err(|_|())?;
        let query=if claims.slot<0 {
            stmt("SELECT output AS bytes,'image/png' AS mime FROM image_generation WHERE id::text=$1 AND owner_id=$2 AND output_hash=$3 AND status='review'",vec![id.into(),uid.into(),claims.digest.into()])
        }else{
            stmt("SELECT r.bytes,r.mime FROM image_generation_reference r JOIN image_generation j ON j.id=r.job_id WHERE j.id::text=$1 AND j.owner_id=$2 AND r.ordinal=$3 AND j.status IN ('pending','generating','review')",vec![id.into(),uid.into(),claims.slot.into()])
        };
        let row=state.db.query_one(query).await.map_err(|_|())?.ok_or(())?;
        let bytes:Vec<u8>=row.try_get("","bytes").map_err(|_|())?;
        if digest(&bytes)!=claims.digest{return Err(());}
        let mime:String=row.try_get("","mime").map_err(|_|())?;
        Ok((mime,bytes))
    }.await;
    match read {
        Ok((mime, bytes)) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "private, no-store".into()),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
            ],
            bytes,
        )
            .into_response(),
        Err(()) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Default, Serialize, FromQueryResult)]
#[serde(rename_all = "camelCase")]
pub struct ArticleContext {
    pub title: String,
    pub description: String,
    pub content: String,
}
pub async fn article_context(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Json<ApiResponse<ArticleContext>> {
    response(ArticleContext::find_by_statement(stmt("SELECT title,COALESCE(description,'') AS description,left(content,12000) AS content FROM note WHERE id=$1",vec![id.into()])).one(&state.db).await.and_then(|row|row.ok_or_else(||error("article missing"))))
}
