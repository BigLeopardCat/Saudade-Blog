//! Continuation is a control request, never a new user message or an approval.

use super::ChatRequest;

pub(super) fn valid(payload: &ChatRequest) -> bool {
    let identifier = |value: &str| {
        value.len() <= 100
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    identifier(&payload.task_id)
        && identifier(&payload.resume_task)
        && payload.browser_result.as_ref().is_none_or(|result| {
            !payload.resume_task.is_empty() && !result.command_id.is_empty()
                && identifier(&result.command_id) && result.path.len() <= 2048
                && matches!(result.status.as_str(), "completed" | "timeout" | "failed")
        })
        && (payload.resume_task.is_empty()
            || (payload.task_id.is_empty()
                && payload.conversation_id.is_some_and(|id| id > 0)
                && payload.message.trim().is_empty()
                && payload.image.as_ref().is_none_or(|v| v.is_empty())
                && payload.confirm_token.as_deref().unwrap_or("").is_empty()
                && payload.confirm_pick.as_deref().unwrap_or("").is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn browser_report_is_bound_to_a_control_only_continuation() {
        let report = json!({"command_id": "nav-123", "status": "completed", "path": "/guestbook"});
        let mut request = json!({"message": "", "resume_task": "task-123", "conversation_id": 42,
                                 "browser_result": report});
        assert!(valid(&serde_json::from_value(request.clone()).unwrap()));
        request["resume_task"] = json!("");
        assert!(!valid(&serde_json::from_value(request.clone()).unwrap()));
        request["resume_task"] = json!("task-123");
        request["browser_result"]["status"] = json!("approved");
        assert!(!valid(&serde_json::from_value(request).unwrap()));
    }

    #[test]
    fn continuation_cannot_carry_new_content_or_approval() {
        let request = json!({"message": "", "resume_task": "task-123", "conversation_id": 42});
        assert!(valid(&serde_json::from_value(request.clone()).unwrap()));
        for (key, value) in [
            ("message", json!("new task")),
            ("task_id", json!("another")),
            ("image", json!(["image-data"])),
            ("confirm_token", json!("approval")),
            ("confirm_pick", json!("yes")),
            ("resume_task", json!("../other")),
            ("conversation_id", json!(null)),
        ] {
            let mut changed = request.clone();
            changed[key] = value;
            assert!(!valid(&serde_json::from_value(changed).unwrap()), "{key}");
        }
    }
}
