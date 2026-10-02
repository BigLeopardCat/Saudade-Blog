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
pub mod profile;  // 个人中心一期（20260922）
pub mod notice;   // 单用户站内通知（20260923；留言审核结果的首个生产者）
pub mod todos;    // 后台首页待办（20260924；整份列表按用户落库）
pub mod quota;    // 用户对话额度（20260929；上限与算术在 crate::quota，本模块只管读写）
pub mod note_stats; // 文章阅读量/点赞量（20260930；**绝不能记进 get_note_detail**，见模块头注）
pub mod comments;   // 文章评论（20261002）：审核复用 talks::decide_review，存储走 note_comment 表

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
}

pub fn create_router(state: AppState) -> Router {
    // H5 修复：CORS 白名单。默认仅允许博客域名，可通过 CORS_ALLOWED_ORIGINS 环境变量
    // 追加多个来源（逗号分隔，如 "https://example.com,http://localhost:5173"）。
    //
    // 20261001 开源前准备：默认值不再写死本站域名，改用 `SITE_URL`（与 sitemap 的
    // `<loc>` 前缀同源，见 `utils::site_url`）—— 别人部署只要设了 SITE_URL，
    // 前端就不必再单独配一遍 CORS_ALLOWED_ORIGINS。
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
        // 当前登录用户信息（自身鉴权，不经过 admin 守卫）：留言留名预填
        // 个人中心一期（20260922）：用户设置 / 收藏 / 通知（红点）/ 站内信箱 / 我的留言记录。
        // **与 profile 同一条纪律**：挂在 admin 守卫之外、handler 内部自身鉴权——
        // 这些能力面向任意登录用户，而 protected_routes 域内全部接口仅管理员可用。
        // 头像上传单独放开 body 上限：axum 默认 2MiB 会在 extractor 层直接 413（英文），
        // 放开到 4MiB 由 handler 自己按 2MiB 判，好给出中文原因（见 profile.rs 头注）。
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
        .route("/api/protected/favorites/:note_id", delete(profile::remove_favorite))
        .route("/api/protected/notifications", get(profile::list_notifications))
        .route("/api/protected/notifications/summary", get(profile::notification_summary))
        .route("/api/protected/notifications/read", post(profile::read_notifications))
        .route("/api/protected/messages", get(profile::list_messages).post(profile::send_message))
        .route("/api/protected/messages/read", post(profile::read_messages))
        // 草稿箱（20260923）：同一个 handler 按有无 id 决定新建/更新，所以 GET 与 POST 同路径
        .route(
            "/api/protected/messages/drafts",
            get(profile::list_drafts).post(profile::save_draft),
        )
        .route("/api/protected/messages/drafts/:id", delete(profile::delete_draft))
        .route("/api/protected/my/talks", get(profile::list_my_talks))
        // 对话额度（20260929）：个人中心「对话额度」页签——看现状 + 提交重置申请。
        // 与 profile 同一条纪律：挂公开路由、handler 内部自身鉴权（查的/写的都是
        // 本人自己的那一行，没有 uid 参数可传 ⇒ 越权在结构上不可能）。
        .route("/api/protected/quota", get(quota::get_my_quota))
        .route("/api/protected/quota/apply", post(quota::apply_quota_reset))
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

        // 文章阅读量/点赞量（20260930）：**与详情端点分开**是硬要求——详情端点被 agent
        // 的 get_article_detail 工具频繁读取，把计数挂在那儿等于给看板娘自己刷阅读量
        // （见 routes/note_stats.rs 头注第一条）。
        // `view` 是匿名可写（同 `/api/monitor/log` 的先例）：读者不需要登录就能被计数，
        // 前端按天去重、这里只收数。`like` 需要登录，但**必须挂公开路由**——
        // 挂进守卫域会被 auth_guard 按管理员判据把普通用户全部 403。
        // 三条都不返回 401（前端 axios 拦截器见 401 就清 token 跳登录页）。
        .route("/api/public/notes/:id/stats", get(note_stats::note_stats))
        .route("/api/public/notes/:id/view", post(note_stats::report_view))
        .route(
            "/api/public/notes/:id/like",
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
        
        // Friends
        .route("/api/friends", get(friends::list_friends))
        // A6 修复：下线公开 POST（友链申请只走管理员后台 /api/protected/friend），杜绝匿名提交 javascript: 协议 XSS
        .route("/api/public/friends", get(friends::list_public_friends))
        
        // Talks（说说）：前台说说页仅展示 src=talk；/api/talk 保留全量（统计口径）
        .route("/api/talk", get(talks::list_all_talks))
        .route("/api/public/talk", get(talks::list_talks))
        // 河灯留言板（留言）：公开拉取，发布须登录，与说说各自独立（src=board）
        .route("/api/public/board", get(talks::list_boards).post(talks::create_board))

        // 文章评论（20261002）：读取**不要求登录**（文章详情页本身是公开的，讨论区跟着它，
        // 未登录时 mine 恒 false）；发布与自删要求登录（handler 内自己 auth）。
        // ⚠️ 这三条必须留在 public_routes：protected_routes 域内由 auth_guard 全量要求
        // 管理员，挂过去就是普通用户 403（评论区对全体访客关闭）。
        .route(
            "/api/public/notes/:id/comments",
            get(comments::list_comments).post(comments::create_comment),
        )
        .route("/api/public/comments/:id", delete(comments::delete_my_comment))

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

        // 后台首页待办（20260924）：待办卡此前只存浏览器 localStorage，现按用户落库。
        // 前端那张卡 = 整份列表覆盖（GET 读 / PUT 写），取舍见 routes/todos.rs 头注。
        .route(
            "/api/protected/todos",
            get(todos::list_todos).put(todos::save_todos),
        )
        // 追加一条（20260926）：agent 安排日程用的通道——它手里没有那份列表，
        // 整份覆盖会抹掉主人的改动，所以单独给一条"只加不覆盖"的接口。
        .route("/api/protected/todos/item", post(todos::add_todo))

        // 评论管理（20261002）：文章详情页讨论区的裁决队列，挂在 admin 守卫域内（后台页面用）。
        // 公开那三条在 public_routes（见上方注），**这里的三条与它们不是一回事**：
        // 那三条是给访客读、给作者写/自删的，这三条只给管理员。
        .route("/api/protect/comments", get(comments::list_comments_admin))
        .route("/api/protect/comments/:id/audit", put(comments::audit_comment))
        .route("/api/protect/comments/:id", delete(comments::delete_comment_admin))
        // 翻完成标记（20260926）：同一族的第二条最小通道——按**正文**认出唯一那一行、
        // 只翻它的 done（查无此条/有多条一律零写，判据见 todos.rs 的 pick_todo）。
        .route("/api/protected/todos/done", post(todos::set_todo_done))
        // 改排期（20260929）：同一族的第三条最小通道——按**正文**认出唯一那一行、
        // 只改它的 due_date（传 null/空串 = 清空排期；判据同 pick_todo）。
        .route("/api/protected/todos/date", post(todos::set_todo_date))

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
        // 换父级 / 一级↔二级互转（20260921）。独立路径而非塞进 PUT /tagtwo/:id：
        // access_log 只有一行 `POST path=`，藏在改名接口里就分不清"改了个名"和"重写了
        // 几百篇文章的 note.tags"；且它的契约与改名不同（可能改 id、可能被拒）。
        .route("/api/protected/tag/move", post(tags::move_tag))
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
                // 冻结 / 解冻（20260926）：挂在同一族下——它就是账号管理页第二个按钮，
                // 与改密码/恢复码同一批操作、同一份权限（auth_guard 只放管理员）
                .route("/api/temp-users/:id/status", post(temp_user::set_user_status))
                // 变更身份（20260926）：同一族，但判据更严——只有超级管理员能发起
                // （`authz::check_role_change` 第一条）。挂在这里是为了共用 auth_guard，
                // **不是**因为权限等同：能进这一族 ≠ 能改身份。
                .route("/api/temp-users/:id/role", post(temp_user::set_user_role))
                // 发通知（20260926）：挂同一族——它就是账号管理页第三个按钮，与
                // 冻结/改密码同一份权限（auth_guard 只放管理员）。目标是"列表里可见的
                // 账号"（`authz::is_listable_role`），所以**超管收不到**这条通道的东西。
                .route("/api/temp-users/:id/notice", post(temp_user::send_user_notice))
                // 重置额度（20260929）：同一族的第四个动作——账号管理页那一行的
                // 「重置额度」按钮与 agent 的 `reset_user_quota` 工具共用它。
                // **不需要对方申请过**（与"批准申请"的分工见 routes/quota.rs 头注）。
                // handler 住在 routes/quota.rs 而不是 temp_user.rs：额度那件事
                // （上限怎么算、通知怎么写、不限额怎么办）只有那一处实现。
                .route("/api/temp-users/:id/quota-reset", post(quota::reset_user_quota))

        // 对话额度审核（20260929）：后台「额度管理」页签与 agent 的
        // `list_quota_requests` / `approve_quota_request` 等工具共用的两条。
        // 挂守卫域内 ⇒ 自动只有 admin 拿得到（agent 以发起人身份代调，
        // 见 routes/stats.rs 头注的同一形态）。
        .route("/api/protected/quota/requests", get(quota::list_quota_requests))
        .route(
            "/api/protected/quota/requests/:id/review",
            post(quota::review_quota_request),
        )
        
        // 只读统计（20260921）：agent「管理助手」的用户数据报表供数。
        // 挂在守卫域内 ⇒ 自动只有 admin 拿得到（agent 以发起人身份代调，见 routes/stats.rs 头注）。
        // 独立前缀 /api/protected/stats/ 而不塞进某个既有资源下：它是聚合视图，
        // 不属于 notes/tags/users 任何一族的 CRUD。
        .route("/api/protected/stats/users", get(stats::user_stats))
        // 文章报表（20260930）：后台 /dashboard/analytics 的供数端点。同一前缀同一纪律
        // ——挂守卫域内 ⇒ 只有 admin 拿得到。**不是**给 agent 的工具供数（那份是 users）。
        .route("/api/protected/stats/notes", get(note_stats::note_report))
        // 周报/月报/年报（20261001）：同一份数据的**分期**视图（?kind=week|month|year）。
        // 与上面那条同前缀不同路径，不是它的子资源——上面是"当下快照"，
        // 这条是"每期一行的历史"，两条的缓存/刷新语义都不一样。
        .route("/api/protected/stats/notes/periods", get(note_stats::note_period_report))

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
