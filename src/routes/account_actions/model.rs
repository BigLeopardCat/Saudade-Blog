use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Freeze,
    Unfreeze,
    SetRole,
    Mute,
    Unmute,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: Option<i32>,
    pub username: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub action: Action,
    pub target: Target,
    pub role: Option<String>,
    pub muted_until: Option<String>,
}
/// Deliberate allowlist: neither credentials nor authentication generations leave the service.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub id: i32,
    pub username: String,
    pub role: String,
    pub status: i16,
    pub muted_until: Option<String>,
}
impl From<&crate::entity::user::Model> for Account {
    fn from(row: &crate::entity::user::Model) -> Self {
        Self {
            id: row.id,
            username: row.username.clone(),
            role: row.role.clone(),
            status: row.status,
            muted_until: row
                .muted_until
                .map(|v| v.format("%Y-%m-%dT%H:%M:%S").to_string()),
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepared {
    pub version: String,
    pub before: Account,
    pub after: Account,
    pub changed: bool,
    pub revoke_sessions: bool,
    pub notification_count: u8,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub intent: Intent,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub before_version: String,
    pub state: Prepared,
}
