//! 用户对话额度（20260929）——**判据的唯一落点**。
//!
//! 口径（用户逐条拍板，实现不许再改）：**普通用户终身 500 轮**、含检索轮；确认轮不计；
//! 管理员不设限；用尽 = 硬拦（零 LLM、零工具、不计数，但照常进对话记录）；唯一恢复
//! 途径 = 管理员清零。列与表的语义、四段承重论证见
//! `scripts/migration/user_chat_quota_20260929.sql` 头注。
//!
//! **为什么住在这里而不是 `routes/` 下**：上限与角色判据有两个消费方——`chat.rs` 的
//! 闸门与 `routes/quota.rs` / `routes/temp_user.rs` 的展示与重置。放进 routes 会让
//! "每轮 1 轮"这条算术被两处各写一遍，而两份判据的漂移表现是静默多算/少算。
//!
//! **与 `authz.rs` 的分工**：谁不限量归 `authz`（`can_access_console`），限量是多少、
//! 怎么算剩余、怎么原子扣一轮归这里。所以 `is_unlimited` 是**委托**而不是内联第二个
//! 角色比较——20260926 加超管那次正是因为判据只有 `can_access_console` 一处，
//! 超管才自动跟着走；内联一份 `role == "admin" || role == "superadmin"` 就会在
//! 下一次加角色时漏掉（漏的表现同样是静默：那个人每轮都被扣，或者反过来不扣）。
//!
//! 上限**不存库**，走环境变量（`CHAT_QUOTA_LIMIT`，默认 500）——上限是策略、用量是
//! 事实，两者生命周期不同：改上限不该需要一次迁移。与 `chat.rs` 的
//! `CHAT_HISTORY_LIMIT` 同一形态（那是**每会话** 500 条，与"这辈子能用多少轮"
//! 毫无关系，两者不许混）。

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use tracing::warn;

use crate::authz;
use crate::entity::user;

/// 上限的兜底值：环境变量没设/设坏了都用它。**两侧都不许把这个数字写死**——
/// 前端从 `chatQuotaLimit` 读、agent 从 `chat_quota.limit` 读。
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
/// 秘书与未知角色一律按有限算（未知 = 最保守，与 `authz` 的失败取向一致）；
/// 查不到角色（`None`）= 身份不明 ⇒ 有限。
pub fn is_unlimited(role: Option<&str>) -> bool {
    role.map(authz::can_access_console).unwrap_or(false)
}

/// 一次「扣一轮」的结果。**三态而不是 bool**：`Degraded`（DB 故障）的处置方向与
/// `Exhausted`（真的用完了）**正好相反**，压成 bool 就是把"读不到"当成"用完了"。
#[derive(Debug, PartialEq, Eq)]
pub enum ConsumeOutcome {
    /// 抢到了这一轮（`rows_affected == 1`）
    Consumed,
    /// 额度已满，这一轮**没有**被计数
    Exhausted,
    /// DB 故障：**fail-open**，放行且不计数
    Degraded,
}

/// 给 `chat.rs` 与展示端共用的额度视图（不限档四个数全是 0，见 `view`）。
///
/// **刻意不 derive `Serialize`**：C1 的线上形状（`used/limit/remaining/unlimited`）
/// 只有 `forward_json` 一个写者。加了 Serialize 就是第二个写者——字段改名/加字段时
/// 两边各改一半，症状是 agent 那边收到一个它不认识的键、静默按"没这个字段"处理。
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

/// C1 契约的**唯一写者**（Rust → agent，`/chat` 与 `/chat/stream` 的 body）。
///
/// 是 JSON **对象**而不是 JSON 串——**刻意与 `agent_tasks` 不同**（那个是串）。
/// 理由：形状由本端拥有且极简，agent 侧 pydantic 的 int 类型让注入结构性不可能，
/// 所以不需要 `_ctx_field` 那套清洗。**这处不一致是故意的，别来"统一"它。**
///
/// 读不到额度时**整个键缺席**（调用方不插这个键），**不许发一个零值**：
/// 缺席是"读不到"，零值是"剩 0 轮"——后者会让 agent 对着正在说话的访客说一句
/// 他自己能用一次刷新证伪的话。
pub fn forward_json(v: &QuotaView) -> serde_json::Value {
    serde_json::json!({
        "used": v.used,
        "limit": v.limit,
        "remaining": v.remaining,
        "unlimited": v.unlimited,
    })
}

/// 扣掉一轮——**一条语句，没有"先查后写"的窗口**。
///
/// ```sql
/// UPDATE user SET chat_quota_used = chat_quota_used + 1
///  WHERE id = ? AND chat_quota_used < ?
/// ```
///
/// 三件必须写下来的事（每一条都是"下一个人顺手改一下"就会静默翻转的那种）：
///
/// ① `rows_affected == 1` **可靠地**等于"抢到了"。MySQL 默认下 `rows_affected` 数的是
///    **真正改变的行**，而这里的 `SET` 恒递增 ⇒ 匹配到就一定改变 ⇒ 1 就是匹配到、
///    0 就是被 `WHERE ... < ?` 挡住。**不许把它"优化"成可能匹配而不改变的写法**
///    （例如用 `CASE` 把超限行的值写成原值）——那时 0 的含义会在"没抢到"与"抢到了但
///    没变"之间漂移，而漂移的表现是最后一格额度被扣两次。
/// ② `Degraded` **fail-open**（放行、不计数、只 `warn!`）：与它上方几十行那次角色查询
///    同一取向——**DB 故障只降级，不阻断对话**。反过来（fail-closed）等于"数据库抖
///    一下全站不能说话"，代价远大于"极少数轮次不计费"。
/// ③ 结论**由调用点决定**（`chat.rs`）：`Degraded` 时 `chat_quota` **整个键缺席**，
///    绝不发零值——理由同 `forward_json` 的注释。
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

    // ── 上限的读法 ────────────────────────────────────────────────────────
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

    // ── 谁不限量 ──────────────────────────────────────────────────────────
    #[test]
    fn 只有能进后台的人不限量() {
        assert!(is_unlimited(Some(authz::ROLE_ADMIN)));
        assert!(is_unlimited(Some(authz::ROLE_SUPERADMIN)));
        // 秘书能读他人数据、能代做写操作，但**额度按普通用户算**（用户拍板）
        assert!(!is_unlimited(Some(authz::ROLE_SECRETARY)));
        assert!(!is_unlimited(Some(authz::ROLE_USER)));
        // 未知角色 = 最保守（不默认放行），查不到角色 = 身份不明 ⇒ 有限
        assert!(!is_unlimited(Some("root")));
        assert!(!is_unlimited(Some("")));
        assert!(!is_unlimited(None));
    }

    // ── 视图与饱和 ────────────────────────────────────────────────────────
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

    // ── C1 契约的形状 ─────────────────────────────────────────────────────
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
