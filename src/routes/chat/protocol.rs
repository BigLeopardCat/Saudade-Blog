//! Typed application messages over standard SSE framing.

use axum::response::sse::Event;
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub(super) enum Frame {
    Text(String),
    Progress(String),
    TaskInput(Map<String, Value>),
    Confirmation(Map<String, Value>),
    Command(Map<String, Value>),
    Pending(Map<String, Value>),
    Receipts(Vec<Value>),
    Summary(Value),
    Done(Empty),
    Error(String),
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

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
            ("summary", json!("私有摘要")),
            (
                "summary",
                json!({"text":"私有摘要", "base_id":10, "through_id":20}),
            ),
            ("progress", json!("读取中")),
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
}
