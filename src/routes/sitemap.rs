//! Public, canonical route locations for search engines.

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::Response,
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use std::sync::Arc;

use crate::entity::{category, note};
use crate::routes::{
    page_links::{page_url, site_base},
    AppState,
};

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

async fn entries(
    db: &sea_orm::DatabaseConnection,
    site: &reqwest::Url,
) -> Result<Vec<(String, Option<String>)>, sea_orm::DbErr> {
    let mut rows = vec![(page_url(site, &[]), None)];
    for path in ["times", "talk", "guestbook", "about"] {
        rows.push((page_url(site, &[path]), None));
    }
    if crate::utils::iot_enabled() {
        rows.push((page_url(site, &["device-console", ""]), None));
    }
    let cats = category::Entity::find().all(db).await?;
    for cat in cats {
        if let Some(slug) = cat.path_name.filter(|value| !value.trim().is_empty()) {
            rows.push((page_url(site, &["category", &slug]), None));
        }
    }
    let notes = note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .column(note::Column::UpdatedAt)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.is_in(super::notes::public_status_words()))
        .filter(note::Column::DraftOf.is_null())
        .order_by_desc(note::Column::Id)
        .into_tuple::<(i32, chrono::NaiveDateTime)>()
        .all(db)
        .await?;
    for (id, updated_at) in notes {
        rows.push((
            page_url(site, &["article", &id.to_string()]),
            Some(updated_at.format("%Y-%m-%d").to_string()),
        ));
    }
    Ok(rows)
}

pub async fn sitemap_xml(State(st): State<Arc<AppState>>) -> Result<Response, StatusCode> {
    let site = site_base().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let rows = entries(&st.db, &site).await.map_err(|error| {
        tracing::error!(event = "sitemap_query_failed", %error, "Could not read public sitemap entries");
        StatusCode::SERVICE_UNAVAILABLE
    })?;
    let mut body = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
    );
    for (location, lastmod) in rows {
        body.push_str(&format!("  <url><loc>{}</loc>", xml_escape(&location)));
        if let Some(date) = lastmod {
            body.push_str(&format!("<lastmod>{date}</lastmod>"));
        }
        body.push_str("</url>\n");
    }
    body.push_str("</urlset>\n");
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(axum::body::Body::from(body))
        .unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{DatabaseBackend, DbErr, MockDatabase};

    #[test]
    fn locations_encode_one_slug_segment_and_discard_query_or_fragment() {
        let site = reqwest::Url::parse("https://example.test/?source=x#top").unwrap();
        assert_eq!(
            page_url(&site, &["category", "Rust & Web/中文"]),
            "https://example.test/category/Rust%20&%20Web%2F%E4%B8%AD%E6%96%87"
        );
        assert_eq!(
            xml_escape(&page_url(&site, &["category", "a&b"])),
            "https://example.test/category/a&amp;b"
        );
        assert_eq!(page_url(&site, &[]), "https://example.test/");
    }

    #[tokio::test]
    async fn uses_route_slug_and_excludes_shadow_drafts_in_query() {
        let category = category::Model {
            id: 3,
            name: "显示名称".into(),
            path_name: Some("rust-web".into()),
            introduce: None,
            icon: None,
            color: None,
        };
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![category]])
            .append_query_results([Vec::<note::Model>::new()])
            .into_connection();
        let rows = entries(&db, &reqwest::Url::parse("https://example.test").unwrap())
            .await
            .unwrap();
        assert!(rows
            .iter()
            .any(|(url, _)| url == "https://example.test/category/rust-web"));
        assert!(!rows.iter().any(|(url, _)| url.contains("显示名称")));
        let statements = format!("{:?}", db.into_transaction_log());
        assert!(statements.contains("draft_of") && statements.contains("IS NULL"));
        assert!(statements.contains("is_public") && statements.contains("published"));
    }

    #[tokio::test]
    async fn database_failure_is_not_an_empty_successful_sitemap() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors([DbErr::Custom("offline".into())])
            .into_connection();
        assert!(
            entries(&db, &reqwest::Url::parse("https://example.test").unwrap())
                .await
                .is_err()
        );
    }
}
