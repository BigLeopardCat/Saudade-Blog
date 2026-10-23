//! Rolling summaries use a monotonic message boundary, independent of retention.

use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    Statement,
};

use crate::entity::{chat_history, chat_summary};

#[derive(Clone, Copy)]
pub(super) struct Revision {
    pub message_count: i64,
    /// No user message is inserted for confirmation requests.
    pub through_id: Option<i32>,
}

pub(super) async fn due<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    revision: Revision,
    stored: Option<&chat_summary::Model>,
) -> Result<bool, DbErr> {
    let Some(current_id) = revision.through_id else {
        return Ok(false);
    };
    if revision.message_count <= 20 {
        return Ok(false);
    }
    let covered = stored.map(|s| s.covered_through_id).unwrap_or(0);
    if covered == 0 {
        return Ok(true);
    }
    let uncovered = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conversation_id))
        .filter(chat_history::Column::Id.gt(covered))
        .filter(chat_history::Column::Id.lte(current_id))
        .count(db)
        .await?;
    Ok(uncovered >= 10)
}

pub(super) async fn save<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    summary: &str,
    revision: Revision,
) -> Result<(), DbErr> {
    let Some(through_id) = revision.through_id else {
        return Ok(());
    };
    if summary.trim().is_empty() {
        return Ok(());
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO chat_summary \
         (user_id, conversation_id, summary, message_count, covered_through_id) \
         VALUES ($1,$2,$3,$4,$5) \
         ON CONFLICT (conversation_id) DO UPDATE SET \
         summary=EXCLUDED.summary, message_count=EXCLUDED.message_count, \
         covered_through_id=EXCLUDED.covered_through_id, updated_at=localtimestamp \
         WHERE chat_summary.user_id=EXCLUDED.user_id \
         AND chat_summary.covered_through_id < EXCLUDED.covered_through_id",
        vec![
            uid.into(),
            conversation_id.into(),
            summary.into(),
            (revision.message_count as i32).into(),
            through_id.into(),
        ],
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "chat_memory_tests.rs"]
mod tests;
