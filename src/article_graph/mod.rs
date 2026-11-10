//! Optional graph artifacts derived from a published PostgreSQL vector snapshot.

mod profile;
mod vectors;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

#[derive(Clone, Deserialize)]
pub struct Word {
    pub word: String,
    pub articles: Vec<i32>,
}

#[derive(Deserialize)]
pub struct Source {
    pub version: String,
    pub collection: String,
    pub fingerprint: String,
    pub dimension: usize,
    pub article_ids: Vec<i32>,
    pub article_versions: HashMap<String, String>,
    pub words: Vec<Word>,
    #[serde(default)]
    pub embedding_profile: Option<profile::Contract>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub w: String,
    pub s: f64,
    pub document_ids: Vec<i32>,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub ok: bool,
    pub mode: &'static str,
    pub version: String,
    pub words: Vec<Hit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn artifact_dir() -> PathBuf {
    std::env::var("GRAPH_ARTIFACT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/article-graph"))
}

pub fn valid_version(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|c| c.is_ascii_hexdigit())
}

impl Source {
    pub fn valid(&self) -> bool {
        let ids: HashSet<_> = self.article_ids.iter().copied().collect();
        let mut words = HashSet::new();
        valid_version(&self.version)
            && !self.collection.is_empty()
            && self.collection.len() <= 128
            && self.fingerprint.len() == 64
            && self.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
            && (1..=16384).contains(&self.dimension)
            && !ids.is_empty()
            && ids.len() <= 2000
            && ids.len() == self.article_ids.len()
            && self.article_versions.len() == ids.len()
            && ids.iter().all(|id| {
                self.article_versions
                    .get(&id.to_string())
                    .is_some_and(|v| v.len() == 26)
            })
            && ids.iter().all(|id| *id > 0)
            && !self.words.is_empty()
            && self.words.len() <= 600
            && self.words.iter().all(|row| {
                !row.word.is_empty()
                    && row.word.chars().count() <= 100
                    && words.insert(row.word.to_lowercase())
                    && !row.articles.is_empty()
                    && row.articles.len() <= 2
                    && row.articles.iter().all(|id| ids.contains(id))
            })
    }
}

pub async fn load(version: &str) -> Result<Source, &'static str> {
    if !valid_version(version) {
        return Err("artifact_invalid");
    }
    let path = artifact_dir().join(format!("source-{version}.json"));
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "artifact_missing")?;
    if file.metadata().await.map_err(|_| "artifact_missing")?.len() > 512 * 1024 {
        return Err("artifact_invalid");
    }
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    file.take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "artifact_missing")?;
    let source: Source = serde_json::from_slice(&bytes).map_err(|_| "artifact_invalid")?;
    if source.version != version || !source.valid() {
        return Err("artifact_invalid");
    }
    Ok(source)
}

pub async fn visible(db: &DatabaseConnection, source: &Source) -> bool {
    use crate::{entity::note, routes::notes::public_condition};
    let rows: Result<Vec<(i32, chrono::NaiveDateTime)>, _> = note::Entity::find()
        .select_only()
        .columns([note::Column::Id, note::Column::UpdatedAt])
        .filter(note::Column::Id.is_in(source.article_ids.clone()))
        .filter(public_condition())
        .into_tuple()
        .all(db)
        .await;
    rows.is_ok_and(|rows| {
        rows.len() == source.article_ids.len()
            && rows.iter().all(|(id, stamp)| {
                source.article_versions.get(&id.to_string())
                    == Some(&stamp.format("%Y-%m-%dT%H:%M:%S%.6f").to_string())
            })
    })
}

pub fn lexical(source: &Source, query: &str) -> Vec<Hit> {
    let query = query.to_lowercase();
    let mut hits: Vec<_> = source
        .words
        .iter()
        .filter_map(|row| {
            let word = row.word.to_lowercase();
            (query.contains(&word) || word.contains(&query)).then(|| Hit {
                w: row.word.clone(),
                document_ids: row.articles.clone(),
                s: if word == query { 1.0 } else { 0.5 },
            })
        })
        .collect();
    hits.sort_by(|a, b| b.s.total_cmp(&a.s).then(a.w.cmp(&b.w)));
    hits.truncate(8);
    hits
}

pub fn map_documents(source: &Source, ranks: &[(i32, f64)]) -> Vec<Hit> {
    let scores: HashMap<_, _> = ranks.iter().copied().collect();
    let mut hits: Vec<_> = source
        .words
        .iter()
        .filter_map(|row| {
            row.articles
                .iter()
                .filter_map(|id| scores.get(id))
                .copied()
                .max_by(f64::total_cmp)
                .filter(|score| score.is_finite() && *score > 0.0)
                .map(|s| Hit {
                    w: row.word.clone(),
                    s,
                    document_ids: row
                        .articles
                        .iter()
                        .filter(|id| scores.contains_key(id))
                        .copied()
                        .collect(),
                })
        })
        .collect();
    hits.sort_by(|a, b| b.s.total_cmp(&a.s).then(a.w.cmp(&b.w)));
    hits.truncate(8);
    hits
}

pub async fn query(source: &Source, query: &str) -> QueryResult {
    match vectors::rank(source, query).await {
        Ok(ranks) => QueryResult {
            ok: true,
            mode: "document_vectors",
            version: source.version.clone(),
            words: map_documents(source, &ranks),
            reason: None,
        },
        Err(reason) => QueryResult {
            ok: true,
            mode: "lexical",
            version: source.version.clone(),
            words: lexical(source, query),
            reason: Some(reason.to_string()),
        },
    }
}

#[cfg(test)]
mod tests;
