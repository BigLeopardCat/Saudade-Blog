use std::{collections::HashSet, sync::Arc};

use axum::{extract::State, Json};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, Statement,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::AppState;
use crate::{entity::web_info, utils::ApiResponse};

pub const KEY: &str = "featuredPhotos";
pub const LIMIT: usize = 12;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub image_id: i32,
    pub caption: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    image_id: i32,
    url: String,
    caption: String,
}

pub fn validate(items: &[Selection]) -> Result<(), &'static str> {
    if items.len() > LIMIT {
        return Err("相册精选最多选择 12 张图片");
    }
    let mut ids = HashSet::new();
    for item in items {
        if item.image_id <= 0 || !ids.insert(item.image_id) {
            return Err("精选图片编号无效或重复");
        }
        if item.caption.chars().count() > 120 {
            return Err("照片说明最多 120 个字");
        }
    }
    Ok(())
}

pub fn parse(value: &str) -> Vec<Selection> {
    serde_json::from_str::<Vec<Selection>>(value)
        .ok()
        .filter(|items| validate(items).is_ok())
        .unwrap_or_default()
}

async fn available<C: ConnectionTrait>(db: &C, items: &[Selection]) -> Result<Vec<Photo>, DbErr> {
    if items.is_empty() {
        return Ok(vec![]);
    }
    // Only explicitly selected, live gallery assets receive public media URLs.
    let ids: Vec<sea_orm::Value> = items.iter().map(|item| item.image_id.into()).collect();
    let placeholders = (1..=items.len())
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(",");
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "SELECT i.image_key, i.image_url, l.public_id FROM images i \
             LEFT JOIN image_location l ON l.image_id = i.image_key \
             WHERE i.image_key IN ({placeholders}) \
             AND NOT EXISTS (SELECT 1 FROM image_deletion d WHERE d.image_id = i.image_key)"
            ),
            ids,
        ))
        .await?;
    let mut locations = std::collections::HashMap::new();
    for row in rows {
        let url = match row.try_get::<Option<Uuid>>("", "public_id")? {
            Some(id) => super::gallery::storage::media_url(id),
            None => {
                let url = row.try_get::<String>("", "image_url")?;
                if !super::gallery::valid_url(&url) {
                    continue;
                }
                url
            }
        };
        locations.insert(row.try_get::<i32>("", "image_key")?, url);
    }
    Ok(items
        .iter()
        .filter_map(|item| {
            locations.get(&item.image_id).map(|id| Photo {
                image_id: item.image_id,
                url: id.clone(),
                caption: item.caption.clone(),
            })
        })
        .collect())
}

pub async fn check_available<C: ConnectionTrait>(
    db: &C,
    items: &[Selection],
) -> Result<bool, DbErr> {
    Ok(available(db, items).await?.len() == items.len())
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<ApiResponse<Vec<Photo>>> {
    let setting = match web_info::Entity::find()
        .filter(web_info::Column::KeyName.eq(KEY))
        .one(&state.db)
        .await
    {
        Ok(row) => row,
        Err(e) => return super::db_error("读取精选相册", &e),
    };
    let items = setting.map(|row| parse(&row.value)).unwrap_or_default();
    match available(&state.db, &items).await {
        Ok(photos) => Json(ApiResponse::success(photos)),
        Err(e) => super::db_error("读取精选照片", &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_is_bounded_unique_and_cannot_publish_arbitrary_urls() {
        let item = Selection {
            image_id: 1,
            caption: "春日".into(),
        };
        assert!(validate(std::slice::from_ref(&item)).is_ok());
        assert!(validate(&[item.clone(), item.clone()]).is_err());
        assert!(validate(&vec![item; LIMIT + 1]).is_err());
        assert!(validate(&[Selection {
            image_id: -1,
            caption: String::new()
        }])
        .is_err());
        assert!(validate(&[Selection {
            image_id: 2,
            caption: "樱".repeat(121)
        }])
        .is_err());
        assert!(
            parse(r#"[{"imageId":1,"caption":"","url":"https://example.test/private"}]"#)
                .is_empty()
        );
        assert!(parse("broken").is_empty());
        assert!(parse("[]").is_empty());
    }

    #[tokio::test]
    async fn manifest_keeps_selection_order_and_omits_deleted_images() {
        use sea_orm::MockDatabase;
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let db = MockDatabase::new(DbBackend::Postgres)
            .append_query_results([[
                std::collections::BTreeMap::<&str, sea_orm::Value>::from([
                    ("image_key", 2.into()),
                    ("public_id", b.into()),
                ]),
                std::collections::BTreeMap::<&str, sea_orm::Value>::from([
                    ("image_key", 1.into()),
                    ("public_id", a.into()),
                ]),
            ]])
            .into_connection();
        let items = [1, 3, 2].map(|image_id| Selection {
            image_id,
            caption: format!("photo {image_id}"),
        });
        let photos = available(&db, &items).await.unwrap();
        assert_eq!(
            photos.iter().map(|p| p.image_id).collect::<Vec<_>>(),
            vec![1, 2]
        );
        let json = serde_json::to_value(photos).unwrap();
        assert_eq!(json[0]["url"], format!("/api/public/media/{a}"));
        assert_eq!(json[0]["caption"], "photo 1");
        assert!(json[0].get("storagePath").is_none());
    }
    #[tokio::test]
    async fn invalid_or_missing_photo_prevents_the_entire_settings_write() {
        use sea_orm::MockDatabase;
        for image_id in [-1, 42] {
            let db = MockDatabase::new(DbBackend::Postgres)
                .append_query_results([
                    Vec::<std::collections::BTreeMap<&str, sea_orm::Value>>::new(),
                ])
                .into_connection();
            let state = Arc::new(AppState {
                db,
                rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 60, 300),
                post_limiter: crate::risk::PostRateLimiter::new(),
                report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
            });
            let payload = super::super::web_info::WebSettingPayload {
                blog_title: Some("must remain unchanged".into()),
                featured_photos: Some(vec![Selection {
                    image_id,
                    caption: String::new(),
                }]),
                ..Default::default()
            };
            let result =
                super::super::web_info::update_web_info(State(state.clone()), Json(payload)).await;
            assert_ne!(result.0.code, 200);
            let statements = Arc::into_inner(state).unwrap().db.into_transaction_log();
            assert_eq!(statements.len(), usize::from(image_id > 0));
        }
    }
}
