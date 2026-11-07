//! Bounded public display fields; internal attribution identifiers never leave the host.
use crate::{
    entity::note,
    routes::{notes::authors, web_info},
};
use sea_orm::{ConnectionTrait, DbErr};
use serde_json::{json, Value};

const NAME_CHARS: usize = 80;
const DESCRIPTION_CHARS: usize = 2000;
const URL_CHARS: usize = 2048;

fn text(value: &str, limit: usize) -> (String, bool) {
    (
        value.chars().take(limit).collect(),
        value.chars().count() > limit,
    )
}

fn url(value: Option<&str>) -> (Option<String>, bool) {
    match value {
        Some(value) if value.chars().count() <= URL_CHARS => (Some(value.to_owned()), false),
        Some(_) => (None, true),
        None => (None, false),
    }
}

fn position(value: Option<f64>, max: f64) -> Option<f64> {
    value.filter(|value| value.is_finite() && (0.0..=max).contains(value))
}

fn fit(value: Option<&str>) -> Option<&str> {
    value.filter(|value| matches!(*value, "cover" | "contain"))
}

pub(super) async fn article<C: ConnectionTrait>(db: &C, row: &note::Model) -> Result<Value, DbErr> {
    let author = if let Some(id) = row.user_id {
        match authors::profiles(db, vec![id]).await?.remove(&id) {
            Some(author) => Some(author),
            None => {
                let (name, avatar) = web_info::site_author_checked(db).await?;
                Some(authors::PublicAuthor { name, avatar })
            }
        }
    } else {
        None
    };
    let (name, name_truncated) = author
        .as_ref()
        .map(|author| text(&author.name, NAME_CHARS))
        .map(|(name, truncated)| (Some(name), truncated))
        .unwrap_or((None, false));
    let (avatar, avatar_truncated) = url(author.as_ref().map(|author| author.avatar.as_str()));
    let (description, description_truncated) =
        text(row.description.as_deref().unwrap_or(""), DESCRIPTION_CHARS);
    let (cover, cover_truncated) = url(Some(row.cover.as_deref().unwrap_or("")));
    Ok(json!({
        "authorName": name, "authorNameTruncated": name_truncated,
        "authorAvatar": avatar, "authorAvatarTruncated": avatar_truncated,
        "description": description, "descriptionTruncated": description_truncated,
        "cover": cover, "coverTruncated": cover_truncated,
        "coverFocusX": position(row.cover_focus_x, 1.0), "coverFocusY": position(row.cover_focus_y, 1.0),
        "coverZoom": row.cover_zoom.filter(|value| value.is_finite() && (1.0..=4.0).contains(value)),
        "coverFit": fit(row.cover_fit.as_deref()),
        "carouselFocusX": position(row.carousel_focus_x, 1.0), "carouselFocusY": position(row.carousel_focus_y, 1.0),
        "carouselZoom": row.carousel_zoom.filter(|value| value.is_finite() && (1.0..=4.0).contains(value)),
        "carouselFit": fit(row.carousel_fit.as_deref())
    }))
}
