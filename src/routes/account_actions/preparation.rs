//! Normalize relative deadlines once, before the confirmation intent is frozen.
use super::{targets, Action, Intent, Prepared, Target};
use chrono::{Duration, NaiveDateTime};
use sea_orm::DbErr;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub action: Action,
    pub target: Target,
    pub role: Option<String>,
    pub muted_until: Option<String>,
    pub hours: Option<i64>,
    #[serde(default)]
    pub permanent: bool,
}

impl From<Intent> for PrepareRequest {
    fn from(intent: Intent) -> Self {
        Self {
            action: intent.action,
            target: intent.target,
            role: intent.role,
            muted_until: intent.muted_until,
            hours: None,
            permanent: false,
        }
    }
}

#[derive(Default, Serialize)]
pub struct Preparation {
    pub plan: Prepared,
    pub intent: Option<Intent>,
}

impl PrepareRequest {
    pub(super) fn normalize(self, now: NaiveDateTime) -> Result<Intent, DbErr> {
        let choices = usize::from(self.muted_until.is_some())
            + usize::from(self.hours.is_some())
            + usize::from(self.permanent);
        if (self.action == Action::Mute && choices != 1)
            || (self.action != Action::Mute && choices != 0)
        {
            return Err(targets::failure(
                "禁言须明确且仅指定小时数、永久或绝对到期时间；其他操作不得指定期限",
            ));
        }
        let until = if let Some(hours) = self.hours {
            let duration = Duration::try_hours(hours)
                .filter(|_| (1..=i32::MAX as i64).contains(&hours))
                .ok_or_else(|| targets::failure("禁言小时数无效或超出范围"))?;
            let date = now
                .checked_add_signed(duration)
                .filter(|date| date.format("%Y").to_string().len() == 4)
                .ok_or_else(|| targets::failure("禁言到期时间超出范围"))?;
            Some(date.format("%Y-%m-%dT%H:%M:%S").to_string())
        } else if self.permanent {
            Some("9999-12-31T23:59:59".to_owned())
        } else {
            self.muted_until
        };
        let intent = Intent {
            action: self.action,
            target: self.target,
            role: self.role,
            muted_until: until,
        };
        targets::validate(&intent, now)?;
        Ok(intent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relative_deadline_is_frozen_before_confirmation_and_cannot_enter_execution() {
        let clock =
            NaiveDateTime::parse_from_str("2026-11-03T23:30:00", "%Y-%m-%dT%H:%M:%S").unwrap();
        let request = json!({"action":"mute","target":{"id":2},"hours":2});
        let normalized = serde_json::from_value::<PrepareRequest>(request.clone())
            .unwrap()
            .normalize(clock)
            .unwrap();
        assert_eq!(
            normalized.muted_until.as_deref(),
            Some("2026-11-04T01:30:00")
        );
        let encoded = serde_json::to_value(&normalized).unwrap();
        assert!(encoded.get("hours").is_none());
        assert!(serde_json::from_value::<Intent>(request).is_err());
        let replay: Intent = serde_json::from_value(encoded).unwrap();
        assert_eq!(
            targets::validate(&replay, clock + Duration::minutes(30)).unwrap(),
            targets::validate(&normalized, clock).unwrap()
        );
        assert!(targets::validate(&replay, clock + Duration::hours(3)).is_err());
    }

    #[test]
    fn conflicting_missing_and_overflowing_durations_are_rejected() {
        let clock = targets::now();
        for fields in [
            json!({}),
            json!({"hours":0}),
            json!({"hours":-1}),
            json!({"hours":2,"permanent":true}),
            json!({"hours":i64::MAX}),
            json!({"hours":2147483647i64}),
            json!({"permanent":true,"mutedUntil":"9999-12-31T23:59:59"}),
        ] {
            let mut value = json!({"action":"mute","target":{"id":2}});
            value
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            assert!(serde_json::from_value::<PrepareRequest>(value)
                .unwrap()
                .normalize(clock)
                .is_err());
        }
        let request: PrepareRequest =
            serde_json::from_value(json!({"action":"mute", "target":{"id":2},"permanent":true}))
                .unwrap();
        assert_eq!(
            request.normalize(clock).unwrap().muted_until.as_deref(),
            Some("9999-12-31T23:59:59")
        );
    }
}
