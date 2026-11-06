//! Stable turn discard and checkpoint delivery share the host's conversation boundary.

use super::*;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, TransactionTrait};

#[derive(Deserialize)]
pub struct DiscardReq {
    conversation_id: i32,
    task_id: String,
}

#[derive(Debug, PartialEq)]
enum Discarded {
    Queued,
    NotLast,
    MissingConversation,
}

async fn discard<C: ConnectionTrait + TransactionTrait>(
    db: &C,
    uid: i32,
    cid: i32,
    task_id: &str,
) -> Result<Discarded, DbErr> {
    let txn = db.begin().await?;
    if conversation::Entity::find_by_id(cid)
        .filter(conversation::Column::UserId.eq(uid))
        .lock(sea_orm::sea_query::LockType::Update)
        .one(&txn)
        .await?
        .is_none()
    {
        txn.rollback().await?;
        return Ok(Discarded::MissingConversation);
    }
    if crate::checkpoint_cleanup::turn_discarded(&txn, cid, task_id).await?
        || crate::checkpoint_cleanup::has_pending_turn(&txn, cid).await?
    {
        txn.commit().await?;
        return Ok(Discarded::Queued);
    }
    let target = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(cid))
        .filter(chat_history::Column::Role.eq("user"))
        .filter(chat_history::Column::TaskId.eq(task_id))
        .one(&txn)
        .await?;
    if let Some(target) = target {
        let last_root = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::ConversationId.eq(cid))
            .filter(chat_history::Column::Role.eq("user"))
            .filter(chat_history::Column::TaskId.is_not_null())
            .order_by_desc(chat_history::Column::Id)
            .one(&txn)
            .await?;
        if last_root.as_ref().map(|message| message.id) != Some(target.id) {
            txn.rollback().await?;
            return Ok(Discarded::NotLast);
        }
        chat_context::discard(&txn, uid, cid, target.id, task_id).await?;
    } else {
        let last = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::ConversationId.eq(cid))
            .filter(chat_history::Column::Role.eq("user"))
            .order_by_desc(chat_history::Column::Id)
            .one(&txn)
            .await?;
        if last.is_some_and(|message| message.task_id.is_none()) {
            txn.rollback().await?;
            return Ok(Discarded::NotLast);
        }
    }
    // Even an absent target needs a fence: its original HTTP request may arrive later.
    crate::checkpoint_cleanup::enqueue_turn(&txn, cid, uid, task_id).await?;
    txn.commit().await?;
    Ok(Discarded::Queued)
}

fn response(status: StatusCode, reason: &str, success: bool) -> Response {
    (
        status,
        Json(serde_json::json!({"success":success,"reason":reason})),
    )
        .into_response()
}

pub async fn discard_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<DiscardReq>,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(_) => return response(StatusCode::UNAUTHORIZED, "unauthorized", false),
    };
    if req.conversation_id <= 0
        || req.task_id.is_empty()
        || req.task_id.len() > 100
        || !req
            .task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return response(StatusCode::BAD_REQUEST, "invalid_target", false);
    }
    match discard(&state.db, uid, req.conversation_id, &req.task_id).await {
        Ok(Discarded::NotLast) => return response(StatusCode::CONFLICT, "not_last_turn", false),
        Ok(Discarded::MissingConversation) => {
            return response(StatusCode::NOT_FOUND, "conversation_not_found", false)
        }
        Err(error) => {
            warn!(%error,conversation_id=req.conversation_id,"turn discard was not committed");
            return response(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_unavailable",
                false,
            );
        }
        Ok(Discarded::Queued) => {}
    }
    dispatch(&state.db, req.conversation_id, &req.task_id).await
}

async fn dispatch(db: &DatabaseConnection, cid: i32, task_id: &str) -> Response {
    crate::checkpoint_cleanup::dispatch_turn(db, cid, task_id).await;
    match crate::checkpoint_cleanup::has_pending_turn(db, cid).await {
        Ok(false) => response(StatusCode::OK, "discarded", true),
        Ok(true) => response(StatusCode::ACCEPTED, "cleanup_pending", false),
        Err(_) => response(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_unavailable",
            false,
        ),
    }
}

#[cfg(test)]
#[path = "discard_tests.rs"]
mod tests;
