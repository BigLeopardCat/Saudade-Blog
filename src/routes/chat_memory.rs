//! Host history and summary coverage retain the identity recorded at write time.

use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};

use crate::entity::{chat_history, chat_summary};

const HISTORY_MESSAGES: u64 = 20;
const SUMMARY_MESSAGES: u64 = 60;
const SUMMARY_BATCH_CHARS: usize = 12_000;
const SUMMARY_TRIGGER_MESSAGES: usize = HISTORY_MESSAGES as usize;
const SUMMARY_TRIGGER_CHARS: usize = 6_000;
const MAX_SUMMARY_CHARS: usize = 8_000;

#[derive(Clone, Debug, Serialize)]
pub(super) struct MemoryScope {
    pub user_id: i32,
    pub role: String,
    pub conversation_id: i32,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct HistoryMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct SummaryMessage {
    pub id: i32,
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct SummaryBatch {
    pub base_id: i32,
    pub messages: Vec<SummaryMessage>,
}

/// A request-local capability for exactly the prefix supplied to the summarizer.
#[derive(Clone, Debug)]
pub(super) struct Revision {
    user_id: i32,
    conversation_id: i32,
    source_role: String,
    base_id: i32,
    through_id: i32,
    message_count: i32,
    expected: Option<ExpectedSummary>,
}

#[derive(Clone, Debug)]
struct ExpectedSummary {
    source_role: Option<String>,
    through_id: i32,
    text: String,
    lock_version: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct SummaryUpdate {
    pub text: String,
    pub base_id: i32,
    pub through_id: i32,
}

#[derive(Default, Serialize)]
pub(super) struct MemoryContext {
    pub history: Vec<HistoryMessage>,
    pub summary: String,
    pub history_scope: Option<MemoryScope>,
    pub summary_scope: Option<MemoryScope>,
    pub summary_batch: Option<SummaryBatch>,
    pub needs_summary: bool,
    #[serde(skip)]
    pub revision: Option<Revision>,
}

pub(super) async fn load<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    source_role: Option<&str>,
    current_id: Option<i32>,
) -> Result<MemoryContext, DbErr> {
    let Some(role) = source_role.filter(|role| crate::authz::is_known_role(role)) else {
        return Ok(MemoryContext::default());
    };
    let scope = MemoryScope {
        user_id: uid,
        role: role.into(),
        conversation_id,
    };
    let stored = chat_summary::Entity::find()
        .filter(chat_summary::Column::UserId.eq(uid))
        .filter(chat_summary::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?;
    let matching = stored.as_ref().filter(|row| {
        row.source_role.as_deref() == Some(role)
            && row.covered_through_id > 0
            && !row.summary.trim().is_empty()
    });
    let base_id = matching.map_or(0, |row| row.covered_through_id);
    let mut history_query = source_messages(uid, conversation_id, role);
    if let Some(id) = current_id {
        history_query = history_query.filter(chat_history::Column::Id.lt(id));
    }
    let mut recent = history_query
        .order_by_desc(chat_history::Column::Id)
        .limit(HISTORY_MESSAGES)
        .all(db)
        .await?;
    recent.reverse();
    let mut context = MemoryContext {
        history: recent
            .iter()
            .map(|row| HistoryMessage {
                role: row.role.clone(),
                content: row.content.clone(),
            })
            .collect(),
        summary: matching.map_or_else(String::new, |row| row.summary.clone()),
        history_scope: Some(scope.clone()),
        summary_scope: matching.map(|_| scope),
        ..Default::default()
    };
    let Some(current_id) = current_id else {
        return Ok(context);
    };
    let mut prefix = source_messages(uid, conversation_id, role)
        .filter(chat_history::Column::Id.gt(base_id))
        .filter(chat_history::Column::Id.lt(current_id))
        .order_by_asc(chat_history::Column::Id)
        .limit(SUMMARY_MESSAGES)
        .all(db)
        .await?;
    // Compact by volume, with a message ceiling aligned to the recovery window.
    // Advancing the saved boundary resets both counters, so brief exchanges do
    // not rewrite the summary every few turns. Interrupted messages still count.
    let pending_chars = prefix
        .iter()
        .map(|row| row.content.chars().count())
        .sum::<usize>();
    if prefix.is_empty()
        || (prefix.len() < SUMMARY_TRIGGER_MESSAGES && pending_chars < SUMMARY_TRIGGER_CHARS)
    {
        return Ok(context);
    }
    // Bound host batch size without estimating tokens or clipping a message.
    // The first oversized record is still offered whole to the Agent budget.
    let mut chars = 0usize;
    let mut count = 0;
    for row in &prefix {
        let next = chars.saturating_add(row.content.chars().count());
        if count > 0 && next > SUMMARY_BATCH_CHARS {
            break;
        }
        chars = next;
        count += 1;
    }
    prefix.truncate(count);
    let through_id = prefix.last().expect("nonempty summary prefix").id;
    context.revision = Some(Revision {
        user_id: uid,
        conversation_id,
        source_role: role.into(),
        base_id,
        through_id,
        message_count: matching
            .map_or(0, |row| row.message_count)
            .saturating_add(prefix.len() as i32),
        expected: stored.as_ref().map(|row| ExpectedSummary {
            source_role: row.source_role.clone(),
            through_id: row.covered_through_id,
            text: row.summary.clone(),
            lock_version: row.lock_version,
        }),
    });
    context.summary_batch = Some(SummaryBatch {
        base_id,
        messages: prefix
            .into_iter()
            .map(|row| SummaryMessage {
                id: row.id,
                role: row.role,
                content: row.content,
            })
            .collect(),
    });
    tracing::debug!(
        conversation_id,
        base_id,
        through_id,
        messages = count,
        pending_chars,
        "conversation summary scheduled"
    );
    context.needs_summary = true;
    Ok(context)
}

fn source_messages(
    uid: i32,
    conversation_id: i32,
    role: &str,
) -> sea_orm::Select<chat_history::Entity> {
    chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conversation_id))
        .filter(chat_history::Column::SourceRole.eq(role))
        .filter(chat_history::Column::Role.is_in(["user", "assistant"]))
}

pub(super) async fn save<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    update: &SummaryUpdate,
    revision: &Revision,
) -> Result<bool, DbErr> {
    if revision.user_id != uid
        || revision.conversation_id != conversation_id
        || update.base_id != revision.base_id
        || update.through_id != revision.through_id
        || update.text.trim().is_empty()
        || update.text.chars().count() > MAX_SUMMARY_CHARS
    {
        return Ok(false);
    }
    let values = vec![
        uid.into(),
        conversation_id.into(),
        update.text.trim().into(),
        revision.message_count.into(),
        revision.through_id.into(),
        revision.source_role.clone().into(),
    ];
    let statement = match &revision.expected {
        None => Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO chat_summary \
             (user_id,conversation_id,summary,message_count,covered_through_id,source_role) \
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (conversation_id) DO NOTHING",
            values,
        ),
        Some(expected) => {
            let mut values = values;
            values.extend([
                expected.source_role.clone().into(),
                expected.through_id.into(),
                expected.text.clone().into(),
                expected.lock_version.into(),
            ]);
            Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE chat_summary SET summary=$3,message_count=$4,covered_through_id=$5, \
                 source_role=$6,updated_at=localtimestamp,lock_version=lock_version+1 \
                 WHERE user_id=$1 AND conversation_id=$2 \
                 AND source_role IS NOT DISTINCT FROM $7 AND covered_through_id=$8 \
                 AND summary=$9 AND lock_version=$10",
                values,
            )
        }
    };
    Ok(db.execute(statement).await?.rows_affected() == 1)
}

/// Delete a turn and invalidate in-flight summaries in the same short transaction.
pub(super) async fn discard<C: ConnectionTrait + TransactionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    from_id: i32,
) -> Result<(), DbErr> {
    if from_id <= 0 {
        return Err(DbErr::Custom("invalid discard boundary".into()));
    }
    let txn = db.begin().await?;
    chat_history::Entity::delete_many()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conversation_id))
        .filter(chat_history::Column::Id.gte(from_id))
        .exec(&txn)
        .await?;
    // The empty row also fences first-time summaries whose old snapshot had no row.
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO chat_summary \
         (user_id,conversation_id,summary,message_count,covered_through_id,source_role) \
         VALUES ($1,$2,'',0,0,NULL) ON CONFLICT (conversation_id) DO UPDATE SET \
         summary=CASE WHEN chat_summary.covered_through_id >= $3 THEN '' ELSE chat_summary.summary END, \
         message_count=CASE WHEN chat_summary.covered_through_id >= $3 THEN 0 ELSE chat_summary.message_count END, \
         source_role=CASE WHEN chat_summary.covered_through_id >= $3 THEN NULL ELSE chat_summary.source_role END, \
         covered_through_id=CASE WHEN chat_summary.covered_through_id >= $3 THEN 0 ELSE chat_summary.covered_through_id END, \
         updated_at=localtimestamp,lock_version=chat_summary.lock_version+1 \
         WHERE chat_summary.user_id=EXCLUDED.user_id",
        vec![uid.into(), conversation_id.into(), from_id.into()],
    )).await?;
    txn.commit().await
}

/// Never delete raw history that has not been summarized under its own source.
pub(super) async fn prune<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    history_limit: i64,
) -> Result<u64, DbErr> {
    let result = db
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "WITH removable AS (SELECT h.id FROM chat_history h JOIN chat_summary s \
         ON s.user_id=h.user_id AND s.conversation_id=h.conversation_id \
         AND s.source_role=h.source_role WHERE h.user_id=$1 AND h.conversation_id=$2 \
         AND s.source_role IS NOT NULL AND btrim(s.summary)<>'' \
         AND h.id<=s.covered_through_id ORDER BY h.id LIMIT GREATEST( \
         (SELECT count(*) FROM chat_history WHERE user_id=$1 AND conversation_id=$2)-$3,0)) \
         DELETE FROM chat_history WHERE id IN (SELECT id FROM removable)",
            vec![
                uid.into(),
                conversation_id.into(),
                history_limit.max(1).into(),
            ],
        ))
        .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
#[path = "chat_memory_tests.rs"]
mod tests;

#[cfg(test)]
pub(super) fn test_revision(
    uid: i32,
    cid: i32,
    role: &str,
    base_id: i32,
    through_id: i32,
) -> Revision {
    Revision {
        user_id: uid,
        conversation_id: cid,
        source_role: role.into(),
        base_id,
        through_id,
        message_count: through_id.saturating_sub(base_id),
        expected: None,
    }
}
