//! Scoped bootstrap history for the Agent; live memory belongs to its checkpoint.

use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::Serialize;

use crate::entity::{chat_history, chat_summary};

const HISTORY_MESSAGES: u64 = 20;

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

#[derive(Default, Serialize)]
pub(super) struct BootstrapContext {
    pub history: Vec<HistoryMessage>,
    pub summary: String,
    pub history_scope: Option<MemoryScope>,
    pub summary_scope: Option<MemoryScope>,
}

pub(super) async fn load_bootstrap<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    source_role: Option<&str>,
    current_id: Option<i32>,
) -> Result<BootstrapContext, DbErr> {
    let Some(role) = source_role.filter(|role| crate::authz::is_known_role(role)) else {
        return Ok(BootstrapContext::default());
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
    let context = BootstrapContext {
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

/// Delete a turn and invalidate any archived summary containing that range.
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
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE chat_summary SET summary='',message_count=0,covered_through_id=0, \
         source_role=NULL,updated_at=localtimestamp,lock_version=lock_version+1 \
         WHERE user_id=$1 AND conversation_id=$2 AND covered_through_id >= $3",
        vec![uid.into(), conversation_id.into(), from_id.into()],
    )).await?;
    txn.commit().await
}

#[cfg(test)]
#[path = "chat_context_tests.rs"]
mod tests;
