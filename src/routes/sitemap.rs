//! sitemap.xml 动态生成（SEO）：固定页面 + 分类 + 公开文章。
//! 挂载于 /sitemap.xml（nginx 放行到 3000），文章/分类变化时爬虫自动重新抓取。

use axum::{
    extract::State,
    http::header,
    response::Response,
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use std::sync::Arc;

use crate::entity::{category, note};
use crate::routes::AppState;

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 日期转 sitemap lastmod 格式（YYYY-MM-DD，UTC 与本地一致即可——仅用于爬虫提示）
fn lastmod(dt: &chrono::NaiveDateTime) -> String {
    dt.format("%Y-%m-%d").to_string()
}

pub async fn sitemap_xml(State(st): State<Arc<AppState>>) -> Response {
    // 本站地址不再写死：别人部署时 `<loc>` 必须指向自己的域名，否则爬虫被引到别人的站
    // （20261001 开源前准备）。默认值仍是本站，见 `utils::site_url`。
    let site = crate::utils::site_url();

    // 固定页面（优先级高）。物联网控制台是**可选件**（源码收在仓库 `iot/`，装不装由
    // 部署者决定，见 `utils::iot_enabled`）：没装时列出来就是给爬虫一个 404，而那正是
    // 本站"开源后别人照着部署"最容易踩的一处——所以按开关收，不写死在表里。
    let mut static_urls: Vec<(&str, &str)> = vec![
        ("/", "1.0"),
        ("/times", "0.9"),
        ("/talk", "0.8"),
        ("/guestbook", "0.8"),
        ("/about", "0.8"),
    ];
    if crate::utils::iot_enabled() {
        static_urls.push(("/device-console/", "0.7"));
    }

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
            "  <url><loc>{site}{}</loc><changefreq>daily</changefreq><priority>{}</priority></url>\n",
            xml_escape(path),
            prio
        ));
    }
    for c in &cats {
        if !c.name.is_empty() {
            body.push_str(&format!(
                "  <url><loc>{site}/category/{}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>\n",
                xml_escape(&c.name)
            ));
        }
    }
    for n in &notes {
        body.push_str(&format!(
            "  <url><loc>{site}/article/{}</loc><lastmod>{}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n",
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
