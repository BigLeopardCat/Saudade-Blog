pub mod auth;
pub mod notes;
pub mod categories;
pub mod tags;
pub mod friends;
pub mod web_info;
pub mod announcements;
pub mod talks;
pub mod upload;
pub mod temp_user;
pub mod knowledge;
pub mod chat;
pub mod monitor;
pub mod sitemap;

use axum::{
    routing::{get, post, delete, put},
    Router,
    middleware,
};
use sea_orm::DatabaseConnection;
use tower_http::{cors::{Any, CorsLayer, AllowOrigin}, services::ServeDir};
use crate::utils::upload_dir;
use crate::rate_limiter::LoginRateLimiter;

pub struct AppState {
    pub db: DatabaseConnection,
    pub rate_limiter: LoginRateLimiter,
}

pub fn create_router(state: AppState) -> Router {
    // H5 修复：CORS 白名单。默认仅允许博客域名，可通过 CORS_ALLOWED_ORIGINS 环境变量
    // 追加多个来源（逗号分隔，如 "https://saudade.site,http://localhost:5173"）
    let cors_origins = std::env::var("CORS_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "https://saudade.site".to_string());
    let origins: Vec<axum::http::HeaderValue> = cors_origins
        .split(',')
        .filter_map(|s| {
            let s = s.trim();
            if s.is_empty() { return None; }
            axum::http::HeaderValue::try_from(s).ok()
        })
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods(Any)
        .allow_headers(Any);
    
    let state_arc = std::sync::Arc::new(state);

    let public_routes = Router::new()
        // Auth
        .route("/api/login", post(auth::login))
        // 当前登录用户信息（自身鉴权，不经过 admin 守卫）：留言留名预填
        .route("/api/protected/profile", get(auth::profile))
        
        // Public Notes
        .route("/api/public/notes", get(notes::list_public_notes))
        .route("/api/public/notes/page", get(notes::list_public_notes)) 
        .route("/api/public/notes/search", post(notes::search_notes))
        .route("/api/public/notes/:id", get(notes::get_note_detail))
        .route("/api/public/topnotes", get(notes::get_top_notes))
        
        // Categories
        .route("/api/category", get(categories::list_categories)) 
        .route("/api/public/category", get(categories::list_categories)) 
        
        // Tags
        .route("/api/tagone", get(tags::list_tags_one)) 
        .route("/api/tagtwo", get(tags::list_tags_two)) 
        .route("/api/public/tagone", get(tags::list_tags_one)) 
        .route("/api/public/tagtwo", get(tags::list_tags_two)) 
        .route("/api/public/announcements", get(announcements::list_announcements))
        .route("/sitemap.xml", get(sitemap::sitemap_xml))
        
        // Friends
        .route("/api/friends", get(friends::list_friends))
        // A6 修复：下线公开 POST（友链申请只走管理员后台 /api/protected/friend），杜绝匿名提交 javascript: 协议 XSS
        .route("/api/public/friends", get(friends::list_public_friends))
        
        // Talks（说说）：前台说说页仅展示 src=talk；/api/talk 保留全量（统计口径）
        .route("/api/talk", get(talks::list_all_talks))
        .route("/api/public/talk", get(talks::list_talks))
        // 河灯留言板（留言）：公开拉取，发布须登录，与说说各自独立（src=board）
        .route("/api/public/board", get(talks::list_boards).post(talks::create_board))

        // Web/User Public
        .route("/api/public/user", get(web_info::get_user_info))
        .route("/api/public/social", get(web_info::get_social_info))
        
        // Agent Chat
        .route("/api/chat", post(chat::chat_handler))
        .route("/api/chat/stream", post(chat::chat_stream_handler))
        // 对话历史（DB 权威源，前端转跳/多窗口恢复；handler 内手写鉴权）
        .route("/api/chat/history", get(chat::chat_history_handler))
        // 主动停止丢弃本轮（前端"停止生成"按钮显式调用，全删 user+残缺回复）
        .route("/api/chat/discard", post(chat::discard_handler))
        
        // Knowledge Base (GET public for agent)
        .route("/api/knowledge", get(knowledge::list_knowledge))

        // 前端错误上报（20260830，监控补齐 B）：匿名可写，body 上限 8KB
        .route("/api/monitor/log", post(monitor::report_log))
        
        // Static Image Download (Public)
        .nest_service("/api/protect/download", ServeDir::new(upload_dir()))
        .nest_service("/christmas", ServeDir::new("/opt/memory_blog_rust/static/christmas"));

    let protected_routes = Router::new()
        // Images
        .route("/api/protect/upload", post(upload::upload_image))
        .route("/api/protect/images", get(upload::list_images))
        .route("/api/protect/delImg", delete(upload::delete_images))

        // Notes Protected
        // NEW ADMIN ROUTE for listing all notes
        .route("/api/protected/notes/list", get(notes::list_all_notes))
        .route("/api/protected/notes/search", post(notes::search_all_notes))
        
        .route("/api/protected/notes", 
            post(notes::create_note)
            .delete(notes::delete_note)
        )
        .route("/api/protected/notes/:id", 
            post(notes::update_note) 
        )

        // Categories
        .route("/api/protected/category", 
             post(categories::create_category)
             .delete(categories::delete_category) 
        )
        .route("/api/protected/category/:id", 
             post(categories::update_category)
        )

        // Tags
        .route("/api/protected/tagone", post(tags::create_tag_one))
        .route("/api/protected/tagtwo", post(tags::create_tag_two))
        .route("/api/protected/tag", delete(tags::delete_tags))
        .route("/api/protected/announcements", post(announcements::create_announcement).delete(announcements::delete_announcement))
        .route("/api/protected/announcements/:id", put(announcements::update_announcement))
        .route("/api/protected/tagone/:id", put(tags::update_tag_one))
        .route("/api/protected/tagtwo/:id", put(tags::update_tag_two))

        // Friends
        .route("/api/protected/friend", post(friends::create_friend)) 
        .route("/api/protected/friends", 
             delete(friends::delete_friends) 
        )
         .route("/api/protected/friend/:id",
            delete(friends::delete_friend)
            .put(friends::update_friend) 
        )
        .route("/api/protected/friends/:id", 
             post(friends::update_friend) 
        )

        // Talks
        .route("/api/protect/talk", post(talks::create_talk))
        .route("/api/protect/talk/:id",
             delete(talks::delete_talk)
             .put(talks::update_talk)
        )

        // 留言管理（后台）：河灯留言列表/删除/内容审核（审核机制预留，暂未启用）
        .route("/api/protect/board", get(talks::list_board_admin))
        .route("/api/protect/board/:id", delete(talks::delete_board))
        .route("/api/protect/board/:id/audit", put(talks::audit_board))

        // Knowledge Base (write/admin)
        .route("/api/knowledge", post(knowledge::add_knowledge))
        .route("/api/knowledge/:id", delete(knowledge::delete_knowledge))
        
        // Temp Users
        .route("/api/temp-users", get(temp_user::list_temp_users).post(temp_user::create_temp_user))
        .route("/api/temp-users/:id", delete(temp_user::delete_temp_user))
          .route("/api/temp-users/:id/password", post(temp_user::change_password))
        
        // WebSettings
        .route("/api/protected/websetting", 
            get(web_info::get_web_settings)
            .post(web_info::update_web_info)
        )
        .route("/api/protected/social", put(web_info::update_social_info))
        
        .route_layer(middleware::from_fn_with_state(state_arc.clone(), crate::middleware::auth_guard));

    public_routes
        .merge(protected_routes)
        .layer(cors)
        // 20260830：全局 access 日志（后调用的 layer 最外层，先处理请求）；见 middleware.rs
        .layer(middleware::from_fn(crate::middleware::access_log))
        .with_state(state_arc)
}
