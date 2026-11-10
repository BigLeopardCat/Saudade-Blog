//! Read-only access to the current RAG publication; optional on every deployment.

use super::Source;
use serde::Deserialize;
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::{sync::LazyLock, time::Duration};

static POOL: LazyLock<Option<PgPool>> = LazyLock::new(|| {
    let dsn = std::env::var("GRAPH_VECTOR_DSN").ok()?;
    if dsn.trim().is_empty() {
        return None;
    }
    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(2))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET default_transaction_read_only = on")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET statement_timeout = '2s'")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect_lazy(&dsn)
        .ok()
});

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<Embedding>,
}
#[derive(Deserialize)]
struct Embedding {
    embedding: Vec<f64>,
    index: usize,
}

fn embedding_request(space: &Value) -> Result<(String, String, String), &'static str> {
    let base = std::env::var("GRAPH_EMBEDDING_BASE_URL").map_err(|_| "embedding_not_configured")?;
    let model = std::env::var("GRAPH_EMBEDDING_MODEL").map_err(|_| "embedding_not_configured")?;
    let key = std::env::var("GRAPH_EMBEDDING_API_KEY").map_err(|_| "embedding_not_configured")?;
    if key.trim().is_empty() || model.trim().is_empty() {
        return Err("embedding_not_configured");
    }
    if space.get("model").and_then(Value::as_str) != Some(model.trim())
        || space
            .get("base_url")
            .and_then(Value::as_str)
            .map(|v| v.trim_end_matches('/'))
            != Some(base.trim_end_matches('/'))
    {
        return Err("embedding_space_mismatch");
    }
    let url = reqwest::Url::parse(&base).map_err(|_| "embedding_not_configured")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("embedding_not_configured");
    }
    Ok((
        format!("{}/embeddings", base.trim_end_matches('/')),
        model,
        key,
    ))
}

pub async fn rank(source: &Source, query: &str) -> Result<Vec<(i32, f64)>, &'static str> {
    if [
        "GRAPH_EMBEDDING_BASE_URL",
        "GRAPH_EMBEDDING_MODEL",
        "GRAPH_EMBEDDING_API_KEY",
    ]
    .iter()
    .any(|name| std::env::var(name).map_or(true, |value| value.trim().is_empty()))
    {
        return Err("embedding_not_configured");
    }
    let collection =
        std::env::var("GRAPH_VECTOR_COLLECTION").unwrap_or_else(|_| "blog-public".into());
    if collection != source.collection {
        return Err("vector_collection_mismatch");
    }
    let pool = POOL.as_ref().ok_or("vector_not_configured")?;
    let mut transaction = pool.begin().await.map_err(|_| "vector_unavailable")?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(|_| "vector_unavailable")?;
    let space = checked_snapshot(&mut transaction, source).await?;
    // No database transaction or pool slot spans a provider request.
    transaction
        .commit()
        .await
        .map_err(|_| "vector_unavailable")?;
    let (url, model, key) = embedding_request(&space)?;
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(4))
            .build()
            .expect("static HTTP settings")
    });
    let input = super::profile::prepare(source, &space, query, &CLIENT, &url, &key).await?;
    let mut body = serde_json::json!({"model":model,"input":[input]});
    if let Some(dim) = space
        .get("dim")
        .and_then(Value::as_u64)
        .filter(|dim| *dim > 0)
    {
        body["dimensions"] = dim.into();
    }
    let mut response = CLIENT
        .post(url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "embedding_unavailable")?;
    if !response.status().is_success() {
        return Err("embedding_unavailable");
    }
    if response.content_length().is_some_and(|n| n > 1024 * 1024) {
        return Err("embedding_invalid");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "embedding_unavailable")?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("embedding_invalid");
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: EmbeddingResponse =
        serde_json::from_slice(&bytes).map_err(|_| "embedding_invalid")?;
    if data.data.len() != 1 || data.data[0].index != 0 {
        return Err("embedding_invalid");
    }
    let vector = &data.data[0].embedding;
    if vector.len() != source.dimension
        || vector.iter().any(|v| !v.is_finite())
        || vector.iter().all(|v| *v == 0.0)
    {
        return Err("embedding_invalid");
    }
    let vector = serde_json::to_string(vector).map_err(|_| "embedding_invalid")?;
    let ids: Vec<String> = source.article_ids.iter().map(ToString::to_string).collect();
    let mut transaction = pool.begin().await.map_err(|_| "vector_unavailable")?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await
        .map_err(|_| "vector_unavailable")?;
    if checked_snapshot(&mut transaction, source).await? != space {
        return Err("snapshot_changed");
    }
    let rows = sqlx::query(concat!(
        "SELECT m.document_id, max(1-(e.embedding <=> $2::vector)) AS score ",
        "FROM rag.members m JOIN rag.embeddings e USING(collection,key,dimension) ",
        "JOIN rag.snapshots s ON s.collection=m.collection ",
        "WHERE m.collection=$1 AND m.dimension=$3 AND m.document_type='note' ",
        "AND m.document_id=ANY($4) AND s.fingerprint=$5 ",
        "GROUP BY m.document_id ORDER BY score DESC,m.document_id LIMIT 16"
    ))
    .bind(&source.collection)
    .bind(vector)
    .bind(source.dimension as i32)
    .bind(ids)
    .bind(&source.fingerprint)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|_| "vector_unavailable")?;
    transaction
        .commit()
        .await
        .map_err(|_| "vector_unavailable")?;
    rows.into_iter()
        .map(|row| {
            let id: String = row.try_get("document_id").map_err(|_| "snapshot_invalid")?;
            Ok((
                id.parse().map_err(|_| "snapshot_invalid")?,
                row.try_get("score").map_err(|_| "snapshot_invalid")?,
            ))
        })
        .collect()
}

async fn checked_snapshot(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: &Source,
) -> Result<Value, &'static str> {
    let snapshot = sqlx::query(concat!(
        "SELECT fingerprint, space::text, dimension, count, ",
        "(SELECT count(*) FROM rag.members m WHERE m.collection=s.collection) AS actual_count ",
        "FROM rag.snapshots s WHERE collection=$1"
    ))
    .bind(&source.collection)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| "vector_unavailable")?
    .ok_or("snapshot_missing")?;
    let fingerprint: String = snapshot
        .try_get("fingerprint")
        .map_err(|_| "snapshot_invalid")?;
    let dimension: i32 = snapshot
        .try_get("dimension")
        .map_err(|_| "snapshot_invalid")?;
    let count: i32 = snapshot.try_get("count").map_err(|_| "snapshot_invalid")?;
    let actual: i64 = snapshot
        .try_get("actual_count")
        .map_err(|_| "snapshot_invalid")?;
    if fingerprint != source.fingerprint
        || dimension as usize != source.dimension
        || count as i64 != actual
    {
        return Err("snapshot_changed");
    }
    let space: String = snapshot.try_get("space").map_err(|_| "snapshot_invalid")?;
    let space: Value = serde_json::from_str(&space).map_err(|_| "snapshot_invalid")?;
    Ok(space)
}
