//! 内容风控（20261002）：发评论 / 发留言共用的**入口闸**。
//!
//! 需求原文：「监控异常评论和留言用户，短期内大量评论留言会被风控，增加禁言机制」。
//!
//! ── 分级（主人拍板，两档 + 一道硬闸）──────────────────────────────────────
//! 进 `POST` 评论 / 发留言的入口先过 [`screen`]，按**窗口内的发帖数**（评论与留言
//! **合起来算**——用户原话是"大量留言评论"）分档：
//!
//! | 档 | 判据 | 行为 |
//! |---|---|---|
//! | 正常 | `n + 1 < rate_limit` | 照常 |
//! | 限流 | `rate_limit ≤ n + 1 < mute_limit` | **本条强制转人工**（忽略两个审核开关）+ 通知本人 |
//! | 自动禁言 | `n + 1 ≥ mute_limit` | 写 `muted_until` + 通知本人；**本条照常入库转待审** |
//! | 已在禁言期 | `authz::is_muted` | **直接拒、不入库** |
//! | 间隔不足 | 距上一条 < `min_interval` | 拒发，回剩余秒数 |
//!
//! 顺序：**先查禁言 → 再查间隔 → 再数窗口**。禁言是硬闸、也最省事（一次主键查），
//! 排在最先；间隔在窗口之前，是因为它决定"这条要不要计入"这件事根本不该发生。
//!
//! **触发禁言那一刻的内容不丢**（主人拍板）：越可疑越要留证据给管理员，所以那一档
//! 的行为是"照常入库 + 转待审"，不是"拒绝并丢弃"。
//!
//! ── 两件事用两种存储，各有各的理由 ────────────────────────────────────────
//! · **窗口计数查库**（`note_comment` + `talk(src='board')` 两条 COUNT）。不用内存计数器：
//!   内存计数器在**部署时归零**，而本机就是生产、一天可能部署多次——归零等于给刷子一个
//!   "等一次部署"的绕过窗口。两条 `(user_id, created_at)` 索引已就位（见两份迁移），
//!   覆盖索引扫描，写入路径上一次 COUNT 完全可以接受。
//!   **截止时刻在 Rust 侧算**（`Local::now()`，+08:00 本地钟面），不用 SQL 的 `NOW()`
//!   ——本仓的时间约定是"本地钟面直读"，交给 SQL 函数只会引入第二次时区解释。
//! · **最小间隔用内存**（[`PostRateLimiter`]）：它是"刹车"不是"事实"。重启丢失不构成
//!   绕过（窗口计数与禁言都在库里），而它需要亚分钟精度，为此每次发帖写一次库不值。
//!
//! ── 阈值不许硬编码 ────────────────────────────────────────────────────────
//! 五个键住 `web_info`（KV 表，**不需要迁移**：没配过就是默认值）。前缀是 `content*`
//! 而不是 `comment*`——这一套管的是评论与留言**两种**内容：

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{Duration, NaiveDateTime};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, Set,
};

use crate::entity::{note_comment, talk, user};
use crate::routes::AppState;

/// 风控的五个配置键（`web_info` KV）。**只在这里列一次**：读取、前端设置卡、
/// agent 文档都引用这一组，谁都不许手抄字面量。
pub const RISK_KEYS: [&str; 5] = [
    "contentRateWindowSecs",
    "contentMinIntervalSecs",
    "contentRateLimit",
    "contentMuteLimit",
    "contentMuteHours",
];

/// 风控阈值。**每一档都能显式关闭**（见 [`parse_config`] 的取值规则）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RiskConfig {
    /// 滑动窗口（秒）。`<= 0` = 不做窗口计数（限流与自动禁言随之关闭）
    pub window_secs: i64,
    /// 两次发言的最小间隔（秒）。`<= 0` = 不限
    pub min_interval_secs: i64,
    /// 达到它 ⇒ 本条转人工 + 通知本人。`<= 0` = 不因频率转人工
    pub rate_limit: i64,
    /// 达到它 ⇒ 自动临时禁言。`<= 0` = 不自动禁言
    pub mute_limit: i64,
    /// 自动禁言的时长（小时）。`<= 0` = 自动禁言档关闭
    /// （"禁 0 小时"不是一档有效的处置，所以它按关闭处理）
    pub mute_hours: i64,
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            window_secs: 600,
            min_interval_secs: 5,
            rate_limit: 10,
            mute_limit: 20,
            mute_hours: 24,
        }
    }
}

/// 从 KV 读到的原始字符串解析出配置。**纯函数**（不碰库、不碰时间），所以三条取值
/// 规则可以被单测逐格钉住：
///
///   · **缺键** ⇒ 用默认值（没配过就是这个特性的出厂状态）；
///   · **解析失败**（`abc`、空串、`12.5`）⇒ **回落默认值**，不是回落 0——
///     填错一个键不该意外把闸门关掉；
///   · **值 `<= 0`** ⇒ 该档**显式关闭**。"关掉风控"是一个可表达的状态，
///     而不是靠填一个荒谬的数去逼近。
pub fn parse_config(get: impl Fn(&str) -> Option<String>) -> RiskConfig {
    let d = RiskConfig::default();
    let one = |key: &str, fallback: i64| -> i64 {
        match get(key) {
            None => fallback,
            Some(raw) => match raw.trim().parse::<i64>() {
                Ok(v) => v, // v <= 0 原样留着 = 该档关闭的下游判据
                Err(_) => fallback,
            },
        }
    };
    RiskConfig {
        window_secs: one(RISK_KEYS[0], d.window_secs),
        min_interval_secs: one(RISK_KEYS[1], d.min_interval_secs),
        rate_limit: one(RISK_KEYS[2], d.rate_limit),
        mute_limit: one(RISK_KEYS[3], d.mute_limit),
        mute_hours: one(RISK_KEYS[4], d.mute_hours),
    }
}

/// 从库里读一次配置（每个发帖请求一次，一条 `SELECT`）。读库失败 ⇒ 默认值
/// （**失败取向不是"放行"**：默认值本身就是有阈值的，只是不是主人调过的那组）。
pub async fn load_config(db: &DatabaseConnection) -> RiskConfig {
    let rows = crate::entity::web_info::Entity::find()
        .filter(crate::entity::web_info::Column::KeyName.is_in(RISK_KEYS.to_vec()))
        .all(db)
        .await
        .unwrap_or_default();
    let map: HashMap<String, String> =
        rows.into_iter().map(|r| (r.key_name, r.value)).collect();
    parse_config(|k| map.get(k).cloned())
}

/// 放行时的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskVerdict {
    /// 正常：照常走审核链路
    Pass,
    /// 限流档：**本条强制转人工**（忽略两个审核开关）
    RateLimited { count: i64 },
    /// 触发自动禁言：`muted_until` 已写库、本人已收到通知；**本条同样强制转人工**
    Muted { until: NaiveDateTime, count: i64 },
}

/// 拒发的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskReject {
    /// 已在禁言期：直接拒、**不入库**（与"触发禁言那一刻"的处理相反，那一档要留证据）
    AlreadyMuted { until: NaiveDateTime },
    /// 距上一条太近
    TooSoon { retry_after_secs: i64 },
}

impl RiskReject {
    /// 拒发时给当事人看的一句话。**两个入口共用这一处**：分开写的话，"被禁言"
    /// 在评论与留言两条路上会长出两套说法，其中一套迟早会忘了说许可到什么时候。
    ///
    /// 禁言那条走 `authz::mute_denial_message`（人工禁言与自动禁言要说同一句话，
    /// 见 `docs/security-boundary.md §7⑫` 的跨语言契约）。
    pub fn message(&self) -> String {
        match self {
            RiskReject::AlreadyMuted { until } => crate::authz::mute_denial_message(
                *until,
                chrono::Local::now().naive_local(),
            ),
            RiskReject::TooSoon { retry_after_secs } => {
                format!("发得太快了，{retry_after_secs} 秒后再试。")
            }
        }
    }
}

/// 判定通过之后、内容落库**之前**的副作用。返回 **`true` = 本条强制转人工**
/// （两个入口拿到它之后都做同一件事：`if forced && approved == 1 { approved = 0 }`
/// ——**只把 1 压成 0**，绝不把 AI 已驳回的 2 松成待审；见 `decide_review` 的裁决语义）。
///
/// 两个 handler 共用这一个函数：这样"限流档要不要通知本人""禁言档写不写库"只有一处答案，
/// 将来加一档（比如更重的处置）也不会出现"评论做了、留言忘了"。
pub async fn apply_verdict(
    state: &AppState,
    uid: i32,
    cfg: &RiskConfig,
    verdict: RiskVerdict,
) -> bool {
    match verdict {
        RiskVerdict::Pass => false,
        RiskVerdict::RateLimited { count } => {
            notify_rate_limited(state, uid, count, cfg.window_secs).await;
            true
        }
        RiskVerdict::Muted { until, count } => {
            apply_auto_mute(state, uid, until, count).await;
            true
        }
    }
}

/// 发帖入口的闸。**这是评论与留言唯一的风控调用点**（两个 handler 各调一次，
/// 行为由本函数一处决定——两处各写一份判据必然会在某天只剩一处被改）。
///
/// 只有 `Ok(RiskVerdict::RateLimited | Muted)` 时才会写库（禁言）与发通知；
/// `Err` 只回原因，不产生任何副作用（除了间隔那条已经记下这一次尝试）。
pub async fn screen(
    state: &AppState,
    uid: i32,
    cfg: &RiskConfig,
) -> Result<RiskVerdict, RiskReject> {
    let now = chrono::Local::now().naive_local();

    // ① 禁言是硬闸（也最便宜：主键查一次）
    let row = user::Entity::find_by_id(uid).one(&state.db).await.unwrap_or(None);
    if let Some(u) = &row {
        if crate::authz::is_muted(u.muted_until, now) {
            return Err(RiskReject::AlreadyMuted {
                until: u.muted_until.expect("is_muted 为真必有到期时刻"),
            });
        }
    }

    // ② 最小间隔（内存计数器：重启丢失不构成绕过，见模块头注）
    if cfg.min_interval_secs > 0 {
        if let Err(retry_after_secs) = state.post_limiter.check_and_mark(uid, cfg.min_interval_secs) {
            return Err(RiskReject::TooSoon { retry_after_secs });
        }
    }

    // ③ 窗口计数（查库：跨重启、跨部署都在）
    if cfg.window_secs <= 0 {
        return Ok(RiskVerdict::Pass);
    }
    let since = now - Duration::seconds(cfg.window_secs);
    let n = count_recent(state, uid, since).await;
    let n1 = n + 1;
    if cfg.mute_limit > 0 && cfg.mute_hours > 0 && n1 >= cfg.mute_limit {
        let until = now + Duration::hours(cfg.mute_hours);
        return Ok(RiskVerdict::Muted { until, count: n1 });
    }
    if cfg.rate_limit > 0 && n1 >= cfg.rate_limit {
        return Ok(RiskVerdict::RateLimited { count: n1 });
    }
    Ok(RiskVerdict::Pass)
}

/// 自动禁言的落库 + 通知。**在内容落库之前调用**（`screen` 只判定，这里是副作用），
/// 两个 handler 共用，保证"触发禁言"这件事在两条链路上的表现逐字相同。
///
/// 通知**先落库再发**（同冻结那条纪律）：写失败时不能留下一条"你已被禁言"的假通知。
/// 通知失败只记一行日志——它是 best-effort，绝不影响发帖本身。
pub async fn apply_auto_mute(state: &AppState, uid: i32, until: NaiveDateTime, count: i64) {
    let now = chrono::Local::now().naive_local();
    let row = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(u)) => u,
        Ok(None) => return,
        Err(e) => {
            tracing::error!("[risk] 自动禁言查用户失败 uid={uid}: {e}");
            return;
        }
    };
    // 已经在禁言期就别再写一次（并发两条同时越过阈值时，第二次不该把到期时间接着往后推
    // ——"禁言被无限续期"是刷子最容易制造出来的形态）
    if crate::authz::is_muted(row.muted_until, now) {
        return;
    }
    let mut am: user::ActiveModel = row.into();
    am.muted_until = Set(Some(until));
    if let Err(e) = am.update(&state.db).await {
        tracing::error!("[risk] 自动禁言写库失败 uid={uid}: {e}");
        return;
    }
    tracing::info!(
        "[risk] 自动禁言 uid={uid} count={count} until={}",
        until.format("%Y-%m-%d %H:%M:%S")
    );
    crate::routes::notice::push_notice(
        &state.db,
        uid,
        "账号已被临时禁言",
        Some(mute_notice_body(count, until, now)),
        None,
    )
    .await;
}

/// 限流档给本人的通知：**说清为什么、本条去哪了**（不说的话，当事人只看到"评论没显示"，
/// 会当成发送失败反复重发，而那正好是我们要拦的行为）。
pub async fn notify_rate_limited(state: &AppState, uid: i32, count: i64, window_secs: i64) {
    crate::routes::notice::push_notice(
        &state.db,
        uid,
        "发言频率较高，本条需人工复核",
        Some(format!(
            "你在 {} 内发布了 {count} 条评论或留言，频率较高，本条已转人工复核，通过后才会公开。\
             放慢一点就不会再触发。",
            window_text(window_secs)
        )),
        None,
    )
    .await;
}

/// 禁言通知正文。与 `authz::mute_denial_message` **同一组事实、不同的句子**：
/// 那条是"你被拒了"的当面回执，这条是事后留档的通知（所以带上了触发原因与条数）。
fn mute_notice_body(count: i64, until: NaiveDateTime, now: NaiveDateTime) -> String {
    // 期限的措辞**整块交给 `authz::mute_span_text`**（"（永久）" / "至 X（还剩约 Y）"）：
    // 这个函数原来自己判了一次哨兵、自己 `format!` 了一次日期，于是"至 X"在仓库里
    // 有了第三份实现——哨兵值或格式一改，后台回执与个人中心横幅跟着变，这里不会。
    let how_long = crate::authz::mute_span_text(until, now);
    format!(
        "你在短时间内发布了 {count} 条评论或留言，已被临时禁言{how_long}。\
         本条内容照常保留、已转人工复核，通过后才会公开。\
         禁言期间你仍可登录、浏览文章与对话，但不能发布评论和留言。"
    )
}

/// 窗口长度的人话（配置可改，所以不能写死"10 分钟"）。
fn window_text(window_secs: i64) -> String {
    if window_secs >= 3600 {
        format!("{} 小时", window_secs / 3600)
    } else if window_secs >= 60 {
        format!("{} 分钟", window_secs / 60)
    } else {
        format!("{window_secs} 秒")
    }
}

/// 窗口内这个人发了多少条（评论 + 留言**合起来**）。
///
/// 两张表各一次 COUNT。**不用 `UNION` 一条 SQL 图省事**：两条走各自的
/// `(user_id, created_at)` 索引，计划更可控，而这里本来就只有两次往返。
async fn count_recent(state: &AppState, uid: i32, since: NaiveDateTime) -> i64 {
    let comments = note_comment::Entity::find()
        .filter(note_comment::Column::UserId.eq(uid))
        .filter(note_comment::Column::CreatedAt.gte(since))
        .count(&state.db)
        .await
        .unwrap_or(0) as i64;
    let talks = talk::Entity::find()
        .filter(talk::Column::UserId.eq(uid))
        .filter(talk::Column::Src.eq("board"))
        .filter(talk::Column::CreatedAt.gte(since))
        .count(&state.db)
        .await
        .unwrap_or(0) as i64;
    comments + talks
}

/// 发言最小间隔的刹车（形态照抄 `rate_limiter::LoginRateLimiter`：`Mutex<HashMap>`、
/// 惰性清理、无外部依赖）。
///
/// 它记的是**每一次放行的尝试**（不是每一次成功落库）：写失败/校验失败也占掉这个间隔。
/// 这是刻意的——它的职责是"别让人以机器速度连打接口"，而不是精确记账；把它做成
/// "成功才记"会在失败重试那条路径上完全失效，而那正是脚本的形态。
#[derive(Clone)]
pub struct PostRateLimiter {
    last: Arc<Mutex<HashMap<i32, Instant>>>,
}

impl Default for PostRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl PostRateLimiter {
    pub fn new() -> Self {
        Self { last: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// `Ok(())` = 可以发（并记下这一刻）；`Err(剩余秒数)` = 太近。
    pub fn check_and_mark(&self, uid: i32, gap_secs: i64) -> Result<(), i64> {
        let now = Instant::now();
        let gap = std::time::Duration::from_secs(gap_secs.max(1) as u64);
        let mut map = match self.last.lock() {
            Ok(m) => m,
            // 互斥锁中毒（别的线程 panic 过）：宁可放行，也不要因为一把锁让全站发不出内容
            Err(_) => return Ok(()),
        };
        // 惰性清理：条目只在窗口内有用，攒到一定量时把过期的丢掉
        if map.len() > 4096 {
            map.retain(|_, t| now.duration_since(*t) < gap * 8);
        }
        if let Some(prev) = map.get(&uid) {
            let elapsed = now.duration_since(*prev);
            if elapsed < gap {
                return Err((gap - elapsed).as_secs().max(1) as i64);
            }
        }
        map.insert(uid, now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_from(pairs: &[(&str, &str)]) -> RiskConfig {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        parse_config(|k| map.get(k).cloned())
    }

    /// 缺键 = 出厂默认（"没配过"与"配成关"是两件事）
    #[test]
    fn 缺键时用默认值() {
        assert_eq!(cfg_from(&[]), RiskConfig::default());
    }

    /// 解析失败回落**默认值**而不是 0：填错一个键不该把闸门关掉
    #[test]
    fn 解析失败回落默认而不是关闭() {
        let c = cfg_from(&[
            ("contentRateWindowSecs", "abc"),
            ("contentMinIntervalSecs", ""),
            ("contentRateLimit", "12.5"),
            ("contentMuteLimit", "  "),
            ("contentMuteHours", "半夜"),
        ]);
        assert_eq!(c, RiskConfig::default());
    }

    /// 值 <= 0 = 该档**显式关闭**（"关掉风控"是一个可表达的状态）
    #[test]
    fn 非正值是显式关闭() {
        let c = cfg_from(&[
            ("contentRateWindowSecs", "0"),
            ("contentMinIntervalSecs", "-1"),
            ("contentRateLimit", "0"),
            ("contentMuteLimit", "-5"),
            ("contentMuteHours", "0"),
        ]);
        assert_eq!(c.window_secs, 0);
        assert_eq!(c.min_interval_secs, -1);
        assert_eq!(c.rate_limit, 0);
        assert_eq!(c.mute_limit, -5);
        assert_eq!(c.mute_hours, 0);
    }

    /// 正常值原样读进来（含前后空白）
    #[test]
    fn 正常值照读() {
        let c = cfg_from(&[
            ("contentRateWindowSecs", "120"),
            ("contentMinIntervalSecs", " 3 "),
            ("contentRateLimit", "5"),
            ("contentMuteLimit", "8"),
            ("contentMuteHours", "48"),
        ]);
        assert_eq!(c.window_secs, 120);
        assert_eq!(c.min_interval_secs, 3);
        assert_eq!(c.rate_limit, 5);
        assert_eq!(c.mute_limit, 8);
        assert_eq!(c.mute_hours, 48);
    }

    /// 五个键**只在这一处列**：加了配置项却忘了加进 `RISK_KEYS`，
    /// 表现是"设置卡上改了、后端读不到"（静默失效）——这条钉住数量与内容。
    #[test]
    fn 配置键清单不许少项() {
        assert_eq!(RISK_KEYS.len(), 5);
        assert!(RISK_KEYS.iter().all(|k| k.starts_with("content")),
            "前缀是 content（评论与留言两种内容共用），不是 comment：{RISK_KEYS:?}");
        let d = RiskConfig::default();
        let all = cfg_from(&[
            (RISK_KEYS[0], &d.window_secs.to_string()),
            (RISK_KEYS[1], &d.min_interval_secs.to_string()),
            (RISK_KEYS[2], &d.rate_limit.to_string()),
            (RISK_KEYS[3], &d.mute_limit.to_string()),
            (RISK_KEYS[4], &d.mute_hours.to_string()),
        ]);
        assert_eq!(all, d, "五个键名各自对应得上一个字段");
    }

    /// 最小间隔：第一次放行，紧接着第二次被拒且给出剩余秒数，隔开之后又放行。
    #[test]
    fn 最小间隔先放行再拦住() {
        let limiter = PostRateLimiter::new();
        assert_eq!(limiter.check_and_mark(7, 5), Ok(()));
        let err = limiter.check_and_mark(7, 5).unwrap_err();
        assert!((1..=5).contains(&err), "剩余秒数应在 1..=5，实得 {err}");
        // 别人不受影响（按 uid 分桶，不是全站一把闸）
        assert_eq!(limiter.check_and_mark(8, 5), Ok(()));
        // 间隔 0 秒 = 不限：连发两次都放行
        assert_eq!(limiter.check_and_mark(9, 0), Ok(()));
        assert_eq!(limiter.check_and_mark(9, 0), Ok(()));
    }

    /// 窗口长度的人话（配置可改，界面上不能写死"10 分钟"）
    /// 拒发话术：**禁言那条不许在风控里另写一份**（它必须与人工禁言的当面对话逐字同源，
    /// 否则同一个状态会长出两种解释）。所以这里断言的是"它与 `authz` 那一份相同"。
    #[test]
    fn 拒发话术禁言那条与人工禁言同源() {
        let until =
            NaiveDateTime::parse_from_str("2026-10-04 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let mine = RiskReject::AlreadyMuted { until }.message();
        assert!(mine.starts_with("你已被禁言，至 2026-10-04 12:00"), "{mine}");
        assert!(mine.contains("不能发布评论与留言"), "{mine}");
        // 永久那一支（风控自己写不出"永久"这个词，只能从 authz 取）
        let forever = RiskReject::AlreadyMuted { until: crate::authz::mute_forever_at() }.message();
        assert!(forever.contains("永久"), "{forever}");
        assert!(!forever.contains("9999"), "{forever}");

        let soon = RiskReject::TooSoon { retry_after_secs: 3 }.message();
        assert!(soon.contains('3'), "{soon}");
        assert!(soon.contains("秒后再试"), "{soon}");
    }

    #[test]
    fn 窗口文案按量级换单位() {
        assert_eq!(window_text(600), "10 分钟");
        assert_eq!(window_text(3600), "1 小时");
        assert_eq!(window_text(30), "30 秒");
    }

    /// 禁言通知正文：三种时长都要说清"还能做什么"
    #[test]
    fn 禁言通知正文说清还能登录() {
        let now = NaiveDateTime::parse_from_str("2026-10-03 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let until =
            NaiveDateTime::parse_from_str("2026-10-04 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let body = mute_notice_body(21, until, now);
        assert!(body.contains("21 条"), "{body}");
        assert!(body.contains("2026-10-04 12:00"), "{body}");
        assert!(body.contains("24 小时"), "{body}");
        assert!(body.contains("仍可登录、浏览文章与对话"), "{body}");
        // 触发禁言那一条**不被丢弃**（主人拍板）：通知里要说清它去哪了，
        // 否则当事人以为内容没了、转头再发一条——而那正是我们要拦的行为
        assert!(body.contains("本条内容照常保留、已转人工复核"), "{body}");
        // 永久那一支直说永久，不念哨兵值
        let forever = mute_notice_body(99, crate::authz::mute_forever_at(), now);
        assert!(forever.contains("（永久）"), "{forever}");
        assert!(!forever.contains("9999"), "{forever}");
    }
}
