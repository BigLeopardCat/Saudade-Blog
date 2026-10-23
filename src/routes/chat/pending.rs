//! Persistence of confirmation proposals and explicit cancellation events.

use super::{PENDING_ARGS_COL_MAX, PENDING_OPTIONS_COL_MAX, PENDING_QUESTION_COL_MAX, json_capped};
use crate::entity::pending_action;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set, TransactionTrait,
};

pub(super) async fn cancel<C: ConnectionTrait>(
    db: &C,
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

pub(super) async fn save_pending_action<C: ConnectionTrait + TransactionTrait>(
    db: &C,
    uid: i32,
    conversation_id: i32,
    v: &serde_json::Value,
) -> bool {
    if v.get("event").is_some() {
        return cancel(db, uid, conversation_id, v).await;
    }
    let Some(proposal) = model(uid, conversation_id, v) else {
        tracing::warn!("pending proposal exceeds complete persistence bounds");
        return false;
    };
    let result = async {
        let txn = db.begin().await?;
        pending_action::Entity::delete_many()
            .filter(pending_action::Column::ConversationId.eq(conversation_id))
            .filter(pending_action::Column::UserId.eq(uid))
            .filter(pending_action::Column::Status.eq("pending"))
            .exec(&txn)
            .await?;
        proposal.insert(&txn).await?;
        txn.commit().await
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(error = %error, "failed to persist complete pending proposal");
        return false;
    }
    true
}

fn model(
    uid: i32,
    conversation_id: i32,
    v: &serde_json::Value,
) -> Option<pending_action::ActiveModel> {
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
    let question = v["question"].as_str().unwrap_or("");
    if args.chars().count() > PENDING_ARGS_COL_MAX
        || question.chars().count() > PENDING_QUESTION_COL_MAX
        || options.chars().count() > PENDING_OPTIONS_COL_MAX
    {
        return None;
    }
    Some(pending_action::ActiveModel {
        task_id: Set(json_capped(v, "task_id", 64)),
        conversation_id: Set(conversation_id),
        user_id: Set(uid),
        skill: Set(json_capped(v, "skill", 32)),
        tool: Set(tools.join(",").chars().take(255).collect()),
        args: Set(Some(args)),
        target: Set(json_capped(v, "target", 300)),
        question: Set(question.to_owned()),
        options: Set(options),
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
    })
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

    fn long_proposal() -> serde_json::Value {
        let original = format!("正文{}", "\t".repeat(1998));
        let before = "\\u003a".repeat(2000);
        let after = "\\uff1a".repeat(2000);
        json!({
            "task_id": format!("pa_{}", "a".repeat(32)), "jti": "a".repeat(32),
            "skill": "announcement_update", "target": "公告全文", "expires_at": 2_000_000_000,
            "question": format!("原文：{before}\n更新为：{after}\n确认执行？"),
            "options": [{"label":"确认执行","value":"yes","kind":"primary"},
                        {"label":"取消操作","value":"no","kind":"default"}],
            "specs": [{"tool":"update_announcement","args":{"content":original}}]
        })
    }

    #[test]
    fn complete_proposals_are_bounded_without_truncating_text_or_json() {
        let value = long_proposal();
        assert!(value["question"].as_str().unwrap().chars().count() > 24_000);
        assert!(value["specs"].to_string().chars().count() > 4000);
        let row = model(7, 42, &value).unwrap();
        assert_eq!(row.question.unwrap(), value["question"].as_str().unwrap());
        let args = row.args.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&args).unwrap(),
            value["specs"]
        );
        for (field, size) in [
            ("question", PENDING_QUESTION_COL_MAX),
            ("options", PENDING_OPTIONS_COL_MAX),
        ] {
            let mut oversized = value.clone();
            oversized[field] = if field == "options" {
                json!([{"label":"x".repeat(size)}])
            } else {
                json!("文".repeat(size + 1))
            };
            assert!(model(7, 42, &oversized).is_none());
        }
        let mut oversized = value.clone();
        oversized["specs"][0]["args"]["content"] = json!("文".repeat(PENDING_ARGS_COL_MAX + 1));
        assert!(model(7, 42, &oversized).is_none());
        let mut boundary = value;
        boundary["question"] = json!("😀".repeat(PENDING_QUESTION_COL_MAX));
        assert_eq!(
            model(7, 42, &boundary)
                .unwrap()
                .question
                .unwrap()
                .chars()
                .count(),
            PENDING_QUESTION_COL_MAX
        );
    }

    #[tokio::test]
    async fn postgres_pending_roundtrip_retains_complete_question_and_specs() {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            return;
        };
        let db = sea_orm::Database::connect(url).await.unwrap();
        let txn = db.begin().await.unwrap();
        let prefix = format!("pending_{}", uuid::Uuid::new_v4().simple());
        let owner = crate::entity::user::ActiveModel {
            username: Set(prefix.clone()),
            nickname: Set(prefix.clone()),
            password: Set("owned fixture".to_owned()),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let conversation = crate::entity::conversation::ActiveModel {
            user_id: Set(owner.id),
            title: Set(Some(prefix)),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let value = long_proposal();
        assert!(save_pending_action(&txn, owner.id, conversation.id, &value).await);
        let row = pending_action::Entity::find()
            .filter(pending_action::Column::ConversationId.eq(conversation.id))
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.question, value["question"].as_str().unwrap());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(row.args.as_deref().unwrap()).unwrap(),
            value["specs"]
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&row.options).unwrap(),
            value["options"]
        );
        let restored = json!({"q":row.question,"opts":serde_json::from_str::<serde_json::Value>(&row.options).unwrap()});
        assert_eq!(restored["q"], value["question"]);
        assert_eq!(restored["opts"], value["options"]);
        let mut oversized = value.clone();
        oversized["question"] = json!("x".repeat(PENDING_QUESTION_COL_MAX + 1));
        let mut storage_failure = value.clone();
        storage_failure["skill"] = json!("invalid\0fixture");
        for rejected in [oversized, storage_failure] {
            // PostgreSQL rejects NUL after deletion; the savepoint must retain the old card.
            assert!(!save_pending_action(&txn, owner.id, conversation.id, &rejected).await);
            let retained = pending_action::Entity::find_by_id(row.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(retained.question, value["question"].as_str().unwrap());
        }
        txn.rollback().await.unwrap();
        assert!(
            pending_action::Entity::find_by_id(row.id)
                .one(&db)
                .await
                .unwrap()
                .is_none()
        );
    }
}
