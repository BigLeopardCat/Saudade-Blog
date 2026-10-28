//! Await committed chat records before reporting completion to the client.
//!
//! A started write survives cancellation of its HTTP waiter. The normal path
//! awaits that same task and observes failure; there is no automatic write retry.
//! Python's execution ledger remains authoritative for remote business effects.

use std::future::Future;

use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, Set, TransactionTrait,
};
use serde_json::Value;

use super::render_exec_row;
use crate::entity::{chat_history, execution_log, pending_action};

pub(super) const PERSISTENCE_ERROR: &str =
    "本轮回复或操作记录未能完整保存，请先刷新核对结果，避免重复操作。";

pub(super) async fn run<F>(trace_id: &str, write: F) -> Result<(), ()>
where
    F: Future<Output = Result<(), DbErr>> + Send + 'static,
{
    let trace_id = trace_id.to_owned();
    let write_trace = trace_id.clone();
    let task = tokio::spawn(async move {
        write.await.map_err(|error| {
            tracing::warn!(%error, trace_id = %write_trace, "chat persistence failed");
        })
    });
    task.await.map_err(|error| {
        tracing::error!(%error, %trace_id, "chat persistence task failed");
    })?
}

pub(super) async fn save_assistant_reply<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    source_role: Option<String>,
    reply: String,
) -> Result<(), DbErr> {
    chat_history::Entity::insert(chat_history::ActiveModel {
        user_id: Set(uid),
        conversation_id: Set(conversation_id),
        role: Set("assistant".into()),
        source_role: Set(source_role),
        content: Set(reply),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await?;

    Ok(())
}

pub(super) async fn save_execution_log<C: ConnectionTrait + TransactionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    rows: &[Value],
) -> Result<(), DbErr> {
    if rows.is_empty() {
        return Ok(());
    }
    let txn = db.begin().await?;
    for row in rows {
        execution_log::Entity::insert(execution_log::ActiveModel {
            user_id: Set(uid),
            conversation_id: Set(conversation_id),
            skill: Set(row["skill"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(32)
                .collect()),
            tool: Set(row["tool"].as_str().map(|s| s.chars().take(64).collect())),
            detail: Set(render_exec_row(row)),
            payload: Set(Some(row.to_string())),
            ..Default::default()
        })
        .exec_without_returning(&txn)
        .await?;
    }
    close_pending_actions(&txn, uid, conversation_id, rows).await?;
    txn.commit().await
}

async fn close_pending_actions<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    receipts: &[Value],
) -> Result<(), DbErr> {
    use sea_orm::ActiveModelTrait;

    let done: Vec<&str> = receipts
        .iter()
        .filter_map(|row| row["tool"].as_str())
        .collect();
    if done.is_empty() {
        return Ok(());
    }
    let pending = pending_action::Entity::find()
        .filter(pending_action::Column::UserId.eq(uid))
        .filter(pending_action::Column::ConversationId.eq(conversation_id))
        .filter(pending_action::Column::Status.eq("pending"))
        .all(db)
        .await?;
    for row in pending {
        if row
            .tool
            .split(',')
            .any(|tool| !tool.is_empty() && done.contains(&tool))
        {
            let mut model: pending_action::ActiveModel = row.into();
            model.status = Set("done".to_string());
            model.confirmation_status = Set("confirmed".to_string());
            model.updated_at = Set(chrono::Local::now().naive_local());
            model.update(db).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "persistence_tests.rs"]
mod tests;
