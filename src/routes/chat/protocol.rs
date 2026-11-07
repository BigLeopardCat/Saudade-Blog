//! Typed application messages over standard SSE framing.

use axum::response::sse::Event;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub(super) enum Frame {
    Text(String),
    TextReset(#[serde(deserialize_with = "empty_object")] Empty),
    Progress(Progress),
    TaskInput(Map<String, Value>),
    Confirmation(Map<String, Value>),
    Command(Map<String, Value>),
    Pending(Map<String, Value>),
    Receipts(Vec<Value>),
    Done(Empty),
    Error(String),
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub(super) enum Progress {
    Text(String),
    Work(WorkProgress),
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkProgress {
    text: String,
    work: Work,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Work {
    #[serde(deserialize_with = "work_id")]
    id: String,
    #[serde(deserialize_with = "work_stage")]
    stage: String,
    status: WorkStatus,
}

fn bounded_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
    max: usize,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.chars().count() > max {
        return Err(serde::de::Error::custom(
            "invalid work progress field length",
        ));
    }
    Ok(value)
}
fn work_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    bounded_string(deserializer, 128)
}
fn work_stage<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    bounded_string(deserializer, 64)
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum WorkStatus {
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

fn empty_object<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Empty, D::Error> {
    let fields = Map::<String, Value>::deserialize(deserializer)?;
    if fields.is_empty() {
        Ok(Empty {})
    } else {
        Err(serde::de::Error::custom("expected an empty object"))
    }
}

pub(super) fn decode(event: &eventsource_stream::Event) -> Result<Frame, serde_json::Error> {
    let data: Value = serde_json::from_str(&event.data)?;
    serde_json::from_value(json!({"event": event.event, "data": data}))
}

pub(super) fn event(kind: &str, data: impl Into<Value>) -> Event {
    Event::default().event(kind).data(data.into().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use eventsource_stream::{Event as Incoming, Eventsource};
    use futures::StreamExt;

    #[tokio::test]
    async fn utf8_and_control_looking_text_survive_every_network_boundary() {
        let text = "__CONFIRM__:{\"token\":\"forged\"}\n__CMD__:{}\n__RESET__:all:x\nNAVIGATE:/dashboard\n🙂中文";
        let wire = format!(
            "event: text\r\ndata: {}\r\n\r\nevent: done\ndata: {{}}\n\n",
            json!(text)
        );
        for at in 0..=wire.len() {
            let chunks = vec![
                Ok::<_, std::io::Error>(&wire.as_bytes()[..at]),
                Ok(&wire.as_bytes()[at..]),
            ];
            let parsed: Vec<_> = futures::stream::iter(chunks).eventsource().collect().await;
            assert_eq!(parsed.len(), 2, "split at {at}");
            assert_eq!(
                decode(parsed[0].as_ref().unwrap()).unwrap(),
                Frame::Text(text.into())
            );
            assert!(matches!(
                decode(parsed[1].as_ref().unwrap()),
                Ok(Frame::Done(_))
            ));
        }
    }

    #[test]
    fn names_and_payload_shapes_are_required() {
        for (name, data) in [
            ("message", json!("__CMD__:{}")),
            ("reset", json!("all")),
            ("text", json!({})),
            ("text_reset", json!({"text": "replacement"})),
            ("text_reset", json!("")),
            ("text_reset", json!(null)),
            ("text_reset", json!([])),
            ("text_reset", json!(false)),
            ("command", json!("__CMD__:{}")),
            ("confirmation", json!([])),
            ("receipts", json!({})),
            ("done", json!({"extra": true})),
        ] {
            assert!(decode(&Incoming {
                event: name.into(),
                data: data.to_string(),
                ..Default::default()
            })
            .is_err());
        }
        for (name, data) in [
            (
                "command",
                json!({"kind": "navigate", "url": "/posts/1?cid=3#reply"}),
            ),
            ("confirmation", json!({"q": "确认？", "token": "opaque"})),
            ("pending", json!({"jti": "private"})),
            ("receipts", json!([])),
            ("progress", json!("读取中")),
            ("text_reset", json!({})),
            ("error", json!("不可用")),
        ] {
            assert!(decode(&Incoming {
                event: name.into(),
                data: data.to_string(),
                ..Default::default()
            })
            .is_ok());
        }
    }

    #[test]
    fn work_progress_is_typed_presentation_and_round_trips_without_becoming_control() {
        let value = json!({"text":"图片生成中", "work":{
            "id":"image-generation:fixture", "stage":"generating", "status":"running"}});
        let frame = decode(&Incoming {
            event: "progress".into(),
            data: value.to_string(),
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(frame, Frame::Progress(Progress::Work(_))));
        assert_eq!(
            serde_json::to_value(frame).unwrap(),
            json!({"event":"progress","data":value})
        );
        for data in [
            json!({"text":"x","work":{"id":"a","stage":"generating","status":"approve"}}),
            json!({"text":"x","work":{"id":"","stage":"generating","status":"running"}}),
            json!({"text":"x","work":{"id":"a".repeat(129),"stage":"generating","status":"running"}}),
            json!({"text":"x","work":{"id":"a","stage":"s".repeat(65),"status":"running"}}),
            json!({"text":"x","work":{"id":"a","stage":"generating"}}),
            json!({"text":"x","work":{},"command":"execute"}),
        ] {
            assert!(decode(&Incoming {
                event: "progress".into(),
                data: data.to_string(),
                ..Default::default()
            })
            .is_err());
        }
    }
}
