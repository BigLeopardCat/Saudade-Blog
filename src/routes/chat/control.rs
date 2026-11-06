//! Continuation is a control request, never a new user message or an approval.

use super::ChatRequest;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum AppearanceSetting {
    DarkMode,
    Sakura,
    Rain,
    Snow,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppearanceMode {
    On,
    Off,
}

#[derive(Deserialize, Serialize)]
pub struct EditorObservation {
    pub editor_id: String,
    pub revision: u64,
    pub outcome: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub description: Option<String>,
    pub offset: Option<usize>,
    pub next_offset: Option<usize>,
    pub total_chars: Option<usize>,
    pub proposal_id: Option<String>,
}

impl EditorObservation {
    fn valid(&self) -> bool {
        !self.editor_id.is_empty()
            && self.editor_id.len() <= 64
            && self.revision <= 9_007_199_254_740_991
            && matches!(
                self.outcome.as_str(),
                "read" | "proposed" | "updated" | "unchanged"
            )
            && self
                .title
                .as_ref()
                .is_none_or(|v| v.chars().count() <= 1000)
            && self
                .content
                .as_ref()
                .is_none_or(|v| v.chars().count() <= 24000)
            && self
                .description
                .as_ref()
                .is_none_or(|v| v.chars().count() <= 16000)
            && [self.offset, self.next_offset, self.total_chars]
                .into_iter()
                .flatten()
                .all(|v| v <= 1_000_000)
            && self.proposal_id.as_ref().is_none_or(|v| v.len() <= 64)
    }
}

#[derive(Deserialize, Serialize)]
pub struct BrowserResult {
    pub command_id: String,
    pub status: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<BTreeMap<AppearanceSetting, AppearanceMode>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<EditorObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(super) fn valid(payload: &ChatRequest) -> bool {
    let identifier = |value: &str| {
        value.len() <= 100
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    identifier(&payload.turn_id) && identifier(&payload.task_id)
        && identifier(&payload.resume_task)
        && payload.browser_result.as_ref().is_none_or(|result| {
            !payload.resume_task.is_empty()
                && !result.command_id.is_empty()
                && identifier(&result.command_id)
                && result.path.len() <= 512
                && matches!(result.status.as_str(), "completed" | "timeout" | "failed")
                && result
                    .document
                    .as_ref()
                    .is_none_or(EditorObservation::valid)
                && result
                    .error
                    .as_ref()
                    .is_none_or(|v| v.chars().count() <= 500)
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
    fn appearance_reports_preserve_closed_settings_without_authorizing_operations() {
        let request = json!({"message":"", "resume_task":"look", "conversation_id":42,
            "browser_result":{"command_id":"look-1", "status":"completed", "path":"/",
                              "settings":{"dark_mode":"on", "rain":"off"}}});
        let parsed: ChatRequest = serde_json::from_value(request.clone()).unwrap();
        assert!(valid(&parsed));
        let report = serde_json::to_value(parsed.browser_result.unwrap()).unwrap();
        assert_eq!(report["settings"], request["browser_result"]["settings"]);
        for bad in [
            json!({"permission":"on"}),
            json!({"snow":"toggle"}),
            json!({"rain":true}),
        ] {
            let mut changed = request.clone();
            changed["browser_result"]["settings"] = bad;
            assert!(serde_json::from_value::<ChatRequest>(changed).is_err());
        }
    }

    #[test]
    fn editor_receipts_preserve_content_and_unicode_offsets() {
        for document in [
            json!({"editor_id":"editor", "revision":5, "outcome":"read",
                "content":"中😀", "description":"概述🐱", "offset":0,
                "next_offset":2, "total_chars":4}),
            json!({"editor_id":"editor", "revision":6, "outcome":"updated",
                "description":"已应用摘要😀"}),
            json!({"editor_id":"editor", "revision":5, "outcome":"unchanged",
                "description":"已应用摘要😀"}),
        ] {
            let request = json!({"message":"", "resume_task":"editor-task",
                "conversation_id":42, "browser_result":{"command_id":"editor-result",
                    "status":"completed", "path":"/dashboard/notes/new",
                    "document":document}});
            let parsed: ChatRequest = serde_json::from_value(request).unwrap();
            assert!(valid(&parsed));
            let forwarded = serde_json::to_value(parsed.browser_result.unwrap()).unwrap();
            for (key, value) in document.as_object().unwrap() {
                assert_eq!(&forwarded["document"][key], value);
            }
        }
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
