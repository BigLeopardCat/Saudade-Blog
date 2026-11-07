use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase};

fn query(keywords: &[&str]) -> SearchQuery {
    SearchQuery {
        keywords: keywords.iter().map(|value| value.to_string()).collect(),
        page: None,
        page_size: Some(5),
    }
}

#[test]
fn keyword_bounds_and_normalization_are_explicit() {
    for keywords in [
        vec![],
        vec![""],
        vec![" "],
        vec!["x\0"],
        vec!["\nx"],
        vec!["x"; 9],
    ] {
        assert!(query(&keywords).normalized_keywords().is_err());
    }
    assert!(query(&[&"文".repeat(129)]).normalized_keywords().is_err());
    assert_eq!(
        query(&[&"文".repeat(128)])
            .normalized_keywords()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        query(&[" OTA ", "ota", "升级", "UPGRADE", "upgrade"])
            .normalized_keywords()
            .unwrap(),
        ["OTA", "升级", "UPGRADE"]
    );
    assert_eq!(
        query(&["a", "b", "c", "d", "e", "f", "g", "h"])
            .normalized_keywords()
            .unwrap()
            .len(),
        8
    );
    assert!(SearchQuery {
        page_size: Some(11),
        ..query(&["x"])
    }
    .window()
    .is_err());
    assert_eq!(
        SearchQuery {
            page: Some(2),
            page_size: Some(3),
            ..query(&["OTA"])
        }
        .window()
        .unwrap(),
        (3, 3)
    );
}

#[test]
fn json_contract_rejects_old_scalar_and_untrusted_types() {
    for payload in [
        json!({"keyword": "OTA"}),
        json!({"keywords": "OTA"}),
        json!({"keywords": [true]}),
        json!({"keywords": [1]}),
        json!({"keywords": ["OTA"], "page": true}),
        json!({"keywords": ["OTA"], "page_size": -1}),
        json!({"keywords": ["OTA"], "admin": true}),
    ] {
        assert!(serde_json::from_value::<SearchQuery>(payload).is_err());
    }
}

#[tokio::test]
async fn database_failure_or_missing_totals_are_not_an_empty_search() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    assert!(read(&db, &["OTA".into()], 3, 0).await.is_err());
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<std::collections::BTreeMap<String, sea_orm::Value>>::new()])
        .into_connection();
    assert!(read(&db, &["OTA".into()], 3, 0).await.is_err());
}

#[tokio::test]
async fn multiple_keywords_use_one_parameterized_database_statement() {
    use std::collections::BTreeMap;
    let keywords = vec!["100%_x\\p_'".to_string(), "升级".to_string()];
    let summary = BTreeMap::<String, sea_orm::Value>::from([
        ("announcements".into(), 0i64.into()),
        ("board".into(), 0i64.into()),
        ("talk".into(), 0i64.into()),
        ("id".into(), Option::<i32>::None.into()),
        (
            "keyword_counts".into(),
            json!([
                {"keyword": keywords[0], "total": 0,
                 "counts": {"announcements": 0, "board": 0, "talk": 0}},
                {"keyword": keywords[1], "total": 0,
                 "counts": {"announcements": 0, "board": 0, "talk": 0}}
            ])
            .into(),
        ),
    ]);
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([[summary]])
        .into_connection();
    let result = read(&db, &keywords, 5, 0).await.unwrap();
    assert_eq!(result.total, 0);
    assert_eq!(result.keyword_counts.len(), 2);
    assert_eq!(result.keywords, keywords);
    assert!(result.items.is_empty() && !result.has_more);
    let log = db.into_transaction_log();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].statements().len(), 1);
    let statement = &log[0].statements()[0];
    assert!(!statement.sql.contains(&keywords[0]));
    assert_eq!(statement.values.as_ref().unwrap().0.len(), 3);
}

#[tokio::test]
async fn postgres_batch_search_keeps_union_counts_pages_and_visibility() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("SKIP public activity batch search: TEST_PG_URL is not set");
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let marker = format!("activity_{}_100%_x\\p_'", uuid::Uuid::new_v4().simple());
    let user = tx.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO \"user\" (username,password,role) VALUES ($1,'fixture','user') RETURNING id",
        [uuid::Uuid::new_v4().simple().to_string().into()])).await.unwrap().unwrap();
    let uid: i32 = user.try_get("", "id").unwrap();
    for source in ["board", "talk"] {
        for approved in [0i16, 1, 2] {
            tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
                "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,reject_reason,created_at,updated_at) \
                 VALUES ($1,$2,'愿',0,'public name',$3,$4,$5,'private reason',localtimestamp,localtimestamp)",
                [marker.clone().into(), format!("{}{} end", "前".repeat(600), marker).into(), uid.into(), source.into(), approved.into()])).await.unwrap();
        }
    }
    // A board's free-form signature and unused title are not searchable content.
    tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,reject_reason,created_at,updated_at) \
         VALUES ($1,'unrelated body','愿',0,$1,$2,'board',1,'',localtimestamp,localtimestamp)",
        [marker.clone().into(), uid.into()])).await.unwrap();
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO announcement(title,content) VALUES ('fixture',$1)",
        [format!("{}{}", "前".repeat(600), marker).into()],
    ))
    .await
    .unwrap();
    let decoy = marker.replace('%', "Z").replace('_', "Q").replace('\\', "");
    tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO talk(title,content,cat,v,author,user_id,src,approved,reject_reason,created_at,updated_at) \
         VALUES ('decoy',$1,'愿',0,'public name',$2,'talk',1,'',localtimestamp,localtimestamp)",
        [decoy.into(), uid.into()])).await.unwrap();
    let keywords = vec![
        marker.to_uppercase(),
        "100%_x\\p_'".to_string(),
        marker.clone() + "absent",
    ];
    let first = read(&tx, &keywords, 2, 0).await.unwrap();
    assert_eq!(
        (
            first.total,
            first.counts.announcements,
            first.counts.board,
            first.counts.talk
        ),
        (3, 1, 1, 1)
    );
    assert_eq!(
        first
            .keyword_counts
            .iter()
            .map(|row| row.total)
            .collect::<Vec<_>>(),
        [3, 3, 0]
    );
    assert_eq!(first.keyword_counts[0].counts.board, 1);
    assert!(first.has_more);
    let second = read(&tx, &keywords, 2, 2).await.unwrap();
    assert_eq!(second.total, 3);
    assert!(!second.has_more);
    let identities: HashSet<_> = first
        .items
        .iter()
        .chain(second.items.iter())
        .map(|row| (row["source"].as_str().unwrap(), row["id"].as_i64().unwrap()))
        .collect();
    assert_eq!(identities.len(), 3);
    for item in first.items.iter().chain(second.items.iter()) {
        assert!(item["content"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains(&marker));
        assert!(item["content"].as_str().unwrap().chars().count() <= 240);
        assert_eq!(item["contentTruncated"], true);
        assert_eq!(item["matchedKeywords"], json!(&keywords[..2]));
        assert!(
            !item.to_string().contains("userId") && !item.to_string().contains("private reason")
        );
    }
    let past = read(&tx, &keywords, 2, 4).await.unwrap();
    assert_eq!(past.total, 3);
    assert!(past.items.is_empty() && !past.has_more);
    let empty = read(&tx, &[marker.clone() + "absent"], 2, 0).await.unwrap();
    assert_eq!(empty.total, 0);
    assert_eq!(empty.keyword_counts[0].total, 0);
    assert!(empty.items.is_empty());
    let other = format!("separate_{}", uuid::Uuid::new_v4().simple());
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO announcement(title,content) VALUES ('fixture',$1)",
        [other.clone().into()],
    ))
    .await
    .unwrap();
    let disjoint = read(&tx, &[keywords[0].clone(), other], 10, 0)
        .await
        .unwrap();
    assert_eq!(disjoint.total, 4);
    assert_eq!(
        disjoint
            .keyword_counts
            .iter()
            .map(|row| row.total)
            .collect::<Vec<_>>(),
        [3, 1]
    );
    tx.rollback().await.unwrap();
}
