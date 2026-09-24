pub mod user;
pub mod note;
pub mod category;
pub mod tag_one;
pub mod tag_two;
pub mod friend;
pub mod talk;
pub mod web_info;
pub mod announcement;
pub mod image;
pub mod knowledge_base;
pub mod chat_history;
pub mod chat_summary;
pub mod execution_log;
pub mod conversation;
pub mod password_reset_token;
// 个人中心一期（20260922）：收藏 / 通知 / 信箱
pub mod user_favorite;
pub mod user_notification;
pub mod user_message;
// 站内信草稿（20260923）
pub mod user_message_draft;
// 跨轮待办（20260923）：确认弹窗那一轮的结构化提议落库，下轮注入 planner
pub mod pending_action;
// 后台首页待办（20260924）：整份列表按用户落库（此前只在浏览器 localStorage 里）
pub mod dashboard_todo;
