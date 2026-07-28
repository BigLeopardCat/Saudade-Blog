pub mod auth;
pub mod notes;
pub mod categories;
pub mod tags;
pub mod friends;
pub mod web_info;
pub mod announcements;
pub mod talks;
pub mod upload;
pub mod knowledge;
pub mod chat;

use axum::{
    routing::{get, post, delete, put},
    Router,
    middleware,
};
use sea_orm::DatabaseConnection;
use tower_http::{cors::{Any, CorsLayer}, services::ServeDir};
use crate::utils::upload_dir;

pub struct AppState {
    pub db: DatabaseConnection,
}

pub fn create_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    
    let state_arc = std::sync::Arc::new(state);

    let public_routes = Router::new()
        // Auth
        .route("/api/login", post(auth::login))
        
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
        
        // Friends
        .route("/api/friends", get(friends::list_friends)) 
        .route("/api/public/friends", get(friends::list_public_friends)
            .post(friends::create_friend))
        
        // Talks
        .route("/api/talk", get(talks::list_talks))
        .route("/api/public/talk", get(talks::list_talks))

        // Web/User Public
        .route("/api/public/user", get(web_info::get_user_info))
        .route("/api/public/social", get(web_info::get_social_info))
        
        // Agent Chat
        .route("/api/chat", post(chat::chat_handler))
        
        // Knowledge Base
        .route("/api/knowledge", get(knowledge::list_knowledge).post(knowledge::add_knowledge))
        .route("/api/knowledge/:id", delete(knowledge::delete_knowledge))
        
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

        // WebSettings
        .route("/api/protected/websetting", 
            get(web_info::get_web_settings)
            .post(web_info::update_web_info)
        )
        .route("/api/protected/social", put(web_info::update_social_info))
        
        .route_layer(middleware::from_fn(crate::middleware::auth_guard));

    public_routes
        .merge(protected_routes)
        .layer(cors)
        .with_state(state_arc)
}
