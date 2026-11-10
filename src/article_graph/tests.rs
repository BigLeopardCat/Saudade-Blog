use super::*;

fn source() -> Source {
    Source {
        version: "1234abcd".into(),
        collection: "blog-public".into(),
        fingerprint: "a".repeat(64),
        dimension: 3,
        article_ids: vec![1, 2],
        article_versions: HashMap::from([
            ("1".into(), "2026-11-10T00:00:00.000000".into()),
            ("2".into(), "2026-11-10T00:00:00.000000".into()),
        ]),
        embedding_profile: None,
        words: vec![
            Word {
                word: "Rust".into(),
                articles: vec![1],
            },
            Word {
                word: "并发".into(),
                articles: vec![2],
            },
        ],
    }
}

#[test]
fn source_requires_real_public_membership_and_unique_words() {
    let mut source = source();
    assert!(source.valid());
    source.words[0].articles = vec![9];
    assert!(!source.valid());
    source.words[0].articles = vec![1];
    source.words[1].word = "rUsT".into();
    assert!(!source.valid());
}

#[test]
fn semantic_results_are_mapped_only_to_their_source_articles() {
    let hits = map_documents(&source(), &[(2, 0.9), (999, 1.0)]);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].w, "并发");
    assert_eq!(hits[0].s, 0.9);
}

#[test]
fn lexical_fallback_supports_english_and_chinese_without_an_embedding_provider() {
    assert_eq!(lexical(&source(), "RUST")[0].w, "Rust");
    assert_eq!(lexical(&source(), "并发")[0].w, "并发");
    assert!(lexical(&source(), "unrelated").is_empty());
}

#[tokio::test]
async fn missing_artifact_is_a_normal_optional_state() {
    assert!(load("invalid/../../source").await.is_err());
    assert!(load("000000000000000000000000").await.is_err());
}

#[tokio::test]
async fn serving_requires_current_public_article_versions() {
    use sea_orm::{DatabaseBackend, MockDatabase, Value};
    use std::collections::BTreeMap;
    let stamp = chrono::NaiveDate::from_ymd_opt(2026, 11, 10)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    for (rows, expected) in [
        (vec![(1, stamp), (2, stamp)], true),
        (vec![(1, stamp)], false),
        (
            vec![(1, stamp), (2, stamp + chrono::Duration::seconds(1))],
            false,
        ),
    ] {
        let values: Vec<BTreeMap<String, Value>> = rows
            .into_iter()
            .map(|(id, time)| {
                BTreeMap::from([("id".into(), id.into()), ("updated_at".into(), time.into())])
            })
            .collect();
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([values])
            .into_connection();
        assert_eq!(visible(&db, &source()).await, expected);
    }
}
