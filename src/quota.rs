//! Shared chat quota policy and atomic usage accounting.
//!
//! Ordinary users have a configurable lifetime quota; confirmation does not consume
//! another turn. Console administrators are unlimited through the central authz policy.
//! Limits are configuration, while consumption is persisted usage.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use tracing::warn;

use crate::authz;
use crate::entity::user;

/// 配置缺失或无效时的默认限额；前端和 Agent 从响应读取实际值。
const LIMIT_DEFAULT: i32 = 500;

/// 本部署的上限（`CHAT_QUOTA_LIMIT`）。
pub fn limit() -> i32 {
    parse_limit(std::env::var("CHAT_QUOTA_LIMIT").ok().as_deref())
}

/// `limit()` 的纯函数内核（可测，且不碰进程环境）。
///
/// **非正数一律回落成默认值**，而不是照单全收：`CHAT_QUOTA_LIMIT=0` 或一个手滑的
/// 负值会让全站普通用户在下一轮集体被拦，而配置错误的症状（"所有人都不能说话了"）
/// 与"额度功能上线了"长得几乎一样。上限是护城河不是闸刀，写坏了就退回 500。
fn parse_limit(raw: Option<&str>) -> i32 {
    match raw.map(str::trim).and_then(|v| v.parse::<i32>().ok()) {
        Some(v) if v > 0 => v,
        _ => LIMIT_DEFAULT,
    }
}

/// 这个人是不是不限量。**只认 `authz::can_access_console`**（admin + superadmin），
/// 其余角色一律按有限算（未知 = 最保守，与 `authz` 的失败取向一致）；
/// 查不到角色（`None`）= 身份不明 ⇒ 有限。
pub fn is_unlimited(role: Option<&str>) -> bool {
    role.map(authz::can_access_console).unwrap_or(false)
}

/// 一次「扣一轮」的结果。**三态而不是 bool**：`Degraded`（DB 故障）的处置方向与
/// `Exhausted`（真的用完了）**正好相反**，压成 bool 就是把"读不到"当成"用完了"。
#[derive(Debug, PartialEq, Eq)]
pub enum ConsumeOutcome {
    Consumed,
    Exhausted,
    /// DB 故障：**fail-open**，放行且不计数
    Degraded,
}

/// 共享额度视图，由 forward_json 统一序列化；不限额时计数字段为零。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaView {
    pub used: i32,
    pub limit: i32,
    pub remaining: i32,
    pub unlimited: bool,
}

/// 组装视图。纯函数、饱和：`used > limit` 时剩余钳到 0（存量脏值不该让界面显示负数）。
/// 不限档统一成 `{0,0,0,true}`——**四个数一律 0 而不是真实用量**：agent 侧只读
/// `unlimited` 那一支，给它一个"用了 0 轮"的假事实正是要防的东西。
pub fn view(used: i32, limit: i32, unlimited: bool) -> QuotaView {
    if unlimited {
        return QuotaView { used: 0, limit: 0, remaining: 0, unlimited: true };
    }
    let used = used.max(0);
    let limit = limit.max(0);
    QuotaView { used, limit, remaining: (limit - used).max(0), unlimited: false }
}

/// 序列化 Rust 发往 Agent 的 chat_quota 对象。
/// 额度不可用时调用方省略整个字段，不能用零值表示读取失败。
pub fn forward_json(v: &QuotaView) -> serde_json::Value {
    serde_json::json!({
        "used": v.used,
        "limit": v.limit,
        "remaining": v.remaining,
        "unlimited": v.unlimited,
    })
}

/// 扣掉一轮——**一条语句，没有"先查后写"的窗口**。
pub async fn try_consume(db: &DatabaseConnection, uid: i32, limit: i32) -> ConsumeOutcome {
    let res = user::Entity::update_many()
        .col_expr(
            user::Column::ChatQuotaUsed,
            Expr::col(user::Column::ChatQuotaUsed).add(1),
        )
        .filter(user::Column::Id.eq(uid))
        .filter(user::Column::ChatQuotaUsed.lt(limit))
        .exec(db)
        .await;

    match res {
        Ok(r) if r.rows_affected == 1 => ConsumeOutcome::Consumed,
        Ok(r) => {
            // 0 = 被 `WHERE ... < ?` 挡住（额度已满）。>1 说明 uid 不是唯一键——不可能，
            // 但不假装它不可能：如实记下来，别让它在日志里无声。
            if r.rows_affected > 1 {
                warn!(uid = uid, rows = r.rows_affected, "额度计数影响的不是一行（uid 应为主键）");
            }
            ConsumeOutcome::Exhausted
        }
        Err(e) => {
            warn!(uid = uid, error = %e, "额度计数失败：本轮放行且不计数（fail-open）");
            ConsumeOutcome::Degraded
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 上限的读法
    #[test]
    fn 上限没设或设坏了一律回落() {
        assert_eq!(parse_limit(None), 500);
        assert_eq!(parse_limit(Some("")), 500);
        assert_eq!(parse_limit(Some("  ")), 500);
        assert_eq!(parse_limit(Some("abc")), 500);
        assert_eq!(parse_limit(Some("5.5")), 500);
        assert_eq!(parse_limit(Some("500轮")), 500);
    }

    #[test]
    fn 上限非正数回落不是照单全收() {
        // 这一条是"配置手滑 ⇒ 全站集体静音"的锁：0 与负值都必须退回默认值
        assert_eq!(parse_limit(Some("0")), 500);
        assert_eq!(parse_limit(Some("-1")), 500);
        assert_eq!(parse_limit(Some("-500")), 500);
    }

    #[test]
    fn 上限设对了就用它() {
        assert_eq!(parse_limit(Some("500")), 500);
        assert_eq!(parse_limit(Some(" 1000 ")), 1000);
        assert_eq!(parse_limit(Some("1")), 1);
    }

    // 谁不限量
    #[test]
    fn 只有能进后台的人不限量() {
        assert!(is_unlimited(Some(authz::ROLE_ADMIN)));
        assert!(is_unlimited(Some(authz::ROLE_SUPERADMIN)));
        assert!(!is_unlimited(Some(authz::ROLE_USER)));
        assert!(!is_unlimited(Some(authz::ROLE_ZAKO)));
        // 未知角色 = 最保守（不默认放行），查不到角色 = 身份不明 ⇒ 有限
        assert!(!is_unlimited(Some("root")));
        assert!(!is_unlimited(Some("")));
        assert!(!is_unlimited(None));
    }

    // 视图与饱和
    #[test]
    fn 剩余就是上限减已用() {
        let v = view(137, 500, false);
        assert_eq!(v.used, 137);
        assert_eq!(v.limit, 500);
        assert_eq!(v.remaining, 363);
        assert!(!v.unlimited);

        assert_eq!(view(0, 500, false).remaining, 500);
        assert_eq!(view(500, 500, false).remaining, 0);
    }

    #[test]
    fn 超限的存量值不会显示负数() {
        // 上限被调小过、或计数器被手工推过头：剩余钳到 0，已用照实显示
        let v = view(520, 500, false);
        assert_eq!(v.used, 520);
        assert_eq!(v.remaining, 0);
        assert_eq!(view(600, 500, false).remaining, 0);
        // 负数（脏值）夹回 0，不参与算术
        assert_eq!(view(-3, 500, false).used, 0);
        assert_eq!(view(-3, 500, false).remaining, 500);
    }

    #[test]
    fn 不限档四个数一律为零() {
        let v = view(137, 500, true);
        assert_eq!(v, QuotaView { used: 0, limit: 0, remaining: 0, unlimited: true });
    }

    // 核对跨服务额度字段。
    #[test]
    fn 转发对象恰好是那四个键() {
        let v = view(137, 500, false);
        let j = forward_json(&v);
        let obj = j.as_object().expect("C1 是 JSON 对象不是 JSON 串");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["limit", "remaining", "unlimited", "used"]);
        assert_eq!(obj["used"], 137);
        assert_eq!(obj["limit"], 500);
        assert_eq!(obj["remaining"], 363);
        assert_eq!(obj["unlimited"], false);
    }

    #[test]
    fn 不限档的形状是四个零加一个真() {
        let j = forward_json(&view(137, 500, true));
        assert_eq!(j["used"], 0);
        assert_eq!(j["limit"], 0);
        assert_eq!(j["remaining"], 0);
        assert_eq!(j["unlimited"], true);
        // 是布尔不是字符串：agent 侧 pydantic 的 bool 收不下 "true"
        assert!(j["unlimited"].is_boolean());
        assert!(j["used"].is_i64() || j["used"].is_u64());
    }
}
