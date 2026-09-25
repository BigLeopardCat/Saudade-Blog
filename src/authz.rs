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

/// 博主本人（uid=1）：后台全权。
pub const ROLE_ADMIN: &str = "admin";

/// 超级管理员：比 `ROLE_ADMIN` 多三件事——① 账号列表/报表里**不露脸**；
/// ② 谁都不能冻结它（含另一个超管）；③ 只有它能变更别人的身份。
/// 提权走迁移 `scripts/migration/superadmin_role_20260926.sql`（库里只有一个，且
/// **界面上加不出第二个**：`is_assignable_role` 把 superadmin 排除在可指派范围外）。
pub const ROLE_SUPERADMIN: &str = "superadmin";

/// 秘书：可以读他人数据、可以代博主做写操作，但**进不了后台管理面**
/// （后台准入只认 `ROLE_ADMIN` 与 `ROLE_SUPERADMIN`；秘书的能力边界在 agent 侧的
/// scope 表里表达，不在后台路由上表达）。
pub const ROLE_SECRETARY: &str = "secretary";

/// 普通访客 / 体验账号：只读公开内容、操作自己的设备与自己的页面。
pub const ROLE_USER: &str = "user";

/// `user.role` 的取值域（DB 列无 ENUM/CHECK 约束，这里就是唯一声明）。
pub const KNOWN_ROLES: [&str; 4] = [ROLE_ADMIN, ROLE_SUPERADMIN, ROLE_SECRETARY, ROLE_USER];

/// 未知/异常角色按最保守处理（不授予任何能力）——**失败取向与 agent 侧一致**：
/// 从不默认放行、也从不默认当管理员。
pub fn is_known_role(role: &str) -> bool {
    KNOWN_ROLES.contains(&role)
}

/// 是不是超级管理员。判据只有三处用：后台账号列表/报表的过滤（不露脸）、
/// 冻结与改角色的策略函数、以及 agent 侧的角色契约（同名同义）。
pub fn is_superadmin(role: &str) -> bool {
    role == ROLE_SUPERADMIN
}

/// 能不能进后台管理面（`middleware::auth_guard` 的唯一判据）。
///
/// 刻意做成函数而不是 `role == ROLE_ADMIN` 内联：20260926 加超管时正是只改了这里
/// 一处（外加调用它的 `profile.rs` 自动跟着走），单测锁住"秘书不得进后台"。
pub fn can_access_console(role: &str) -> bool {
    role == ROLE_ADMIN || role == ROLE_SUPERADMIN
}

/// 这个角色的账号能不能出现在**后台账号列表/报表**里。
///
/// 这就是需求原话「超级管理员账号密码不显示在后台」的落点，抽成函数是为了让它
/// 可测：两个条件（已知角色 + 不是超管）中**少写一个都不会报错**——只写
/// `is_known_role` 就是超管在后台露脸，只写 `!is_superadmin` 就是历史脏值账号
/// 混进列表。它是三道防线里的第一道（见 `routes::temp_user::list_temp_users`），
/// 而 agent 的账号名录读的是同一个接口 ⇒ 账号不出现在这里 = 那个账号在 agent 侧
/// 结构上就按名字找不到。
pub fn is_listable_role(role: &str) -> bool {
    is_known_role(role) && !is_superadmin(role)
}

// ── 账号管理策略（20260926）────────────────────────────────────────────────
//
// **这两个函数是"谁能冻谁、谁能改谁的身份"的唯一实现**——agent 侧不复制判据，
// 只把这里的话术原样转述（见 `docs/security-boundary.md` §7 的文案契约）。
// 这么做是因为判据一旦有两份，两份就会在"加一种角色"那天漂移，而漂移的表现是
// 静默放行。
//
// 两个函数都**自足**：不假设调用方已经过了某个闸（路由确实在 `auth_guard` 后面，
// 但判据不该依赖"调用顺序"这种隐式前提）。发起人不可进后台管理面 ⇒ 直接拒。

/// 冻结/解冻被拒的原因。变体对应**不同的话术**，所以不做成 bool。
/// 解冻与冻结**共用**这一组判据（不分方向）：把一个被超管冻结的管理员解冻，等于
/// 推翻超管的决定，两个方向不对称只会在"谁说了算"上留一个后门。
#[derive(Debug, PartialEq, Eq)]
pub enum FreezeDenial {
    /// 发起人自己没有后台管理面权限
    NotPermitted,
    /// 目标是发起人自己 —— 冻自己会当场把自己锁在外面
    SelfTarget,
    /// 目标是超级管理员 —— 谁都不行，含另一个超管
    TargetSuperadmin,
    /// 发起人是管理员、目标也是管理员 —— 管理员之间不可互相冻结
    PeerAdmin,
}

/// 冻结 / 解冻一个账号的判据（解冻同规则）。
pub fn check_freeze(
    op_uid: i32,
    op_role: &str,
    target_uid: i32,
    target_role: &str,
) -> Result<(), FreezeDenial> {
    if !can_access_console(op_role) {
        return Err(FreezeDenial::NotPermitted);
    }
    if op_uid == target_uid {
        return Err(FreezeDenial::SelfTarget);
    }
    if is_superadmin(target_role) {
        return Err(FreezeDenial::TargetSuperadmin);
    }
    if op_role == ROLE_ADMIN && target_role == ROLE_ADMIN {
        return Err(FreezeDenial::PeerAdmin);
    }
    Ok(())
}

/// 变更身份被拒的原因。
#[derive(Debug, PartialEq, Eq)]
pub enum RoleChangeDenial {
    /// 发起人不是超级管理员 —— 这是唯一一条与发起人有关的判据
    NotPermitted,
    /// 目标是发起人自己：改了就把自己锁在外面（降级自己 = 当场失去改回来的能力）
    SelfTarget,
    /// 目标是超级管理员：超管的身份只能由数据库迁移改
    TargetSuperadmin,
    /// 目标身份不在取值域里（`is_known_role` 为假）—— 拒绝的理由是"站内没这个身份"
    UnknownRole,
    /// 目标身份是 superadmin：界面上**加不出第二个超管**，要加走迁移
    NotAssignable,
}

/// 变更一个账号的身份的判据。只有超级管理员能发起。
pub fn check_role_change(
    op_uid: i32,
    op_role: &str,
    target_uid: i32,
    target_role: &str,
    new_role: &str,
) -> Result<(), RoleChangeDenial> {
    if !is_superadmin(op_role) {
        return Err(RoleChangeDenial::NotPermitted);
    }
    if op_uid == target_uid {
        return Err(RoleChangeDenial::SelfTarget);
    }
    if is_superadmin(target_role) {
        return Err(RoleChangeDenial::TargetSuperadmin);
    }
    if !is_known_role(new_role) {
        return Err(RoleChangeDenial::UnknownRole);
    }
    if !is_assignable_role(new_role) {
        return Err(RoleChangeDenial::NotAssignable);
    }
    Ok(())
}

/// 一个角色能不能通过**界面**指派给别人。已知角色里除了 superadmin 都可以：
/// 多一个超级管理员应该是一条 SQL 的决定，不该是页面上点一下的事。
pub fn is_assignable_role(role: &str) -> bool {
    is_known_role(role) && !is_superadmin(role)
}

/// 角色在**服务端话术**里的中文名（用于拼"身份已改为秘书…"这类回复句）。
///
/// 前端 `utils/auth.ts::ROLE_LABEL` 是另一份、用途也不同的映射（界面标签，还带
/// 颜色）——两份都从同一组角色名出发，改角色名时两边会一起红（各有单测/沙箱锁着）。
/// 未登记角色给一句兜底，**绝不把它当已知角色**（调用方已经过了 `is_known_role`）。
pub fn role_label(role: &str) -> &'static str {
    match role {
        ROLE_ADMIN => "管理员",
        ROLE_SUPERADMIN => "超级管理员",
        ROLE_SECRETARY => "秘书",
        ROLE_USER => "普通用户",
        _ => "未登记身份",
    }
}

// ── 账号状态与令牌有效性（20260926）─────────────────────────────────────────
//
// 这一节回答的是**与角色无关**的另一问：这个账号还能不能用、手里这个令牌还算不算数。
// 与角色判定分开是因为两者的失败取向与后果都不同——角色不够是 403（人还在，事不许做），
// 令牌作废是 401（人已经不在线了）。混在一起会让前端分不清"该提示没权限"还是"该登出"。

/// `user.status` 取值域（DB 列无 ENUM/CHECK 约束，这里是唯一声明）。
/// 迁移：`scripts/migration/user_status_token_version_20260926.sql`
pub const STATUS_ACTIVE: i8 = 0;
/// 冻结：拒登录、拒改密码与恢复码、已签发令牌全部失效。
pub const STATUS_FROZEN: i8 = 1;

/// 账号是否已冻结。**未登记的值一律按冻结处理**（`!= ACTIVE`，不是 `== FROZEN`）：
/// 库里出现第三种值时，我们要的是"不认识的账号状态不放行"，而不是"没写 1 就等于正常"。
pub fn is_frozen(status: i8) -> bool {
    status != STATUS_ACTIVE
}

/// 令牌被拒的原因。**两个变体对应两种不同的用户话术**，所以不做成 bool：
/// 说"请重新登录"和说"账号已被冻结"对当事人的下一步动作是两件事。
#[derive(Debug, PartialEq, Eq)]
pub enum TokenDenial {
    /// 账号被冻结 —— 重新登录也没有用，得找管理员
    Frozen,
    /// 令牌已被收回（改密码 / 管理员重置 / 冻结时 +1 了 `token_version`）
    Revoked,
}

/// **令牌有效性的唯一判据点**（20260926）。两处调用：`auth_jwt::auth_uid`（面向所有
/// 登录用户的公开路由）与 `middleware::auth_guard`（后台管理面）。
///
/// 判据顺序是先状态后代次：冻结期间无论代次对不对都不放行，这样"冻结时顺手 +1"
/// 里的那个 +1 只是为了让解冻不复活旧会话，不承担主判据的角色。
///
/// **`claims_ver: Option<i32>` 的第三态不是随手加的**（20260926 当天补）：`None`
/// 表示这枚令牌**根本没有代次声明**。谁没有？两类，都是**服务端自己签的**——
/// ① 部署那一刻还活着的旧令牌（`ver` 是后加的声明，见 `auth_jwt::Claims` 的注释）；
/// ② agent 的 60 秒代调令牌（`saudade-blog-agent/tools/base.py::_sign_local_jwt`，
/// `{sub, exp, role}` 三字段，不带 `ver`）——它代表的是 Rust **本次请求刚认证过**
/// 的身份，比任何代次都新鲜。
/// 不做成 `i32 + serde default`（那样 `None` 会退化成 `0`）的理由正在这里：**代理令牌
/// 会被误判成"代次 0 的旧令牌"**，于是管理员改过密码之后，agent 以他的名义读后台
/// 一律 401——一个只在"改过密码的管理员用管理助手"时才现形的缺陷。
/// 失败取向没有被放宽：能签出"不带 `ver`"的令牌的人必须持有 `JWT_SECRET`，而拿到密钥
/// 的人本来就能签任意 `ver`；`None` 这一支少掉的只是一次**无意义的比对**，冻结判定
/// 照旧对它生效。
pub fn check_token(status: i8, token_version: i32, claims_ver: Option<i32>) -> Result<(), TokenDenial> {
    if is_frozen(status) {
        return Err(TokenDenial::Frozen);
    }
    if let Some(v) = claims_ver {
        if token_version != v {
            return Err(TokenDenial::Revoked);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 秘书不得进后台管理面() {
        assert!(can_access_console(ROLE_ADMIN));
        // 20260926：超管也要能进——漏了这一条，uid=1 提权当天就进不了后台
        assert!(can_access_console(ROLE_SUPERADMIN));
        assert!(!can_access_console(ROLE_SECRETARY));
        assert!(!can_access_console(ROLE_USER));
        assert!(!can_access_console("root"));
        assert!(!can_access_console(""));
    }

    #[test]
    fn 取值域就是这四个() {
        assert_eq!(KNOWN_ROLES.len(), 4);
        assert!(is_known_role("superadmin"));
        assert!(is_known_role("secretary"));
        assert!(!is_known_role("Secretary")); // 大小写敏感：角色名不收模糊匹配
        assert!(!is_known_role("administrator")); // 旧别名不认（曾散落在文档里）
        assert!(!is_known_role("SuperAdmin"));
    }

    #[test]
    fn 超管判据只认那一个名字() {
        assert!(is_superadmin(ROLE_SUPERADMIN));
        assert!(!is_superadmin(ROLE_ADMIN));
        assert!(!is_superadmin(ROLE_SECRETARY));
        assert!(!is_superadmin(ROLE_USER));
        assert!(!is_superadmin(""));
    }

    /// "超级管理员账号不显示在后台"这条需求的可测形态：两半都要在，
    /// 少一半都不会报错、只会静默放行（见 `is_listable_role` 的注释）。
    #[test]
    fn 列表可见的角色里没有超管() {
        assert!(!is_listable_role(ROLE_SUPERADMIN));
        assert!(is_listable_role(ROLE_ADMIN));
        assert!(is_listable_role(ROLE_SECRETARY));
        assert!(is_listable_role(ROLE_USER));
        // 未知角色也不列（前端判不出它该归到哪一档筛选项下）
        assert!(!is_listable_role(""));
        assert!(!is_listable_role("SuperAdmin"));
        assert!(!is_listable_role("root"));
    }

    /// 冻结策略表逐格。第二列是"发起人"，第三列是目标，第四列是期望结果。
    /// 覆盖三种拒绝 + 各方向的放行，并特意把"未知角色"两个失败取向都列出来。
    #[test]
    fn 冻结策略表() {
        let admin = ROLE_ADMIN;
        let sup = ROLE_SUPERADMIN;
        let sec = ROLE_SECRETARY;
        let usr = ROLE_USER;
        // (发起人 uid, 发起人角色, 目标 uid, 目标角色, 期望)
        let cases: &[(i32, &str, i32, &str, Result<(), FreezeDenial>)] = &[
            // 自己 → 拒（三个角色各一次：谁都不能冻自己）
            (7, admin, 7, admin, Err(FreezeDenial::SelfTarget)),
            (1, sup, 1, sup, Err(FreezeDenial::SelfTarget)),
            (9, usr, 9, usr, Err(FreezeDenial::NotPermitted)),
            // 目标是超管 → 拒（含另一个超管的 uid，且不看发起人是谁）
            (7, admin, 1, sup, Err(FreezeDenial::TargetSuperadmin)),
            (2, sup, 1, sup, Err(FreezeDenial::TargetSuperadmin)),
            // 管理员之间 → 拒（两个方向都是同一句）
            (7, admin, 8, admin, Err(FreezeDenial::PeerAdmin)),
            // 管理员冻秘书 / 普通用户 → 放行（本次问答明确：秘书可被管理员冻）
            (7, admin, 9, sec, Ok(())),
            (7, admin, 10, usr, Ok(())),
            // 超管冻管理员 / 秘书 / 普通用户 → 放行
            (1, sup, 7, admin, Ok(())),
            (1, sup, 9, sec, Ok(())),
            (1, sup, 10, usr, Ok(())),
            // 发起人自己没有后台管理面权限 → 拒（判据自足，不依赖路由先过闸）
            (9, sec, 10, usr, Err(FreezeDenial::NotPermitted)),
            (10, usr, 11, usr, Err(FreezeDenial::NotPermitted)),
            (0, "", 10, usr, Err(FreezeDenial::NotPermitted)),
            (0, "root", 10, usr, Err(FreezeDenial::NotPermitted)),
            // 目标角色未知 ⇒ 不特殊对待（admin 冻未知角色放行——**未知不等于超管**；
            // 幂等与"存在的账号"由路由查库保证，policy 不猜）
            (7, admin, 11, "root", Ok(())),
            // 未登录发起人（uid=0）冻一个 uid 不为 0 的账号：角色过不了那一关
            (0, "", 7, admin, Err(FreezeDenial::NotPermitted)),
        ];
        for (op_uid, op_role, t_uid, t_role, want) in cases {
            assert_eq!(
                check_freeze(*op_uid, op_role, *t_uid, t_role),
                *want,
                "发起人 uid={op_uid} role={op_role} → 目标 uid={t_uid} role={t_role}"
            );
        }
    }

    /// 变更身份策略表逐格。**只有超管能发起**，且新身份不许是 superadmin。
    #[test]
    fn 改角色策略表() {
        let admin = ROLE_ADMIN;
        let sup = ROLE_SUPERADMIN;
        let sec = ROLE_SECRETARY;
        let usr = ROLE_USER;
        let cases: &[(i32, &str, i32, &str, &str, Result<(), RoleChangeDenial>)] = &[
            // 发起人不是超管 → 拒（管理员也不行）
            (7, admin, 9, sec, usr, Err(RoleChangeDenial::NotPermitted)),
            (9, sec, 10, usr, admin, Err(RoleChangeDenial::NotPermitted)),
            (10, usr, 11, usr, sec, Err(RoleChangeDenial::NotPermitted)),
            // 改自己 → 拒（降级自己就再也改不回来）
            (1, sup, 1, sup, admin, Err(RoleChangeDenial::SelfTarget)),
            // 目标是超管 → 拒（含另一个超管的 uid）
            (2, sup, 1, sup, usr, Err(RoleChangeDenial::TargetSuperadmin)),
            // 新身份不在取值域 → 拒
            (1, sup, 9, sec, "root", Err(RoleChangeDenial::UnknownRole)),
            (1, sup, 9, sec, "", Err(RoleChangeDenial::UnknownRole)),
            (1, sup, 9, sec, "Admin", Err(RoleChangeDenial::UnknownRole)),
            // 新身份是超管 → 拒（要加第二个超管走迁移，不是页面上点一下）
            (1, sup, 9, sec, sup, Err(RoleChangeDenial::NotAssignable)),
            (1, sup, 7, admin, sup, Err(RoleChangeDenial::NotAssignable)),
            // 正常路径：超管把秘书/普通用户/管理员改成三档里的任一档
            (1, sup, 9, sec, usr, Ok(())),
            (1, sup, 9, sec, admin, Ok(())),
            (1, sup, 10, usr, sec, Ok(())),
            (1, sup, 7, admin, usr, Ok(())),
            (1, sup, 7, admin, sec, Ok(())),
        ];
        for (op_uid, op_role, t_uid, t_role, new_role, want) in cases {
            assert_eq!(
                check_role_change(*op_uid, op_role, *t_uid, t_role, new_role),
                *want,
                "发起人 uid={op_uid} role={op_role} → 目标 uid={t_uid} role={t_role} 改成 {new_role}"
            );
        }
    }

    #[test]
    fn 可指派范围不含超管() {
        assert!(is_assignable_role(ROLE_ADMIN));
        assert!(is_assignable_role(ROLE_SECRETARY));
        assert!(is_assignable_role(ROLE_USER));
        assert!(!is_assignable_role(ROLE_SUPERADMIN));
        assert!(!is_assignable_role("root"));
    }

    #[test]
    fn 未登记的账号状态按冻结处理() {
        assert!(!is_frozen(STATUS_ACTIVE));
        assert!(is_frozen(STATUS_FROZEN));
        // 关键：不是 == FROZEN 而是 != ACTIVE。将来库里出现第三种值时，
        // 这里必须往"不能用"倒，不能往"放行"倒。
        assert!(is_frozen(2));
        assert!(is_frozen(-1));
    }

    #[test]
    fn 正常账号_代次相同才放行() {
        assert_eq!(check_token(STATUS_ACTIVE, 0, Some(0)), Ok(()));
        assert_eq!(check_token(STATUS_ACTIVE, 7, Some(7)), Ok(()));
        // 改密码/紧急收回把库里的值 +1 ⇒ 旧令牌（claims.ver 还是小的那个）被拒
        assert_eq!(check_token(STATUS_ACTIVE, 8, Some(7)), Err(TokenDenial::Revoked));
        // 反向不可能（库里的值只会增），仍然判不通过——不因为"看起来更旧"就放行
        assert_eq!(check_token(STATUS_ACTIVE, 6, Some(7)), Err(TokenDenial::Revoked));
    }

    #[test]
    fn 冻结账号_代次对得上也不放行() {
        assert_eq!(check_token(STATUS_FROZEN, 3, Some(3)), Err(TokenDenial::Frozen));
        // 冻结时顺手 +1 了代次 ⇒ 两种原因同时成立，报的是冻结（先状态后代次）
        assert_eq!(check_token(STATUS_FROZEN, 4, Some(3)), Err(TokenDenial::Frozen));
        // 未登记状态同上
        assert_eq!(check_token(9, 0, Some(0)), Err(TokenDenial::Frozen));
    }

    /// **结构锁**：不许再有"自己解 token"的旁路。
    ///
    /// 写这条测试的原因是它抓到了真实缺陷（20260926 当天）：`graph.rs` 与 `talks.rs`
    /// 各有一个手写的 `current_uid`，只验签不查库 ⇒ 冻结一个账号之后它照旧能刷
    /// embedding 查询、照旧能放河灯。收回判据长在 `auth_uid` 这个唯一出口上，
    /// 而这个"唯一"必须**可被验证**，否则下一个接口又会顺手写一份 (见文档里
    /// "结构上不存在"那句承诺)。修法是让它们都变成 `auth_uid` 的薄壳，本条把
    /// "只有两处能碰那个解析函数"钉死（名字从 `["verify","_token"].concat()` 拼出，
    /// 好让本文件——含本注释——不含完整字面量；写在注释里也会自命中，20260926 实测）：
    ///   · `auth_jwt.rs` —— 定义它与 `auth_uid`（唯一出口）
    ///   · `middleware.rs` —— 后台管理面那条闸（它必须另起一份，因为要区分 401/403）
    #[test]
    fn 解析令牌的入口只有两处() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let name = ["verify", "_token"].concat();
        let mut callers: Vec<String> = Vec::new();
        // 手写一个窄目录遍历：只为这条断言引 walkdir 不划算
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src 可读").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).expect("源文件可读");
                    // 出现**这个标识符**就算（定义 / 限定路径调用 / 当值传进 and_then 都算）。
                    // 这也是为什么名字得拼：唯一出口里那处是把它当值传进 `and_then`，
                    // 既没有 `(` 也没有前缀，按调用形态匹配会漏掉它。
                    if text.contains(&name) {
                        callers.push(path.file_name().unwrap().to_string_lossy().into_owned());
                    }
                }
            }
        }
        callers.sort();
        callers.dedup();
        assert_eq!(
            callers,
            vec!["auth_jwt.rs".to_string(), "middleware.rs".to_string()],
            "只有 auth_jwt.rs（唯一出口 auth_uid）与 middleware.rs（后台闸）可以解析令牌；\
             其它地方要身份请调 auth_jwt::auth_uid——自己验签会绕过冻结与令牌收回。\
             新增的调用方是：{callers:?}（{name} 也不许写进注释或断言文案，会自命中）"
        );
    }

    #[test]
    fn 没有代次声明的令牌只判冻结不判代次() {
        // agent 的 60 秒代调令牌与部署前的旧令牌都是这一支：库里代次无论多少都放行…
        assert_eq!(check_token(STATUS_ACTIVE, 0, None), Ok(()));
        assert_eq!(check_token(STATUS_ACTIVE, 5, None), Ok(()));
        // …但**冻结判据照旧生效**（这是"代码里没有豁免通道"的那半）
        assert_eq!(check_token(STATUS_FROZEN, 0, None), Err(TokenDenial::Frozen));
        assert_eq!(check_token(9, 0, None), Err(TokenDenial::Frozen));
    }
}
