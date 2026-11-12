use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{Duration, NaiveDateTime};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, Set,
};

use crate::entity::{note_comment, talk, user};
use crate::routes::AppState;

/// web_info 中的风控配置键，供读取和设置接口共用。
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

/// 缺键或解析失败使用默认值；非正值显式关闭对应策略。
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

/// 每次发帖读取配置；读取失败时采用默认阈值。
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
    /// 触发自动禁言；本条内容强制转人工，通知为尽力投递。
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
    /// 评论和留言共用拒绝说明；禁言期限由 authz 格式化。
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

/// 内容落库前执行风控副作用；true 表示强制转人工，但不覆盖审核驳回结果。
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

/// 评论与留言的统一风控入口。判定错误时不写禁言或通知；间隔检查仍记录发送尝试。
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

    // 非正间隔由 check_and_mark 解释为关闭；计数器仅保存在当前进程。
    if let Err(retry_after_secs) = state.post_limiter.check_and_mark(uid, cfg.min_interval_secs) {
        return Err(RiskReject::TooSoon { retry_after_secs });
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

/// 内容落库前写入禁言，再尽力发送通知；禁言写入失败时不发送成功通知。
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
    // 已生效的禁言不续期，避免并发请求延长截止时间。
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

/// 限流通知说明触发原因和内容转人工的结果。
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

/// 禁言通知包含触发原因、次数和当前可用能力。
fn mute_notice_body(count: i64, until: NaiveDateTime, now: NaiveDateTime) -> String {
    // 与 authz 的拒绝说明共用期限格式。
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

/// 分别利用评论与留言的用户/时间索引计数，再求和。
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

/// 按用户记录放行的发送尝试；后续校验或写入失败仍占用最小间隔。
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

    /// 放行时记录时间；拒绝时返回剩余秒数。gap_secs <= 0 关闭间隔限制。
    pub fn check_and_mark(&self, uid: i32, gap_secs: i64) -> Result<(), i64> {
        if gap_secs <= 0 {
            return Ok(());
        }
        let now = Instant::now();
        let gap = std::time::Duration::from_secs(gap_secs as u64);
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

    /// 读取和设置使用同一组风控配置键。
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

    /// 自动与人工禁言共用拒绝说明。
    #[test]
    fn 拒发话术禁言那条与人工禁言同源() {
        let until =
            NaiveDateTime::parse_from_str("2026-10-04 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let mine = RiskReject::AlreadyMuted { until }.message();
        assert!(mine.starts_with("你已被禁言，至 2026-10-04 12:00"), "{mine}");
        assert!(mine.contains("不能发布评论与留言"), "{mine}");
        // 永久禁言不展示哨兵日期。
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
        assert!(body.contains("本条内容照常保留、已转人工复核"), "{body}");
        // 永久那一支直说永久，不念哨兵值
        let forever = mute_notice_body(99, crate::authz::mute_forever_at(), now);
        assert!(forever.contains("（永久）"), "{forever}");
        assert!(!forever.contains("9999"), "{forever}");
    }
}
