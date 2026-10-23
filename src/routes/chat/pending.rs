//! Persistence of confirmation proposals and explicit cancellation events.

use super::{json_capped, PENDING_ARGS_COL_MAX, PENDING_OPTIONS_COL_MAX, PENDING_QUESTION_COL_MAX};
use crate::entity::pending_action;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};

pub(super) async fn cancel(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    cid: i32,
    value: &serde_json::Value,
) -> bool {
    let Some((task_id, jti)) = cancellation(value) else {
        return false;
    };
    if let Err(error) = pending_action::Entity::update_many()
        .col_expr(pending_action::Column::Status, Expr::value("cancelled"))
        .col_expr(
            pending_action::Column::ConfirmationStatus,
            Expr::value("cancelled"),
        )
        .col_expr(
            pending_action::Column::UpdatedAt,
            Expr::value(chrono::Local::now().naive_local()),
        )
        .filter(pending_action::Column::ConversationId.eq(cid))
        .filter(pending_action::Column::UserId.eq(uid))
        .filter(pending_action::Column::TaskId.eq(task_id))
        .filter(pending_action::Column::Jti.eq(jti))
        .filter(pending_action::Column::Status.eq("pending"))
        .exec(db)
        .await
    {
        tracing::warn!(error = %error, "failed to persist pending cancellation");
        return false;
    }
    true
}

fn cancellation(value: &serde_json::Value) -> Option<(&str, &str)> {
    if value["event"] != "cancelled" {
        return None;
    }
    let task_id = value["task_id"].as_str()?;
    let jti = value["jti"].as_str()?;
    if jti.len() != 32
        || !jti.bytes().all(|c| c.is_ascii_hexdigit())
        || task_id != format!("pa_{jti}")
    {
        return None;
    }
    Some((task_id, jti))
}

pub(super) async fn save_pending_action(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    conversation_id: i32,
    v: &serde_json::Value,
) {
    if v.get("event").is_some() {
        cancel(db, uid, conversation_id, v).await;
        return;
    }
    let tools: Vec<String> = v["specs"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s["tool"].as_str())
                .map(|t| t.to_string())
                .collect()
        })
        .unwrap_or_default();
    let args = v["specs"].to_string();
    let options = if v["options"].is_array() {
        v["options"].to_string()
    } else {
        String::new()
    };
    let expires_at: Option<chrono::NaiveDateTime> = v["expires_at"].as_i64().and_then(|s| {
        chrono::DateTime::from_timestamp(s, 0)
            .map(|t| t.with_timezone(&chrono::Local).naive_local())
    });
    let _ = pending_action::Entity::delete_many()
        .filter(pending_action::Column::ConversationId.eq(conversation_id))
        .filter(pending_action::Column::Status.eq("pending"))
        .exec(db)
        .await;
    let _ = pending_action::ActiveModel {
        task_id: Set(json_capped(v, "task_id", 64)),
        conversation_id: Set(conversation_id),
        user_id: Set(uid),
        skill: Set(json_capped(v, "skill", 32)),
        tool: Set(tools.join(",").chars().take(255).collect()),
        args: Set(Some(args.chars().take(PENDING_ARGS_COL_MAX).collect())),
        target: Set(json_capped(v, "target", 300)),
        question: Set(json_capped(v, "question", PENDING_QUESTION_COL_MAX)),
        options: Set(options.chars().take(PENDING_OPTIONS_COL_MAX).collect()),
        jti: Set(json_capped(v, "jti", 64)),
        expires_at: Set(expires_at),
        requested_by: Set(match json_capped(v, "requested_by", 32) {
            s if s.is_empty() => "user".to_string(),
            s => s,
        }),
        source_event: Set(json_capped(v, "source_event", 64)),
        confirmation_required: Set(true),
        confirmation_status: Set("awaiting".to_string()),
        status: Set("pending".to_string()),
        ..Default::default()
    }
    .save(db)
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cancellation_requires_matching_identity() {
        let jti = "a".repeat(32);
        let value = json!({"event": "cancelled", "task_id": format!("pa_{jti}"), "jti": jti});
        assert!(cancellation(&value).is_some());
        for change in [
            json!({"event": "done"}),
            json!({"jti": ""}),
            json!({"task_id": "pa_other"}),
            json!({"jti": "z".repeat(32)}),
        ] {
            let mut bad = value.clone();
            for (key, field) in change.as_object().unwrap() {
                bad[key] = field.clone();
            }
            assert!(cancellation(&bad).is_none());
        }
        assert!(cancellation(&json!({})).is_none());
    }
}
