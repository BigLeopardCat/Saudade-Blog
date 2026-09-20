//! 权限模型（角色 / scope）——Rust 侧的声明表（20260920，秘书类功能地基）。
//!
//! **这是跨语言契约的一端**：角色名与 scope 名必须与 agent 侧
//! `saudade-blog-agent/agent/authz.py` 一致（改一侧须同步另一侧 + 两侧单测）。
//! 这里放 Rust 侧真正需要判断的那部分——`user.role` 的取值域与后台准入，
//! 以及给 agent 的身份断言里携带的角色；工具级的 scope 判据在 agent 侧
//! （工具都在那边执行），Rust 侧不重复实现一份判据。
//!
//! 为什么要有这个模块（而不是继续散落的字面量）：
//! `middleware.rs` 里 `u.role == "admin"`、`temp_user.rs` 里 `"user"` 是**同一
//! 个取值域的两处硬编码**——秘书角色要进来时，这种散落就是漂移的来源。
//! 现在取值域只在本模块声明，判据点引用常量。

/// 博主本人：后台全权（`auth_guard` 当前只认它）。
pub const ROLE_ADMIN: &str = "admin";

/// 秘书：可以读他人数据、可以代博主做写操作，但**进不了后台管理面**
/// （`ROLE_ADMIN` 是后台准入的唯一角色；秘书的能力边界在 agent 侧的 scope 表里
/// 表达，不在后台路由上表达）。
pub const ROLE_SECRETARY: &str = "secretary";

/// 普通访客 / 体验账号：只读公开内容、操作自己的设备与自己的页面。
pub const ROLE_USER: &str = "user";

/// `user.role` 的取值域（DB 列无 ENUM/CHECK 约束，这里就是唯一声明）。
pub const KNOWN_ROLES: [&str; 3] = [ROLE_ADMIN, ROLE_SECRETARY, ROLE_USER];

/// 未知/异常角色按最保守处理（不授予任何能力）——**失败取向与 agent 侧一致**：
/// 从不默认放行、也从不默认当管理员。
pub fn is_known_role(role: &str) -> bool {
    KNOWN_ROLES.contains(&role)
}

/// 能不能进后台管理面（`middleware::auth_guard` 的唯一判据）。
///
/// 刻意做成函数而不是 `role == ROLE_ADMIN` 内联：将来若要有第二个可进后台的角色
/// （例如只读审计员），改这里一处即可，且单测能锁住"秘书不得进后台"。
pub fn can_access_console(role: &str) -> bool {
    role == ROLE_ADMIN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 秘书不得进后台管理面() {
        assert!(can_access_console(ROLE_ADMIN));
        assert!(!can_access_console(ROLE_SECRETARY));
        assert!(!can_access_console(ROLE_USER));
        assert!(!can_access_console("root"));
        assert!(!can_access_console(""));
    }

    #[test]
    fn 取值域就是这三个() {
        assert_eq!(KNOWN_ROLES.len(), 3);
        assert!(is_known_role("secretary"));
        assert!(!is_known_role("Secretary")); // 大小写敏感：角色名不收模糊匹配
        assert!(!is_known_role("administrator")); // 旧别名不认（曾散落在文档里）
    }
}
