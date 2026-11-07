use sea_orm::DbErr;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeSet;

pub(super) const MAX_IMAGES: usize = 100;
pub(super) const MAX_INTENT_BYTES: usize = 8192;
pub(super) const PREVIEW_LIMIT: usize = 10;
pub(super) const APPROVAL_SECONDS: i64 = 900;

fn present<'de, T: Deserialize<'de>, D: Deserializer<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub display_name: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub folder_id: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub is_favorite: Option<bool>,
}

impl Patch {
    fn normalize(&mut self) -> Result<(), DbErr> {
        if self
            .display_name
            .as_ref()
            .is_some_and(|v| v.trim().is_empty() || v.chars().count() > 255)
            || self
                .description
                .as_ref()
                .is_some_and(|v| v.chars().count() > 2000)
            || self.folder_id.is_some_and(|v| v < 0)
            || (self.display_name.is_none()
                && self.description.is_none()
                && self.folder_id.is_none()
                && self.is_favorite.is_none())
        {
            return Err(invalid());
        }
        self.display_name = self.display_name.take().map(|v| v.trim().to_owned());
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub image_id: i32,
    pub changes: Patch,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Intent {
    Move {
        image_ids: Vec<i32>,
        folder_id: i32,
    },
    Favorite {
        image_ids: Vec<i32>,
        is_favorite: bool,
    },
    Metadata {
        items: Vec<Item>,
    },
    Delete {
        image_ids: Vec<i32>,
    },
}

pub(super) fn invalid() -> DbErr {
    DbErr::Custom("图片操作范围或参数无效，请重新选择".into())
}

impl Intent {
    pub fn normalize(mut self) -> Result<Self, DbErr> {
        let mut ids = match &mut self {
            Self::Move {
                image_ids,
                folder_id,
            } => {
                if *folder_id < 0 {
                    return Err(invalid());
                }
                image_ids.sort_unstable();
                image_ids.clone()
            }
            Self::Favorite { image_ids, .. } | Self::Delete { image_ids } => {
                image_ids.sort_unstable();
                image_ids.clone()
            }
            Self::Metadata { items } => {
                items.sort_unstable_by_key(|v| v.image_id);
                for item in items.iter_mut() {
                    item.changes.normalize()?;
                }
                items.iter().map(|v| v.image_id).collect()
            }
        };
        if ids.is_empty() || ids.len() > MAX_IMAGES || ids.iter().any(|id| *id <= 0) {
            return Err(invalid());
        }
        ids.dedup();
        if ids.len() != self.ids().len()
            || serde_json::to_vec(&self).map_err(|_| invalid())?.len() > MAX_INTENT_BYTES
        {
            return Err(invalid());
        }
        Ok(self)
    }

    pub fn ids(&self) -> Vec<i32> {
        match self {
            Self::Move { image_ids, .. }
            | Self::Favorite { image_ids, .. }
            | Self::Delete { image_ids } => image_ids.clone(),
            Self::Metadata { items } => items.iter().map(|v| v.image_id).collect(),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Move { .. } => "move",
            Self::Favorite { .. } => "favorite",
            Self::Metadata { .. } => "metadata",
            Self::Delete { .. } => "delete",
        }
    }

    pub fn folders(&self) -> BTreeSet<i32> {
        match self {
            Self::Move { folder_id, .. } => BTreeSet::from([*folder_id]),
            Self::Metadata { items } => items.iter().filter_map(|v| v.changes.folder_id).collect(),
            _ => BTreeSet::new(),
        }
    }

    pub fn patch(&self, id: i32) -> Patch {
        match self {
            Self::Move { folder_id, .. } => Patch {
                folder_id: Some(*folder_id),
                ..Default::default()
            },
            Self::Favorite { is_favorite, .. } => Patch {
                is_favorite: Some(*is_favorite),
                ..Default::default()
            },
            Self::Metadata { items } => items
                .iter()
                .find(|v| v.image_id == id)
                .map(|v| v.changes.clone())
                .unwrap_or_default(),
            Self::Delete { .. } => Patch::default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub expires_at: i64,
    pub intent: Intent,
}
