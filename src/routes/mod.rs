pub mod auth;
pub mod notes;
pub mod document_visibility;
pub mod categories;
pub mod tags;
pub mod web_info;
pub mod announcements;
pub mod talks;
pub mod upload;
pub mod gallery;
pub mod device_gateway;
pub mod image_generation;
pub mod temp_user;
pub mod knowledge;
pub mod chat;
mod chat_context;
pub mod conversation;
pub mod monitor;
pub mod sitemap;
pub mod graph;
pub mod stats;
pub mod profile;
pub mod notice;
pub mod todos;
pub mod quota;
mod pagination;
pub mod catalog;
pub mod own_reads;
pub mod public_catalog;
pub mod article_actions;
pub mod article_deletions;
pub mod talk_actions;
pub mod article_tag_actions;
pub mod category_actions;
pub mod account_actions;
pub mod tag_actions;
pub mod announcement_actions;
pub mod removal_actions;
pub mod notice_actions;
pub mod automation_results;
pub mod automation_announcements;
pub mod automation_changes;
pub mod quota_actions;
pub mod moderation_actions;
pub mod public_activity;
pub mod note_stats;
pub mod moderation;
pub mod comments;
pub mod comment_votes;
pub mod search;
pub mod note_tags;

pub mod rag_corpus;

use axum::{
    routing::{get, post, delete, put},
    Router,
    middleware,
    extract::DefaultBodyLimit,
};
use sea_orm::DatabaseConnection;
use tower_http::{cors::{Any, CorsLayer, AllowOrigin}, services::ServeDir};
use crate::utils::upload_dir;
use crate::rate_limiter::LoginRateLimiter;

pub struct AppState {
    pub db: DatabaseConnection,
    pub rate_limiter: LoginRateLimiter,
    pub post_limiter: crate::risk::PostRateLimiter,
    pub report_limiter: LoginRateLimiter,
}

pub(crate) fn db_error<T: Default>(
    what: &str,
    e: &sea_orm::DbErr,
) -> axum::Json<crate::utils::ApiResponse<T>> {
    tracing::error!("[db] {what} 失败: {e}");
    axum::Json(crate::utils::ApiResponse::error("服务暂时不可用，请稍后再试"))
}

pub fn create_router(state: AppState) -> Router {
    let cors_origins = std::env::var("CORS_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| crate::utils::site_url());
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
        .route(
            "/api/protected/profile",
            get(auth::profile).put(profile::update_profile),
        )
        .route("/api/protected/profile/password", put(profile::change_password))
        .route(
            "/api/protected/profile/avatar",
            post(profile::upload_avatar)
                .layer(DefaultBodyLimit::max(profile::AVATAR_MAX_BYTES * 2)),
        )
        .route(
            "/api/protected/favorites",
            get(profile::list_favorites).post(profile::add_favorite),
        )
        .route("/api/protected/favorites/{note_id}", delete(profile::remove_favorite))
        .route("/api/protected/notification-deletions/prepare", post(removal_actions::prepare_notifications))
        .route("/api/protected/notification-deletions", post(removal_actions::change_notifications))
        .route("/api/protected/notifications", get(profile::list_notifications))
        .route("/api/protected/notifications/{id}", delete(profile::delete_notification))
        .route("/api/protected/notifications/announcement", get(profile::pending_announcement))
        .route("/api/protected/notifications/summary", get(profile::notification_summary))
        .route("/api/protected/inbox/overview", get(profile::get_inbox_overview))
        .route("/api/protected/notifications/read", post(profile::read_notifications))
        .route("/api/protected/messages", get(profile::list_messages).post(profile::send_message))
        .route("/api/protected/messages/recent", get(profile::recent_messages))
        .route("/api/protected/messages/{id}", get(profile::message_detail).delete(profile::delete_message))
        .route("/api/protected/messages/read", post(profile::read_messages))
        .route(
            "/api/protected/messages/drafts",
            get(profile::list_drafts).post(profile::save_draft),
        )
        .route("/api/protected/messages/drafts/{id}", delete(profile::delete_draft))
        .route("/api/protected/my/talks", get(profile::list_my_talks))
        .route("/api/protected/quota", get(quota::get_my_quota))
        .route("/api/protected/quota/apply", post(quota::apply_quota_reset))
        .route("/api/protect/board/mine", get(talks::list_my_boards))
        .route("/api/protect/board/mine/{id}", delete(talks::delete_my_board))
        
        // Public Notes
        .route("/api/public/activity/announcements", get(public_activity::announcements::list))
        .route("/api/public/activity/guestbook", get(public_activity::messages::guestbook))
        .route("/api/public/activity/talks", get(public_activity::messages::talks))
        .route("/api/public/activity/search", post(public_activity::search::search)
            .layer(DefaultBodyLimit::max(8192)))
        .route("/api/public/articles", get(public_catalog::articles))
        .route("/api/public/categories", get(public_catalog::categories::list))
        .route("/api/public/tags", get(public_catalog::tags::list))
        .route("/api/public/image-generation/{id}/preview", get(image_generation::preview))
        .route("/api/public/notes", get(notes::list_public_notes))
        .route("/api/protected/agent/delegation", get(crate::auth_jwt::delegation::exchange))
        .route("/api/device-gateway/{*path}", axum::routing::any(device_gateway::proxy)
            .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/api/public/rag/corpus", get(rag_corpus::export))
        .route("/api/public/documents/validate", post(document_visibility::validate).layer(DefaultBodyLimit::max(32768)))
        .route("/api/public/notes/page", get(notes::list_public_notes)) 
        .route("/api/public/notes/search", post(notes::search_notes).layer(DefaultBodyLimit::max(4096)))
        .route("/api/public/search", post(search::search_all).layer(DefaultBodyLimit::max(2048)))
        .route("/api/public/notes/{id}", get(notes::get_note_detail))
        .route("/api/public/topnotes", get(notes::get_top_notes))

        .route("/api/public/notes/{id}/stats", get(note_stats::note_stats))
        .route("/api/public/notes/{id}/view", post(note_stats::report_view))
        .route(
            "/api/public/notes/{id}/like",
            post(note_stats::like_note).delete(note_stats::unlike_note),
        )
        
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
        
        
        // Talks（说说）：前台说说页仅展示 src=talk；/api/talk 保留全量（统计口径）
        .route("/api/talk", get(talks::list_all_talks))
        .route("/api/public/talk", get(talks::list_talks))
        // 河灯留言板（留言）：公开拉取，发布须登录，与说说各自独立（src=board）
        .route("/api/public/board", get(talks::list_boards).post(talks::create_board))

        .route(
            "/api/public/notes/{id}/comments",
            get(comments::list_comments).post(comments::create_comment),
        )
        .route("/api/public/comments/{id}", delete(comments::delete_my_comment))
        .route("/api/public/comments/{id}/vote", post(comment_votes::vote_comment))

        // Web/User Public
        .route("/api/public/user", get(web_info::get_user_info))
        .route("/api/public/social", get(web_info::get_social_info))
        
        // Agent Chat
        .route("/api/chat", post(chat::chat_handler))
        .route("/api/chat/stream", post(chat::chat_stream_handler))
        .route("/api/chat/service/status", get(chat::service_status))
        .route("/api/chat/tasks", get(chat::tasks_handler))
        .route("/api/chat/tasks/cancel", post(chat::cancel_task_handler))
        .route("/api/chat/schedules/cancel", post(chat::cancel_schedule_handler))
        .route("/api/chat/task/input", post(chat::task_input_handler))
        .route("/api/chat/task/inputs/status", post(chat::task_input_status_handler))
        .route("/api/chat/task/confirmation", post(chat::task_confirmation_handler))
        .route("/api/chat/confirmation/cancel", post(chat::cancel_handler))
        // 对话历史（DB 权威源，前端转跳/多窗口恢复；handler 内手写鉴权）
        .route("/api/chat/history/text", get(own_reads::history::list))
        .route("/api/protected/my/board/page", get(own_reads::board::list))
        .route("/api/chat/history", get(chat::chat_history_handler))
        .route("/api/chat/discard", post(chat::discard_handler))
        .route("/api/chat/search", get(conversation::search_chat_messages))
        .route("/api/chat/conversations", get(conversation::list_conversations).post(conversation::create_conversation))
        .route("/api/chat/conversations/{id}", delete(conversation::delete_conversation).patch(conversation::update_conversation))
        
        // Knowledge Base (GET public for agent)
        .route("/api/knowledge", get(knowledge::list_knowledge))

        .route("/api/monitor/log", post(monitor::report_log))

        .route("/api/public/graph/query", post(graph::graph_query))
        .route("/api/public/graph/manifest", get(graph::graph_manifest))
        // 文件名由 handler 白名单校验（`graph-<id>.js`），见 valid_artifact_name
        .route("/api/public/graph/artifact/{file}", get(graph::graph_artifact))
        
        .nest_service(
            "/api/protect/download",
            Router::new()
                .fallback_service(ServeDir::new(upload_dir()))
                .layer(middleware::from_fn(crate::middleware::download_headers)),
        );

    let protected_routes = Router::new()
        // Images
        .route("/api/protect/upload", upload::route())
        .route("/api/protect/images", get(upload::list_images))
        .route("/api/protect/image-generation/articles/{id}", get(image_generation::article_context))
        .route("/api/protect/image-generation/options", get(image_generation::options))
        .route("/api/protect/image-generation/jobs", get(image_generation::list).post(image_generation::create))
        .route("/api/protect/image-generation/jobs/{id}", get(image_generation::detail))
        .route("/api/protect/image-generation/jobs/{id}/approve", post(image_generation::approve))
        .route("/api/protect/image-generation/jobs/{id}/accept", post(image_generation::accept))
        .route("/api/protect/image-generation/jobs/{id}/reject", post(image_generation::reject))
        .route("/api/protect/gallery/images", get(gallery::list))
        .route("/api/protect/gallery/images/{id}", get(gallery::detail).put(gallery::metadata::change))
        .route("/api/protect/gallery/folders", get(gallery::folders::list).post(gallery::folders::create))
        .route("/api/protect/gallery/folders/{id}", delete(gallery::folders::remove))
        .route("/api/protect/gallery/articles/{id}/cover", get(gallery::covers::target).put(gallery::covers::change))
        .route("/api/protect/delImg", delete(upload::delete_images))
        .route("/api/protect/images/r2", get(upload::r2_usage))

        // Notes Protected
        // NEW ADMIN ROUTE for listing all notes
        .route("/api/protected/articles", get(catalog::articles::list))
        .route("/api/protected/accounts", get(catalog::accounts::list))
        .route("/api/protected/notes/list", get(notes::list_all_notes))
        .route("/api/protected/notes/search", post(notes::search_all_notes))
        
        .route("/api/protected/notes", 
            post(notes::create_note)
            .delete(notes::delete_note)
        )
        .route("/api/protected/moderation/{resource}/{id}/target", get(moderation_actions::target))
        .route("/api/protected/moderation/{resource}/{id}/action", post(moderation_actions::apply))
        .route("/api/protected/quota/actions/requests/{id}", get(quota_actions::request_target))
        .route("/api/protected/quota/actions/accounts/{id}", get(quota_actions::account_target))
        .route("/api/protected/quota/actions/requests/{id}/review", post(quota_actions::review))
        .route("/api/protected/quota/actions/accounts/{id}/reset", post(quota_actions::reset))
        .route("/api/protected/article-tag-actions/batch/prepare", post(article_tag_actions::batch::prepare))
        .route("/api/protected/article-tag-actions/batch", post(article_tag_actions::batch::change))
        .route("/api/protected/article-tag-actions/{id}/prepare", post(article_tag_actions::prepare))
        .route("/api/protected/article-tag-actions/{id}", post(article_tag_actions::change))
        .route("/api/protected/article-deletions/prepare", post(article_deletions::prepare))
        .route("/api/protected/article-deletions", post(article_deletions::change))
        .route("/api/protected/talk-actions/prepare", post(talk_actions::prepare))
        .route("/api/protected/talk-actions", get(talk_actions::list).post(talk_actions::change))
        .route("/api/protect/gallery/folder-actions/prepare", post(gallery::folder_actions::prepare))
        .route("/api/protect/gallery/folder-actions", post(gallery::folder_actions::change))
        .route("/api/protected/article-actions/batch/prepare", post(article_actions::batch::prepare))
        .route("/api/protected/article-actions/batch", post(article_actions::batch::change))
        .route("/api/protected/article-actions/{id}", get(article_actions::target).post(article_actions::change))
        .route("/api/protected/notes/{id}",
            post(notes::update_note)
        )

        // Administrator-owned todo lists and version-bound single-item actions.
        .route(
            "/api/protected/todos",
            get(todos::list_todos).put(todos::save_todos),
        )
        .route("/api/protected/todos/item", post(todos::add_todo))
        .route("/api/protected/todos/item/{id}", get(todos::get_todo).delete(todos::delete_todo))
        .route("/api/protected/todos/batch/prepare", post(todos::prepare_deletions))
        .route("/api/protected/todos/batch", delete(todos::delete_todos))

        .route("/api/protect/comments", get(comments::list_comments_admin))
        .route("/api/protect/comments/{id}/audit", put(comments::audit_comment))
        .route("/api/protect/comments/{id}", delete(comments::delete_comment_admin))
        .route("/api/protected/todos/done", post(todos::set_todo_done))
        .route("/api/protected/todos/date", post(todos::set_todo_date))

        .route("/api/protected/draft/autosave", post(notes::autosave_note))
        .route("/api/protected/draft/editor/{id}", get(notes::get_note_for_edit))

        .route("/api/protected/tag-actions/prepare", post(tag_actions::prepare))
        .route("/api/protected/tag-actions", post(tag_actions::change))
        .route("/api/protected/automation-actor", get(automation_results::actor))
        .route("/api/protected/automation-results", post(automation_results::deliver))
        .route("/api/protected/automation-announcements", post(automation_announcements::publish))
        .route("/api/protected/automation-changes", post(automation_changes::change))
        .route("/api/protected/notice-actions/prepare", post(notice_actions::prepare))
        .route("/api/protected/notice-actions", post(notice_actions::change))
        .route("/api/protected/announcement-deletions/prepare", post(removal_actions::prepare_announcements))
        .route("/api/protected/announcement-deletions", post(removal_actions::change_announcements))
        .route("/api/protected/announcement-actions/prepare", post(announcement_actions::prepare))
        .route("/api/protected/announcement-actions", post(announcement_actions::change))
        .route("/api/protected/account-actions/prepare", post(account_actions::prepare))
        .route("/api/protected/account-actions", post(account_actions::change))
        .route("/api/protected/category-actions/prepare", post(category_actions::prepare))
        .route("/api/protected/category-actions", post(category_actions::change))

        // Categories
        .route("/api/protected/category", 
             post(categories::create_category)
             .delete(categories::delete_category) 
        )
        .route("/api/protected/category/{id}", 
             post(categories::update_category)
        )

        // Tags
        .route("/api/protected/tagone", post(tags::create_tag_one))
        .route("/api/protected/tagtwo", post(tags::create_tag_two))
        .route("/api/protected/tag", delete(tags::delete_tags))
        .route("/api/protected/tag/move", post(tags::move_tag))
        .route("/api/protected/announcements", post(announcements::create_announcement).delete(announcements::delete_announcement))
        .route("/api/protected/announcements/{id}", put(announcements::update_announcement))
        .route("/api/protected/tagone/{id}", put(tags::update_tag_one))
        .route("/api/protected/tagtwo/{id}", put(tags::update_tag_two))

        // Talks
        .route("/api/protect/talk", post(talks::create_talk))
        .route("/api/protect/talk/{id}",
             delete(talks::delete_talk)
             .put(talks::update_talk)
        )

        // 留言管理（后台）：河灯留言列表/删除/内容审核（审核机制预留，暂未启用）
        .route("/api/protect/board", get(talks::list_board_admin))
        .route("/api/protected/moderation/summary", get(moderation::overview))
        .route("/api/protect/board/{id}", delete(talks::delete_board))
        .route("/api/protect/board/{id}/audit", put(talks::audit_board))

        // Knowledge Base (write/admin)
        .route("/api/knowledge", post(knowledge::add_knowledge))
        .route("/api/knowledge/{id}", delete(knowledge::delete_knowledge))
        
        // Temp Users
        .route("/api/temp-users", get(temp_user::list_temp_users).post(temp_user::create_temp_user))
        .route("/api/temp-users/{id}", delete(temp_user::delete_temp_user))
                .route("/api/temp-users/{id}/password", post(temp_user::change_password))
                .route("/api/temp-users/{id}/password-reset-token", post(temp_user::create_password_reset_token))
                .route("/api/temp-users/{id}/status", post(temp_user::set_user_status))
                .route("/api/temp-users/{id}/role", post(temp_user::set_user_role))
                .route("/api/temp-users/{id}/notice", post(temp_user::send_user_notice))
                .route("/api/temp-users/{id}/quota-reset", post(quota::reset_user_quota))
                .route("/api/temp-users/{id}/mute", post(temp_user::set_user_muted))

        .route("/api/protected/quota/requests", get(quota::list_quota_requests))
        .route(
            "/api/protected/quota/requests/{id}/review",
            post(quota::review_quota_request),
        )
        
        .route("/api/protected/stats/users", get(stats::user_stats))
        .route("/api/protected/stats/notes", get(note_stats::note_report))
        .route("/api/protected/stats/notes/periods", get(note_stats::note_period_report))

        .route("/api/protected/graph/rebuild", post(graph::rebuild_start))
        .route("/api/protected/graph/rebuild/status", get(graph::rebuild_status))
        .route("/api/protected/graph/rebuild/cancel", post(graph::rebuild_cancel))

        // WebSettings
        .route("/api/protected/websetting",
            get(web_info::get_web_settings)
            .post(web_info::update_web_info)
        )
        .route("/api/protected/social", put(web_info::update_social_info))
        
        .route_layer(middleware::from_fn_with_state(state_arc.clone(), crate::middleware::auth_guard));

    let app = public_routes
        .merge(protected_routes)
        .layer(middleware::from_fn(crate::auth_jwt::delegation::boundary))
        .layer(cors)
        .with_state(state_arc);
    crate::observability::http(app)
}

#[cfg(test)]
mod authorization_tests;
