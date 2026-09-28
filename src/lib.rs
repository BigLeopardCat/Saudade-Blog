pub mod entity;
pub mod routes;
pub mod utils;
pub mod middleware;
pub mod rate_limiter;
pub mod authz;
// 用户对话额度（20260929）：上限与「每轮扣一轮」的唯一落点，chat.rs 与 routes/quota.rs 共用
pub mod quota;

pub use routes::{create_router, AppState};
pub mod auth_jwt;
