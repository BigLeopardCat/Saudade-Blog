pub mod entity;
pub mod routes;
pub mod utils;
pub mod middleware;
pub mod rate_limiter;
pub mod authz;
// 用户对话额度（20260929）：上限与「每轮扣一轮」的唯一落点，chat.rs 与 routes/quota.rs 共用
pub mod quota;
// 内容风控与分级禁言（20261002）：发评论 / 发留言共用的入口闸。阈值住 web_info（KV），
// 窗口计数查库、最小间隔走内存，判据只在 risk::screen 一处（见模块头注）
pub mod risk;

pub use routes::{create_router, AppState};
pub mod auth_jwt;
