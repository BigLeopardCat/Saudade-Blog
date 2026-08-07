//! sitemap.xml 动态生成（SEO）：固定页面 + 分类 + 公开文章。
//! 挂载于 /sitemap.xml（nginx 放行到 3000），文章/分类变化时爬虫自动重新抓取。

use axum::{
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use std::sync::Arc;

use crate::entity::{category, note};
use crate::routes::AppState;

const SITE: &str = "https://saudade.site";

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 日期转 sitemap lastmod 格式（YYYY-MM-DD，UTC 与本地一致即可——仅用于爬虫提示）
fn lastmod(dt: &chrono::NaiveDateTime) -> String {
    dt.format("%Y-%m-%d").to_string()
}

pub async fn sitemap_xml(State(st): State<Arc<AppState>>) -> Response {
    // 固定页面（优先级高）
    let static_urls: &[(&str, &str)] = &[
        ("/", "1.0"),
        ("/times", "0.9"),
        ("/talk", "0.8"),
        ("/friends", "0.8"),
        ("/about", "0.8"),
        ("/device-console", "0.7"),
    ];

    // 分类页
    let cats = category::Entity::find().all(&st.db).await.unwrap_or_default();

    // 公开文章（含更新时间作为 lastmod）
    let notes = note::Entity::find()
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .order_by_desc(note::Column::Id)
        .all(&st.db)
        .await
        .unwrap_or_default();

    let mut body = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
    );

    for (path, prio) in static_urls {
        body.push_str(&format!(
            "  <url><loc>{SITE}{}</loc><changefreq>daily</changefreq><priority>{}</priority></url>\n",
            xml_escape(path),
            prio
        ));
    }
    for c in &cats {
        if !c.name.is_empty() {
            body.push_str(&format!(
                "  <url><loc>{SITE}/category/{}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>\n",
                xml_escape(&c.name)
            ));
        }
    }
    for n in &notes {
        body.push_str(&format!(
            "  <url><loc>{SITE}/article/{}</loc><lastmod>{}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n",
            n.id,
            lastmod(&n.updated_at)
        ));
    }
    body.push_str("</urlset>\n");

    // 搜索引擎要求 XML 媒体类型（text/html 会被拒绝收录）
    Response::builder()
        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(axum::body::Body::from(body))
        .unwrap()
}
