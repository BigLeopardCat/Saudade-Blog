/// 后台管理员角色。
pub const ROLE_ADMIN: &str = "admin";

pub const ROLE_SUPERADMIN: &str = "superadmin";

/// 普通访客 / 体验账号：只读公开内容、操作自己的设备与自己的页面。
pub const ROLE_USER: &str = "user";

pub const ROLE_ZAKO: &str = "zako";

/// `user.role` 的取值域（DB 列无 ENUM/CHECK 约束，这里就是唯一声明）。
pub const KNOWN_ROLES: [&str; 4] = [ROLE_ADMIN, ROLE_SUPERADMIN, ROLE_USER, ROLE_ZAKO];

/// 未知/异常角色按最保守处理（不授予任何能力）——**失败取向与 agent 侧一致**：
/// 从不默认放行、也从不默认当管理员。
pub fn is_known_role(role: &str) -> bool {
    KNOWN_ROLES.contains(&role)
}

/// 超级管理员拥有独立的账号管理边界。
pub fn is_superadmin(role: &str) -> bool {
    role == ROLE_SUPERADMIN
}

pub fn can_access_console(role: &str) -> bool {
    role == ROLE_ADMIN || role == ROLE_SUPERADMIN
}

/// 管理凭据与冻结共用账号层级；自己的密码必须走验证旧密码的个人中心入口。
pub fn can_manage_credentials(op_uid: i32, op_role: &str, target_uid: i32, target_role: &str) -> bool {
    is_known_role(target_role)
        && check_freeze(op_uid, op_role, target_uid, target_role).is_ok()
}

/// 账号名录仅展示已知的非超级管理员角色。
pub fn is_listable_role(role: &str) -> bool {
    is_known_role(role) && !is_superadmin(role)
}


/// 冻结与解冻使用相同层级校验，避免绕过上级管理员的决定。
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
    /// 发起人自己没有后台管理面权限（普通用户/杂鱼/未知角色）
    NotPermitted,
    /// 目标是发起人自己：改了就把自己锁在外面（降级自己 = 当场失去改回来的能力）
    SelfTarget,
    /// 目标是超级管理员：超管的身份只能由数据库迁移改
    TargetSuperadmin,
    /// 目标身份不在取值域里（`is_known_role` 为假）—— 拒绝的理由是"站内没这个身份"
    UnknownRole,
    /// 目标身份是 superadmin：界面上**加不出第二个超管**，要加走迁移
    NotAssignable,
    AdminTargetTier,
    AdminAssignTier,
}

const ADMIN_MANAGEABLE_ROLES: [&str; 2] = [ROLE_USER, ROLE_ZAKO];

/// Role targets an administrator may manage; this does not authorize the caller.
pub fn is_role_manageable_by_admin(role: &str) -> bool {
    ADMIN_MANAGEABLE_ROLES.contains(&role)
}

pub fn check_role_change(
    op_uid: i32,
    op_role: &str,
    target_uid: i32,
    target_role: &str,
    new_role: &str,
) -> Result<(), RoleChangeDenial> {
    if !can_access_console(op_role) {
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
        if !is_superadmin(op_role) {
        if !is_role_manageable_by_admin(target_role) {
            return Err(RoleChangeDenial::AdminTargetTier);
        }
        if !is_role_manageable_by_admin(new_role) {
            return Err(RoleChangeDenial::AdminAssignTier);
        }
    }
    Ok(())
}

/// 一个角色能不能通过**界面**指派给别人。已知角色里除了 superadmin 都可以：
/// 多一个超级管理员应该是一条 SQL 的决定，不该是页面上点一下的事。
pub fn is_assignable_role(role: &str) -> bool {
    is_known_role(role) && !is_superadmin(role)
}

/// 角色在**服务端话术**里的中文名（用于拼"身份已改为杂鱼…"这类回复句）。
///
/// 前端 `utils/auth.ts::ROLE_LABEL` 是另一份、用途也不同的映射（界面标签，还带
/// 颜色）——两份都从同一组角色名出发，改角色名时两边会一起红（各有单测/沙箱锁着）。
/// 未登记角色给一句兜底，**绝不把它当已知角色**（调用方已经过了 `is_known_role`）。
pub fn role_label(role: &str) -> &'static str {
    match role {
        ROLE_ADMIN => "管理员",
        ROLE_SUPERADMIN => "超级管理员",
        ROLE_USER => "普通用户",
        ROLE_ZAKO => "杂鱼",
        _ => "未登记身份",
    }
}


pub const STATUS_ACTIVE: i16 = 0;
/// 冻结：拒登录、拒改密码与恢复码、已签发令牌全部失效。
pub const STATUS_FROZEN: i16 = 1;

/// 账号是否已冻结。**未登记的值一律按冻结处理**（`!= ACTIVE`，不是 `== FROZEN`）：
/// 库里出现第三种值时，我们要的是"不认识的账号状态不放行"，而不是"没写 1 就等于正常"。
pub fn is_frozen(status: i16) -> bool {
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

pub fn check_token(status: i16, token_version: i32, claims_ver: Option<i32>) -> Result<(), TokenDenial> {
    if is_frozen(status) {
        return Err(TokenDenial::Frozen);
    }
    if claims_ver != Some(token_version) { return Err(TokenDenial::Revoked); }
    Ok(())
}


/// 「永久禁言」在 `user.muted_until` 里的字面量。
///
/// **不用 NULL 表永久**：NULL 已经是"从未禁言"的意思，两者同形会让后台列表、后台
/// 的幂等判定（"现在就是禁言中 ⇒ 不重复弹卡"）与通知文案全都分不出来。
/// 这个值也**不是**"足够远的未来"那种需要重算的近似——它是取值域的一部分（写进
/// 迁移注释、`TempUserInfo` 的读法、agent 侧的工具参数），改它要三处一起改。
pub const MUTE_FOREVER: &str = "9999-12-31 23:59:59";

/// 现在是否处于禁言期。**判据只此一处**（`is_frozen` 的同位函数）。
///
/// 到期**不需要任何人去清**：判据就是"现在 < 到期时刻"，过了那一刻自然为假——
/// 没有定时任务、没有后台解禁队列。这也是"永久"必须是一个真实时刻而不是 NULL 的
/// 另一半理由：这个判据要对两种状态给出同一个形状的答案。
pub fn is_muted(muted_until: Option<chrono::NaiveDateTime>, now: chrono::NaiveDateTime) -> bool {
    match muted_until {
        None => false,
        Some(until) => now < until,
    }
}

/// 「永久」那一刻（写库时的取值）。与 `MUTE_FOREVER` 同源：字面量解析失败就 panic
/// ——它是个编译期常量字符串，解析不了说明有人改错了它，**这时候静默回落成
/// "禁言到 1970 年"比崩溃危险得多**（那等于把禁言变成一句空话）。
pub fn mute_forever_at() -> chrono::NaiveDateTime {
    use chrono::NaiveDateTime;
    NaiveDateTime::parse_from_str(MUTE_FOREVER, "%Y-%m-%d %H:%M:%S")
        .expect("MUTE_FOREVER 是不可解析的时间字面量")
}

/// 禁言中被拒时，给当事人的那一句原话（**跨语言契约**：agent 逐字转述，
/// 见 `docs/security-boundary.md` §7⑫）。
///
/// 三件事必须说清，少一件当事人就会去做无用功：
///   · **你还在这儿**（能登录能看，只是发不了）——不然他会以为自己被封号了；
///   · **到什么时候**（永久那种要直说永久，不能显示成 9999 年）；
///   · **还剩多久**（钟面时刻是给日历的，剩余量是给人做决定的）。
pub fn mute_denial_message(until: chrono::NaiveDateTime, now: chrono::NaiveDateTime) -> String {
    if until >= mute_forever_at() {
        return "你已被禁言（永久），期间不能发布评论与留言。".to_string();
    }
    format!(
        "你已被禁言，至 {}（还剩约 {}），期间不能发布评论与留言。",
        until.format("%Y-%m-%d %H:%M"),
        mute_remain_text(until, now)
    )
}

/// 「还剩多久」的人话。**禁言话术与禁言通知共用这一份**（`risk::mute_notice_body` 也调它）
/// ——两处各写一遍的话，"不足一小时按分钟说"这类边界只会在一处被修。
pub fn mute_remain_text(until: chrono::NaiveDateTime, now: chrono::NaiveDateTime) -> String {
    let left = until - now;
    if left.num_hours() >= 1 {
        format!("{} 小时", left.num_hours())
    } else {
        format!("{} 分钟", left.num_minutes().max(1))
    }
}

pub fn mute_until_text(until: chrono::NaiveDateTime) -> String {
    if until >= mute_forever_at() {
        "永久".to_string()
    } else {
        format!("至 {}", until.format("%Y-%m-%d %H:%M"))
    }
}

pub fn mute_span_text(until: chrono::NaiveDateTime, now: chrono::NaiveDateTime) -> String {
    if until >= mute_forever_at() {
        "（永久）".to_string()
    } else {
        format!("{}（还剩约 {}）", mute_until_text(until), mute_remain_text(until, now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_management_covers_both_privileged_tiers() {
        for operator in KNOWN_ROLES {
            for target in KNOWN_ROLES {
                let expected = match operator {
                    ROLE_SUPERADMIN => target != ROLE_SUPERADMIN,
                    ROLE_ADMIN => matches!(target, ROLE_USER | ROLE_ZAKO),
                    _ => false,
                };
                assert_eq!(can_manage_credentials(1, operator, 2, target), expected,
                    "{operator} -> {target}");
                assert!(!can_manage_credentials(1, operator, 1, target));
            }
        }
        assert!(!can_manage_credentials(1, ROLE_SUPERADMIN, 2, "unknown"));
    }

    #[test]
    fn 非管理员族不得进后台管理面() {
        assert!(can_access_console(ROLE_ADMIN));
        assert!(can_access_console(ROLE_SUPERADMIN));
        assert!(!can_access_console(ROLE_USER));
        assert!(!can_access_console(ROLE_ZAKO));
        assert!(!can_access_console("root"));
        assert!(!can_access_console(""));
    }

    #[test]
    fn 取值域就是这四个() {
        assert_eq!(KNOWN_ROLES.len(), 4);
        assert!(is_known_role("superadmin"));
        assert!(is_known_role(ROLE_ZAKO));
        assert!(!is_known_role("Admin")); // 大小写敏感：角色名不收模糊匹配
        assert!(!is_known_role("administrator")); // 旧别名不认（曾散落在文档里）
        assert!(!is_known_role("SuperAdmin"));
    }

    #[test]
    fn 超管判据只认那一个名字() {
        assert!(is_superadmin(ROLE_SUPERADMIN));
        assert!(!is_superadmin(ROLE_ADMIN));
        assert!(!is_superadmin(ROLE_USER));
        assert!(!is_superadmin(ROLE_ZAKO));
        assert!(!is_superadmin(""));
    }

    /// "超级管理员账号不显示在后台"这条需求的可测形态：两半都要在，
    /// 少一半都不会报错、只会静默放行（见 `is_listable_role` 的注释）。
    #[test]
    fn 列表可见的角色里没有超管() {
        assert!(!is_listable_role(ROLE_SUPERADMIN));
        assert!(is_listable_role(ROLE_ADMIN));
        assert!(is_listable_role(ROLE_USER));
        assert!(is_listable_role(ROLE_ZAKO));
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
        let usr = ROLE_USER;
        // (发起人 uid, 发起人角色, 目标 uid, 目标角色, 期望)
        let cases: &[(i32, &str, i32, &str, Result<(), FreezeDenial>)] = &[
            // 自己 → 拒（管理员与超管各一次 = `SelfTarget`；普通用户那一格**先被第一关
            // 拦下** ⇒ 回的是 `NotPermitted`——判据顺序的可见后果，不是写错了）
            (7, admin, 7, admin, Err(FreezeDenial::SelfTarget)),
            (1, sup, 1, sup, Err(FreezeDenial::SelfTarget)),
            (9, usr, 9, usr, Err(FreezeDenial::NotPermitted)),
            // 目标是超管 → 拒（含另一个超管的 uid，且不看发起人是谁）
            (7, admin, 1, sup, Err(FreezeDenial::TargetSuperadmin)),
            (2, sup, 1, sup, Err(FreezeDenial::TargetSuperadmin)),
            // 管理员之间 → 拒（两个方向都是同一句）
            (7, admin, 8, admin, Err(FreezeDenial::PeerAdmin)),
            (7, admin, 10, usr, Ok(())),
            (7, admin, 12, ROLE_ZAKO, Ok(())),
            // 超管冻管理员 / 普通用户 / 杂鱼 → 放行
            (1, sup, 7, admin, Ok(())),
            (1, sup, 10, usr, Ok(())),
            (1, sup, 12, ROLE_ZAKO, Ok(())),
            // 发起人自己没有后台管理面权限 → 拒（判据自足，不依赖路由先过闸）
            (10, usr, 11, usr, Err(FreezeDenial::NotPermitted)),
            (0, "", 10, usr, Err(FreezeDenial::NotPermitted)),
            (0, "root", 10, usr, Err(FreezeDenial::NotPermitted)),
            (12, ROLE_ZAKO, 10, usr, Err(FreezeDenial::NotPermitted)),
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

    #[test]
    fn 改角色策略表() {
        let admin = ROLE_ADMIN;
        let sup = ROLE_SUPERADMIN;
        let usr = ROLE_USER;
        let cases: &[(i32, &str, i32, &str, &str, Result<(), RoleChangeDenial>)] = &[
            (10, usr, 11, usr, ROLE_ZAKO, Err(RoleChangeDenial::NotPermitted)),
            (12, ROLE_ZAKO, 10, usr, usr, Err(RoleChangeDenial::NotPermitted)),
            (0, "", 10, usr, usr, Err(RoleChangeDenial::NotPermitted)),
            (0, "root", 10, usr, usr, Err(RoleChangeDenial::NotPermitted)),
            // 改自己 → 拒（降级自己就再也改不回来）——超管与管理员都各来一格
            (1, sup, 1, sup, admin, Err(RoleChangeDenial::SelfTarget)),
            (7, admin, 7, admin, ROLE_ZAKO, Err(RoleChangeDenial::SelfTarget)),
            // 目标是超管 → 拒（含另一个超管的 uid；管理员与超管发起都拒）
            (2, sup, 1, sup, usr, Err(RoleChangeDenial::TargetSuperadmin)),
            (7, admin, 1, sup, usr, Err(RoleChangeDenial::TargetSuperadmin)),
            // 新身份不在取值域 → 拒（先于档位判据：说不存在的身份时，
            // "站内没这个身份"比"管理员只能改成低两档"更接近事实）
            (1, sup, 9, usr, "root", Err(RoleChangeDenial::UnknownRole)),
            (1, sup, 9, usr, "", Err(RoleChangeDenial::UnknownRole)),
            (1, sup, 9, usr, "Admin", Err(RoleChangeDenial::UnknownRole)),
            (7, admin, 10, usr, "root", Err(RoleChangeDenial::UnknownRole)),
            // 新身份是超管 → 拒（要加第二个超管走迁移，不是页面上点一下）
            (1, sup, 9, usr, sup, Err(RoleChangeDenial::NotAssignable)),
            (1, sup, 7, admin, sup, Err(RoleChangeDenial::NotAssignable)),
            (7, admin, 10, usr, sup, Err(RoleChangeDenial::NotAssignable)),
            // ── 超管正常路径：把普通用户/管理员/杂鱼改成四档里的任一档 ──
            (1, sup, 9, usr, ROLE_ZAKO, Ok(())),
            (1, sup, 9, usr, admin, Ok(())),
            (1, sup, 10, usr, admin, Ok(())),
            (1, sup, 7, admin, usr, Ok(())),
            (1, sup, 7, admin, ROLE_ZAKO, Ok(())),
            (1, sup, 10, usr, ROLE_ZAKO, Ok(())),
            (1, sup, 7, admin, ROLE_ZAKO, Ok(())),
            (1, sup, 12, ROLE_ZAKO, usr, Ok(())),
            (7, admin, 10, usr, ROLE_ZAKO, Ok(())),
            (7, admin, 12, ROLE_ZAKO, usr, Ok(())),
            (7, admin, 12, ROLE_ZAKO, ROLE_ZAKO, Ok(())), // 幂等（路由层会先短路，判据本身放行）
            // 目标不在低两档 → 拒（**语义反转的那一格**：管理员不归管理员管）
            (7, admin, 8, admin, usr, Err(RoleChangeDenial::AdminTargetTier)),
            (7, admin, 8, admin, ROLE_ZAKO, Err(RoleChangeDenial::AdminTargetTier)),
            // 目标在低两档、但要指派到更高的档 → 拒（**只能搬，不能提权**）
            (7, admin, 10, usr, admin, Err(RoleChangeDenial::AdminAssignTier)),
            (7, admin, 12, ROLE_ZAKO, admin, Err(RoleChangeDenial::AdminAssignTier)),
        ];
        for (op_uid, op_role, t_uid, t_role, new_role, want) in cases {
            assert_eq!(
                check_role_change(*op_uid, op_role, *t_uid, t_role, new_role),
                *want,
                "发起人 uid={op_uid} role={op_role} → 目标 uid={t_uid} role={t_role} 改成 {new_role}"
            );
        }
    }

    /// Managing lower roles must never imply console access for those roles.
    #[test]
    fn 管理员能动的是哪两档() {
        assert!(is_role_manageable_by_admin(ROLE_USER));
        assert!(is_role_manageable_by_admin(ROLE_ZAKO));
        assert!(!is_role_manageable_by_admin(ROLE_ADMIN));
        assert!(!is_role_manageable_by_admin(ROLE_SUPERADMIN));
        assert!(!is_role_manageable_by_admin("root"));
        assert!(!is_role_manageable_by_admin(""));
        assert_eq!(ADMIN_MANAGEABLE_ROLES.len(), 2);
    }

    #[test]
    fn 可指派范围不含超管() {
        assert!(is_assignable_role(ROLE_ADMIN));
        assert!(is_assignable_role(ROLE_USER));
        assert!(is_assignable_role(ROLE_ZAKO));
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
    fn 没有代次声明的令牌拒绝访问() {
        assert_eq!(check_token(STATUS_ACTIVE, 0, None), Err(TokenDenial::Revoked));
        assert_eq!(check_token(STATUS_ACTIVE, 5, None), Err(TokenDenial::Revoked));
        assert_eq!(check_token(STATUS_FROZEN, 0, None), Err(TokenDenial::Frozen));
        assert_eq!(check_token(9, 0, None), Err(TokenDenial::Frozen));
    }

    /// 禁言判据的三态：从未禁言 / 还在期内 / 已过期。**永久也要走同一个判据**
    /// ——它只是一个很远的时刻，不是特殊分支（特殊分支就是"两套判据"，那才会漂）。
    #[test]
    fn 禁言判据的三种状态() {
        use chrono::NaiveDateTime;
        let now = NaiveDateTime::parse_from_str("2026-10-03 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let later =
            NaiveDateTime::parse_from_str("2026-10-04 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let earlier =
            NaiveDateTime::parse_from_str("2026-10-02 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        assert!(!is_muted(None, now), "NULL = 从未禁言");
        assert!(is_muted(Some(later), now), "到期时刻在将来 ⇒ 禁言中");
        assert!(!is_muted(Some(earlier), now), "到期时刻已过 ⇒ 自然解禁（不需要谁来清）");
        // 边界：正好到期的那一刻不算禁言中（`<`，不是 `<=`）
        assert!(!is_muted(Some(now), now));
        // 永久
        assert!(is_muted(Some(mute_forever_at()), now));
    }

    /// 「永久」必须可解析、且**比任何合理的"现在"都远**：它若写错，`is_muted` 那一支
    /// 会静默变成"没有禁言"，而那正是最不该静默的地方。
    #[test]
    fn 永久禁言那一刻是可解析的字面量() {
        assert_eq!(MUTE_FOREVER, "9999-12-31 23:59:59");
        let forever = mute_forever_at();
        let now = chrono::Local::now().naive_local();
        assert!(forever > now);
        // 判据认的也是它（不是"比 9999 年稍早"的近似）
        assert!(is_muted(Some(forever), now));
    }

    /// 禁言话术三件必须说清的事：人还在、到什么时候、还剩多久。
    #[test]
    fn 禁言话术说清到什么时候与还剩多久() {
        use chrono::NaiveDateTime;
        let now = NaiveDateTime::parse_from_str("2026-10-03 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let tomorrow =
            NaiveDateTime::parse_from_str("2026-10-04 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let msg = mute_denial_message(tomorrow, now);
        assert!(msg.contains("2026-10-04 12:00"), "{msg}");
        assert!(msg.contains("24 小时"), "{msg}");
        assert!(msg.contains("不能发布评论与留言"), "话术要说清「还能登录、只是发不了」，而不是读成封号：{msg}");
        // 不足一小时按分钟说（"还剩 0 小时"等于没说）
        let soon = NaiveDateTime::parse_from_str("2026-10-03 12:30:00", "%Y-%m-%d %H:%M:%S").unwrap();
        assert!(mute_denial_message(soon, now).contains("30 分钟"));
        // 永久直说永久，不显示成 9999 年
        let forever = mute_denial_message(mute_forever_at(), now);
        assert!(forever.contains("永久"), "{forever}");
        assert!(!forever.contains("9999"), "别把内部哨兵值当成人话念出来：{forever}");
    }
}
