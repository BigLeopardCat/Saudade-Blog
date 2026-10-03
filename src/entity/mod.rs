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
// 会话级任务状态（20260927）：未完成的意图跨轮不丢，与 execution_log 对偶
pub mod agent_task;
// 额度重置申请（20260929）：与 user.chat_quota_used 是一对——这张表装「请求」，
// 那个列装「事实」，批准是唯一把两者连起来的动作
pub mod quota_request;
// 文章阅读量 / 点赞量（20260930）：按天聚合的阅读数 + 一人一行不可重复的点赞
pub mod note_view;
pub mod note_like;
// 文章评论（20261002）：两层结构（评论 + 回复），与河灯留言板是两张表——
// 评论挂文章、留言挂留言板，各自的展示列与读取路径完全不同（见 entity/note_comment.rs）
pub mod note_comment;
// 评论点赞/踩（20261003）：一票一行、两种身份并排，形制照 note_like 那张（见该文件头注）
pub mod note_comment_vote;
