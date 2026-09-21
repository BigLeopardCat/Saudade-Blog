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
pub mod conversation;
pub mod monitor;
pub mod sitemap;
pub mod graph;
pub mod stats;

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
        .route("/api/password/reset", post(auth::reset_password))
        // 当前登录用户信息（自身鉴权，不经过 admin 守卫）：留言留名预填
        .route("/api/protected/profile", get(auth::profile))
        // 我的河灯（20260905 issue8）：本人河灯列表/收回——普通登录用户专用，
        // 必须挂在 admin 守卫之外（守卫域内全部接口仅管理员可用，见 protected_routes
        // 末尾 route_layer；handler 内部 current_uid 自身鉴权，同 profile 先例）
        .route("/api/protect/board/mine", get(talks::list_my_boards))
        .route("/api/protect/board/mine/:id", delete(talks::delete_my_board))
        
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
        // 消息级内容检索（20260903f：命中轮次列表形态；点行 → 切会话定位消息）
        .route("/api/chat/search", get(conversation::search_chat_messages))
        // 会话管理（20260903 会话化；handler 内手写鉴权同 chat 系）
        .route("/api/chat/conversations", get(conversation::list_conversations).post(conversation::create_conversation))
        .route("/api/chat/conversations/:id", delete(conversation::delete_conversation).patch(conversation::update_conversation))
        
        // Knowledge Base (GET public for agent)
        .route("/api/knowledge", get(knowledge::list_knowledge))

        // 前端错误上报（20260830，监控补齐 B）：匿名可写，body 上限 8KB
        .route("/api/monitor/log", post(monitor::report_log))

        // 展示柜图谱向量检索（20260915）：挂公开路由但 **handler 内要求登录**——
        // protected_routes 那条链路是后台管理用的（auth_guard 全 admin），
        // 而这里任何登录用户都该能用；查询要花 embedding 调用，也不能真匿名开放。
        .route("/api/public/graph/query", post(graph::graph_query))
        
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

        // 编辑草稿（20260912c）：自动保存 + 编辑器专用读入口
        // 读入口单独开是因为公开的 GET /api/public/notes/:id 会挡掉草稿/私密文章（A4 修复），
        // 草稿箱里点开一篇草稿会 404。写法上用独立前缀 /api/protected/draft/，
        // 不跟 /api/protected/notes/:id 的静态段/参数段混在同一层。
        .route("/api/protected/draft/autosave", post(notes::autosave_note))
        .route("/api/protected/draft/editor/:id", get(notes::get_note_for_edit))

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
                .route("/api/temp-users/:id/password-reset-token", post(temp_user::create_password_reset_token))
        
        // 只读统计（20260921）：agent「管理助手」的用户数据报表供数。
        // 挂在守卫域内 ⇒ 自动只有 admin 拿得到（agent 以发起人身份代调，见 routes/stats.rs 头注）。
        // 独立前缀 /api/protected/stats/ 而不塞进某个既有资源下：它是聚合视图，
        // 不属于 notes/tags/users 任何一族的 CRUD。
        .route("/api/protected/stats/users", get(stats::user_stats))

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
