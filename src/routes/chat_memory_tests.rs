use super::*;
use sea_orm::{Database, DatabaseBackend, MockDatabase, MockExecResult, TransactionTrait};

fn message(id: i32, role: &str) -> chat_history::Model {
    chat_history::Model {
        id,
        user_id: 7,
        conversation_id: 42,
        role: role.into(),
        source_role: Some("user".into()),
        content: format!("message {id}"),
        created_at: chrono::Local::now().naive_local(),
    }
}

fn messages(start: i32, end: i32) -> Vec<chat_history::Model> {
    (start..=end)
        .map(|id| message(id, if id % 2 == 0 { "user" } else { "assistant" }))
        .collect()
}

fn stored(role: Option<&str>, through_id: i32) -> chat_summary::Model {
    chat_summary::Model {
        id: 1,
        user_id: 7,
        conversation_id: 42,
        summary: "existing private summary".into(),
        message_count: 20,
        lock_version: 0,
        covered_through_id: through_id,
        source_role: role.map(str::to_owned),
        updated_at: chrono::Local::now().naive_local(),
    }
}

fn exec(rows_affected: u64) -> MockExecResult {
    MockExecResult {
        last_insert_id: 0,
        rows_affected,
    }
}

fn update(base_id: i32, through_id: i32) -> SummaryUpdate {
    SummaryUpdate {
        text: "updated summary".into(),
        base_id,
        through_id,
    }
}

#[tokio::test]
async fn unknown_sources_are_not_relabelled_and_do_not_query_memory() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    for role in [None, Some(""), Some("unknown")] {
        let memory = load(&db, 7, 42, role, Some(90)).await.unwrap();
        assert!(memory.history.is_empty() && memory.summary.is_empty());
        assert!(memory.history_scope.is_none() && memory.summary_scope.is_none());
        assert!(memory.summary_batch.is_none() && memory.revision.is_none());
    }
    assert!(db.into_transaction_log().is_empty());
}

#[tokio::test]
async fn confirmations_read_scoped_context_without_scheduling_summaries() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![stored(Some("user"), 35)]])
        .append_query_results([messages(36, 55).into_iter().rev().collect::<Vec<_>>()])
        .into_connection();
    let memory = load(&db, 7, 42, Some("user"), None).await.unwrap();
    assert_eq!(memory.history.len(), 20);
    assert_eq!(memory.summary, "existing private summary");
    assert!(memory.summary_scope.is_some());
    assert!(!memory.needs_summary && memory.revision.is_none());
    assert_eq!(db.into_transaction_log().len(), 2);
}

#[tokio::test]
async fn backlog_uses_the_oldest_full_prefix_and_keeps_recent_context_separate() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<chat_summary::Model>::new()])
        .append_query_results([messages(16, 35).into_iter().rev().collect::<Vec<_>>()])
        .append_query_results([messages(1, 35)])
        .into_connection();
    let memory = load(&db, 7, 42, Some("user"), Some(36)).await.unwrap();
    assert!(memory.needs_summary);
    assert_eq!(memory.history.len(), 20);
    assert_eq!(memory.history[0].content, "message 16");
    let batch = memory.summary_batch.unwrap();
    assert_eq!(batch.base_id, 0);
    assert_eq!(batch.messages.len(), 35);
    assert_eq!(batch.messages.first().unwrap().id, 1);
    assert_eq!(batch.messages.last().unwrap().id, 35);
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("source_role") && log.contains("ORDER BY"));
    assert!(log.contains("LIMIT") && log.contains("Int(Some(36))"));
}

#[tokio::test]
async fn small_backlogs_never_advance_a_boundary() {
    for size in [9, 10, 19] {
        let prefix = messages(1, size);
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([Vec::<chat_summary::Model>::new()])
            .append_query_results([prefix.clone().into_iter().rev().collect::<Vec<_>>()])
            .append_query_results([prefix])
            .into_connection();
        let memory = load(&db, 7, 42, Some("user"), Some(size + 1))
            .await
            .unwrap();
        assert!(!memory.needs_summary);
        assert!(memory.summary_batch.is_none() && memory.revision.is_none());
    }
}

#[tokio::test]
async fn volume_triggers_before_the_message_ceiling_and_coverage_resets_it() {
    let mut prefix = messages(1, 4);
    for row in &mut prefix {
        row.content = "文".repeat(1_500);
    }
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<chat_summary::Model>::new()])
        .append_query_results([prefix.iter().rev().cloned().collect::<Vec<_>>()])
        .append_query_results([prefix])
        .into_connection();
    let first = load(&db, 7, 42, Some("user"), Some(5)).await.unwrap();
    assert!(first.needs_summary);
    let batch = first.summary_batch.unwrap();
    assert_eq!((batch.base_id, batch.messages.last().unwrap().id), (0, 4));
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![stored(Some("user"), 4)]])
        .append_query_results([messages(1, 10).into_iter().rev().collect::<Vec<_>>()])
        .append_query_results([messages(5, 10)])
        .into_connection();
    let next = load(&db, 7, 42, Some("user"), Some(11)).await.unwrap();
    assert!(!next.needs_summary && next.summary_batch.is_none());
    assert_eq!(next.history.len(), 10);
}

#[tokio::test]
async fn a_long_message_is_deferred_whole_then_offered_without_clipping() {
    let mut prefix = messages(1, 60);
    prefix[58].content = format!("{}TAIL_CANARY", "长".repeat(12_000));
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<chat_summary::Model>::new()])
        .append_query_results([prefix[40..].iter().rev().cloned().collect::<Vec<_>>()])
        .append_query_results([prefix.clone()])
        .into_connection();
    let memory = load(&db, 7, 42, Some("user"), Some(99)).await.unwrap();
    let batch = memory.summary_batch.unwrap();
    assert_eq!(batch.messages.len(), 58);
    assert_eq!(batch.messages.last().unwrap().id, 58);
    assert!(memory.history[18].content.ends_with("TAIL_CANARY"));
    let next_db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![stored(Some("user"), 58)]])
        .append_query_results([messages(59, 78).into_iter().rev().collect::<Vec<_>>()])
        .append_query_results([{
            let mut next = messages(59, 70);
            next[0] = prefix[58].clone();
            next
        }])
        .into_connection();
    let next = load(&next_db, 7, 42, Some("user"), Some(79)).await.unwrap();
    let next_batch = next.summary_batch.unwrap();
    assert_eq!(next_batch.base_id, 58);
    assert_eq!(next_batch.messages.len(), 1);
    assert_eq!(next_batch.messages[0].id, 59);
    assert!(next_batch.messages[0].content.ends_with("TAIL_CANARY"));
    assert_eq!(next_batch.messages[0].content.chars().count(), 12_011);
    assert!(next.needs_summary && next.revision.is_some());
}

#[tokio::test]
async fn a_short_complete_prefix_advances_coverage_and_keeps_the_tail_for_the_next_batch() {
    let mut prefix = messages(1, 35);
    for row in &mut prefix {
        row.content = "长".repeat(4_000);
    }
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<chat_summary::Model>::new()])
        .append_query_results([prefix[15..].iter().rev().cloned().collect::<Vec<_>>()])
        .append_query_results([prefix.clone()])
        .append_exec_results([exec(1)])
        .into_connection();
    let first = load(&db, 7, 42, Some("user"), Some(36)).await.unwrap();
    let batch = first.summary_batch.unwrap();
    assert_eq!(
        batch.messages.iter().map(|row| row.id).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert!(save(&db, 7, 42, &update(0, 3), &first.revision.unwrap())
        .await
        .unwrap());
    let next_db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![stored(Some("user"), 3)]])
        .append_query_results([prefix[15..].iter().rev().cloned().collect::<Vec<_>>()])
        .append_query_results([prefix[3..].to_vec()])
        .into_connection();
    let next = load(&next_db, 7, 42, Some("user"), Some(36)).await.unwrap();
    let next_batch = next.summary_batch.unwrap();
    assert_eq!(next_batch.base_id, 3);
    assert_eq!(
        next_batch
            .messages
            .iter()
            .map(|row| row.id)
            .collect::<Vec<_>>(),
        [4, 5, 6]
    );
    assert!(next_batch
        .messages
        .iter()
        .all(|row| row.content.chars().count() == 4_000));
}

#[tokio::test]
async fn interrupted_requests_still_allow_the_oldest_prefix_to_advance() {
    let mut prefix = messages(1, 60);
    for row in &mut prefix {
        row.role = "user".into();
    }
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<chat_summary::Model>::new()])
        .append_query_results([prefix[40..].iter().rev().cloned().collect::<Vec<_>>()])
        .append_query_results([prefix])
        .into_connection();
    let memory = load(&db, 7, 42, Some("user"), Some(61)).await.unwrap();
    let batch = memory.summary_batch.unwrap();
    assert_eq!(batch.messages.len(), 60);
    assert_eq!(batch.messages.last().unwrap().id, 60);
    assert!(memory.revision.is_some());
}

#[tokio::test]
async fn old_unknown_and_changed_role_summaries_do_not_supply_text_or_coverage() {
    for role in [None, Some("admin")] {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![stored(role, 500)]])
            .append_query_results([messages(1, 20).into_iter().rev().collect::<Vec<_>>()])
            .append_query_results([messages(1, 20)])
            .append_exec_results([exec(1)])
            .into_connection();
        let memory = load(&db, 7, 42, Some("user"), Some(21)).await.unwrap();
        assert!(memory.summary.is_empty() && memory.summary_scope.is_none());
        assert_eq!(memory.summary_batch.as_ref().unwrap().base_id, 0);
        assert!(save(&db, 7, 42, &update(0, 20), &memory.revision.unwrap())
            .await
            .unwrap());
        let log = format!("{:?}", db.into_transaction_log());
        assert!(
            log.contains("IS NOT DISTINCT FROM")
                && log.contains("covered_through_id=$8")
                && log.contains("summary=$9")
                && log.contains("lock_version=$10")
        );
        assert!(log.contains("Int(Some(500))"));
        assert!(log.contains("String(None)") || log.contains("admin"));
    }
}

#[tokio::test]
async fn matching_summary_advances_from_its_real_boundary_and_uses_compare_and_swap() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([vec![stored(Some("user"), 35)]])
        .append_query_results([messages(36, 55).into_iter().rev().collect::<Vec<_>>()])
        .append_query_results([messages(36, 55)])
        .append_exec_results([exec(0)])
        .into_connection();
    let memory = load(&db, 7, 42, Some("user"), Some(56)).await.unwrap();
    let revision = memory.revision.unwrap();
    assert_eq!(memory.summary_batch.unwrap().base_id, 35);
    assert!(!save(&db, 7, 42, &update(35, 55), &revision).await.unwrap());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("Int(Some(35))") && log.contains("Int(Some(40))"));
}

#[tokio::test]
async fn invalid_updates_and_cross_conversation_revisions_do_not_write() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    let revision = test_revision(7, 42, "user", 10, 25);
    for invalid in [
        update(0, 25),
        update(10, 24),
        SummaryUpdate {
            text: "  ".into(),
            ..update(10, 25)
        },
        SummaryUpdate {
            text: "长".repeat(8_001),
            ..update(10, 25)
        },
    ] {
        assert!(!save(&db, 7, 42, &invalid, &revision).await.unwrap());
    }
    assert!(!save(&db, 8, 42, &update(10, 25), &revision).await.unwrap());
    assert!(!save(&db, 7, 43, &update(10, 25), &revision).await.unwrap());
    assert!(db.into_transaction_log().is_empty());
}

#[tokio::test]
async fn a_first_summary_does_not_overwrite_a_concurrent_insert() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([exec(0)])
        .into_connection();
    let revision = test_revision(7, 42, "user", 0, 35);
    assert!(!save(&db, 7, 42, &update(0, 35), &revision).await.unwrap());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("ON CONFLICT (conversation_id) DO NOTHING"));
    assert!(!log.contains("DO UPDATE"));
}

#[tokio::test]
async fn retention_deletes_only_covered_records_from_the_matching_source() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([exec(4)])
        .into_connection();
    assert_eq!(prune(&db, 7, 42, 500).await.unwrap(), 4);
    let log = format!("{:?}", db.into_transaction_log());
    assert!(
        log.contains("s.source_role=h.source_role") && log.contains("h.id<=s.covered_through_id")
    );
    assert!(log.contains("s.source_role IS NOT NULL") && log.contains("GREATEST"));
}

#[test]
fn summary_updates_require_the_versioned_object_and_integer_boundaries() {
    for value in [
        r#""legacy summary""#,
        r#"{"text":"s","base_id":0}"#,
        r#"{"text":"s","base_id":0.5,"through_id":35}"#,
        r#"{"text":"s","base_id":0,"through_id":35,"extra":true}"#,
    ] {
        assert!(serde_json::from_str::<SummaryUpdate>(value).is_err());
    }
    assert_eq!(
        serde_json::from_str::<SummaryUpdate>(
            r#"{"text":"updated summary","base_id":0,"through_id":35}"#
        )
        .unwrap(),
        update(0, 35)
    );
}

#[tokio::test]
async fn postgres_scope_and_cas_survive_retention_without_deleting_uncovered_sources() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    // All synthetic rows live in one rollback-only transaction.
    let row = txn.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO conversation(user_id,title) VALUES(2147483647,'summary rollback probe') RETURNING id",
        [])).await.unwrap().unwrap();
    let cid: i32 = row.try_get("", "id").unwrap();
    let uid = i32::MAX;
    let mut ids = Vec::new();
    for index in 1..=36 {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO chat_history(user_id,conversation_id,role,content,source_role) \
             VALUES($1,$2,$3,'memory rollback probe','user') RETURNING id",
                vec![
                    uid.into(),
                    cid.into(),
                    (if index % 2 == 0 { "user" } else { "assistant" }).into(),
                ],
            ))
            .await
            .unwrap()
            .unwrap();
        ids.push(row.try_get::<i32>("", "id").unwrap());
    }
    let first = load(&txn, uid, cid, Some("user"), Some(ids[35]))
        .await
        .unwrap();
    assert_eq!(first.summary_batch.as_ref().unwrap().messages.len(), 35);
    let revision = first.revision.unwrap();
    let initial = update(0, ids[34]);
    assert!(save(&txn, uid, cid, &initial, &revision).await.unwrap());
    assert!(!save(&txn, uid, cid, &initial, &revision).await.unwrap());
    assert!(!save(&txn, uid, cid, &update(0, ids[35]), &revision)
        .await
        .unwrap());
    // A different source has no right to reuse either text or its boundary.
    let isolated = load(&txn, uid, cid, Some("admin"), Some(ids[35]))
        .await
        .unwrap();
    assert!(isolated.summary.is_empty() && isolated.history.is_empty());
    // Unproven legacy rows must survive even when retention is below the thread size.
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO chat_history(user_id,conversation_id,role,content) VALUES($1,$2,'assistant','unknown source')",
        vec![uid.into(), cid.into()])).await.unwrap();
    assert_eq!(prune(&txn, uid, cid, 2).await.unwrap(), 35);
    let remaining = chat_history::Entity::find()
        .filter(chat_history::Column::ConversationId.eq(cid))
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(remaining.len(), 2);
    assert!(remaining.iter().any(|row| row.source_role.is_none()));
    assert!(remaining.iter().any(|row| row.id == ids[35]));
    let reloaded = load(&txn, uid, cid, Some("user"), Some(ids[35]))
        .await
        .unwrap();
    assert_eq!(reloaded.summary, initial.text);
    assert!(!reloaded.needs_summary);
    let mut admin_ids = Vec::new();
    for index in 1..=21 {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO chat_history(user_id,conversation_id,role,content,source_role) \
             VALUES($1,$2,$3,'admin rollback probe','admin') RETURNING id",
                vec![
                    uid.into(),
                    cid.into(),
                    (if index % 2 == 0 { "assistant" } else { "user" }).into(),
                ],
            ))
            .await
            .unwrap()
            .unwrap();
        admin_ids.push(row.try_get::<i32>("", "id").unwrap());
    }
    let admin = load(&txn, uid, cid, Some("admin"), Some(admin_ids[20]))
        .await
        .unwrap();
    assert!(admin.summary.is_empty());
    let admin_revision = admin.revision.unwrap();
    assert_eq!(admin.summary_batch.unwrap().base_id, 0);
    // A concurrent source change invalidates the exact baseline that was read.
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE chat_summary SET source_role='superadmin' WHERE conversation_id=$1",
        vec![cid.into()],
    ))
    .await
    .unwrap();
    let admin_update = update(0, admin_ids[19]);
    assert!(!save(&txn, uid, cid, &admin_update, &admin_revision)
        .await
        .unwrap());
    let latest = load(&txn, uid, cid, Some("admin"), Some(admin_ids[20]))
        .await
        .unwrap();
    let latest_revision = latest.revision.unwrap();
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE chat_summary SET summary='concurrent same-boundary update' WHERE conversation_id=$1",
        vec![cid.into()])).await.unwrap();
    assert!(!save(&txn, uid, cid, &admin_update, &latest_revision)
        .await
        .unwrap());
    let latest_revision = load(&txn, uid, cid, Some("admin"), Some(admin_ids[20]))
        .await
        .unwrap()
        .revision
        .unwrap();
    assert!(save(&txn, uid, cid, &admin_update, &latest_revision)
        .await
        .unwrap());
    assert!(!save(&txn, uid, cid, &admin_update, &latest_revision)
        .await
        .unwrap());
    assert_eq!(prune(&txn, uid, cid, 1).await.unwrap(), 10);
    let remaining = chat_history::Entity::find()
        .filter(chat_history::Column::ConversationId.eq(cid))
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(remaining.len(), 3);
    assert!(remaining.iter().any(|row| row.source_role.is_none()));
    assert!(remaining.iter().any(|row| row.id == ids[35]));
    assert!(remaining.iter().any(|row| row.id == admin_ids[20]));
    txn.rollback().await.unwrap();
}

#[tokio::test]
async fn discard_deletes_and_fences_summary_writes_in_one_transaction() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([exec(2), exec(1)])
        .into_connection();
    discard(&db, 7, 42, 15).await.unwrap();
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("BEGIN") && log.contains("COMMIT"));
    assert!(log.contains("DELETE FROM") && log.contains("INSERT INTO chat_summary"));
    assert!(log.contains("covered_through_id >= $3"));
    assert!(log.contains("lock_version=chat_summary.lock_version+1"));
}

#[tokio::test]
async fn a_failed_summary_fence_rolls_back_history_deletion() {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_exec_results([exec(2)])
        .into_connection();
    assert!(discard(&db, 7, 42, 15).await.is_err());
    let log = format!("{:?}", db.into_transaction_log());
    assert!(log.contains("ROLLBACK") && !log.contains("COMMIT"));
}

#[tokio::test]
async fn invalid_discard_boundaries_do_not_delete_any_history() {
    let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
    for boundary in [0, -1] {
        assert!(discard(&db, 7, 42, boundary).await.is_err());
    }
    assert!(db.into_transaction_log().is_empty());
}

async fn insert_probe_messages<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    cid: i32,
    count: i32,
) -> Vec<i32> {
    let mut ids = Vec::new();
    for index in 0..count {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO chat_history(user_id,conversation_id,role,content,source_role) \
             VALUES($1,$2,$3,'discard rollback probe','user') RETURNING id",
                vec![
                    uid.into(),
                    cid.into(),
                    (if index % 2 == 0 { "user" } else { "assistant" }).into(),
                ],
            ))
            .await
            .unwrap()
            .unwrap();
        ids.push(row.try_get::<i32>("", "id").unwrap());
    }
    ids
}

async fn stored_probe<C: ConnectionTrait>(db: &C, cid: i32) -> chat_summary::Model {
    chat_summary::Entity::find()
        .filter(chat_summary::Column::ConversationId.eq(cid))
        .one(db)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn postgres_discard_fences_first_and_existing_summaries_and_invalidates_deleted_coverage() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let txn = db.begin().await.unwrap();
    // No synthetic rows outlive the outer rollback; discard uses a nested savepoint.
    let row = txn.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO conversation(user_id,title) VALUES(2147483647,'discard rollback probe') RETURNING id",
        [])).await.unwrap().unwrap();
    let cid: i32 = row.try_get("", "id").unwrap();
    let uid = i32::MAX;
    let ids = insert_probe_messages(&txn, uid, cid, 41).await;
    let initial = load(&txn, uid, cid, Some("user"), ids.last().copied())
        .await
        .unwrap();
    let initial_batch = initial.summary_batch.unwrap();
    let stale_first = update(
        initial_batch.base_id,
        initial_batch.messages.last().unwrap().id,
    );
    discard(&txn, uid, cid, ids[29]).await.unwrap();
    assert!(
        !save(&txn, uid, cid, &stale_first, &initial.revision.unwrap())
            .await
            .unwrap()
    );
    let empty = stored_probe(&txn, cid).await;
    assert!(empty.summary.is_empty() && empty.source_role.is_none());
    assert_eq!(empty.covered_through_id, 0);
    assert_eq!(empty.lock_version, 0);

    // A fresh request can summarize the surviving prefix using the new empty row.
    let fresh = load(&txn, uid, cid, Some("user"), Some(ids[28]))
        .await
        .unwrap();
    let first_update = update(0, ids[27]);
    assert!(
        save(&txn, uid, cid, &first_update, &fresh.revision.unwrap())
            .await
            .unwrap()
    );
    let before = stored_probe(&txn, cid).await;
    let appended = insert_probe_messages(&txn, uid, cid, 21).await;
    let inflight = load(&txn, uid, cid, Some("user"), appended.last().copied())
        .await
        .unwrap();
    let inflight_batch = inflight.summary_batch.unwrap();
    let inflight_update = update(
        inflight_batch.base_id,
        inflight_batch.messages.last().unwrap().id,
    );

    // Deleting an uncovered current turn preserves old text but still rejects
    // every revision read before the deletion, even if role/text/watermark match.
    discard(&txn, uid, cid, appended[10]).await.unwrap();
    let preserved = stored_probe(&txn, cid).await;
    assert_eq!(preserved.summary, before.summary);
    assert_eq!(preserved.source_role, before.source_role);
    assert_eq!(preserved.covered_through_id, before.covered_through_id);
    assert_eq!(preserved.message_count, before.message_count);
    assert_eq!(preserved.lock_version, before.lock_version + 1);
    assert!(!save(
        &txn,
        uid,
        cid,
        &inflight_update,
        &inflight.revision.unwrap()
    )
    .await
    .unwrap());

    let current = insert_probe_messages(&txn, uid, cid, 1).await;
    let reread = load(&txn, uid, cid, Some("user"), current.last().copied())
        .await
        .unwrap();
    assert!(
        save(&txn, uid, cid, &inflight_update, &reread.revision.unwrap())
            .await
            .unwrap()
    );
    let more = insert_probe_messages(&txn, uid, cid, 21).await;
    let inflight = load(&txn, uid, cid, Some("user"), more.last().copied())
        .await
        .unwrap();
    let batch = inflight.summary_batch.unwrap();
    let stale = update(batch.base_id, batch.messages.last().unwrap().id);
    let before = stored_probe(&txn, cid).await;

    // Once a deletion intersects covered messages, the entire derived summary
    // is invalidated rather than retaining text derived from removed content.
    discard(&txn, uid, cid, ids[19]).await.unwrap();
    let invalidated = stored_probe(&txn, cid).await;
    assert!(invalidated.summary.is_empty() && invalidated.source_role.is_none());
    assert_eq!(invalidated.covered_through_id, 0);
    assert_eq!(invalidated.message_count, 0);
    assert_eq!(invalidated.lock_version, before.lock_version + 1);
    assert!(!save(&txn, uid, cid, &stale, &inflight.revision.unwrap())
        .await
        .unwrap());
    let remaining = chat_history::Entity::find()
        .filter(chat_history::Column::ConversationId.eq(cid))
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(remaining.len(), 19);
    assert!(remaining.iter().all(|row| row.id < ids[19]));
    let current = insert_probe_messages(&txn, uid, cid, 1).await;
    let rebuilt = load(&txn, uid, cid, Some("user"), current.last().copied())
        .await
        .unwrap();
    assert!(save(
        &txn,
        uid,
        cid,
        &update(0, ids[18]),
        &rebuilt.revision.unwrap()
    )
    .await
    .unwrap());
    txn.rollback().await.unwrap();
}
