/// 登录失败计数 + 锁定窗口限流器
///
/// 按 IP+用户名 组合跟踪失败次数，超过阈值后锁定一段时间。
/// 锁定期间该 IP+用户名 组合无法登录，无论密码是否正确。
/// 成功登录重置该组合的计数。
///
/// 使用 std::sync::Mutex + HashMap，不引入额外依赖。
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 单个 IP+用户名 组合的限流状态
struct RateLimitEntry {
    /// 当前窗口内的失败时间戳
    attempts: Vec<Instant>,
    /// 锁定到期时间（None = 未锁定）
    locked_until: Option<Instant>,
}

/// 登录限流器
///
/// Clone 代价低（内部是 Arc），可在多个 handler 间共享。
#[derive(Clone)]
pub struct LoginRateLimiter {
    inner: Arc<Mutex<HashMap<String, RateLimitEntry>>>,
    max_attempts: u32,
    window_duration: Duration,
    lockout_duration: Duration,
}

impl LoginRateLimiter {
    /// 创建新的限流器
    ///
    /// - `max_attempts`: 窗口内允许的最大失败次数
    /// - `window_secs`: 滑动窗口时长（秒）
    /// - `lockout_secs`: 超过最大次数后的锁定时长（秒）
    pub fn new(max_attempts: u32, window_secs: u64, lockout_secs: u64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            max_attempts,
            window_duration: Duration::from_secs(window_secs),
            lockout_duration: Duration::from_secs(lockout_secs),
        }
    }

    /// 检查该 IP+用户名 组合是否允许登录
    ///
    /// - `Ok(())` = 允许继续
    /// - `Err(msg)` = 被限流，msg 含剩余等待时间
    pub fn check(&self, ip: &str, username: &str) -> Result<(), String> {
        let key = format!("{}:{}", ip, username);
        let now = Instant::now();

        let mut map = self.inner.lock().unwrap();

        // 惰性清理：map 过大时清理过期条目防内存泄漏
        if map.len() > 10_000 {
            map.retain(|_, v| {
                if let Some(locked_until) = v.locked_until {
                    locked_until > now
                } else {
                    v.attempts.retain(|t| *t > now - self.window_duration * 2);
                    !v.attempts.is_empty()
                }
            });
        }

        let entry = map.entry(key).or_insert(RateLimitEntry {
            attempts: Vec::new(),
            locked_until: None,
        });

        // 检查是否处于锁定状态
        if let Some(locked_until) = entry.locked_until {
            if locked_until > now {
                let remaining = locked_until.duration_since(now).as_secs();
                return Err(format!("登录尝试过于频繁，请 {} 秒后再试", remaining));
            }
            // 锁定已到期，清除状态
            entry.locked_until = None;
            entry.attempts.clear();
        }

        // 清理窗口外的旧记录
        entry.attempts.retain(|t| *t > now - self.window_duration);

        // 检查是否达到阈值
        if entry.attempts.len() >= self.max_attempts as usize {
            entry.locked_until = Some(now + self.lockout_duration);
            return Err(format!(
                "登录尝试过于频繁，请 {} 秒后再试",
                self.lockout_duration.as_secs()
            ));
        }

        // 清理另一条路径：锁定到期后 attempts 已 clear，但这里还可能在
        // 即将达到阈值时立刻锁定，所以上面 len() 检查在 clear 之后
        Ok(())
    }

    /// 记录一次失败尝试
    pub fn record_failure(&self, ip: &str, username: &str) {
        self.push(ip, username);
    }

    /// 计数一次（`record_failure` / `hit` 共用的入口）
    fn push(&self, ip: &str, subject: &str) {
        let key = format!("{}:{}", ip, subject);
        let now = Instant::now();

        if let Ok(mut map) = self.inner.lock() {
            let entry = map.entry(key).or_insert(RateLimitEntry {
                attempts: Vec::new(),
                locked_until: None,
            });
            // 如果已锁定，不再追加（避免溢出）
            if entry.locked_until.is_none() {
                entry.attempts.push(now);
            }
        }
    }

    /// **计数式的闸门**：判一次、记一次，窗口内放行前 `max_attempts` 次（20261015）。
    ///
    /// 与登录那条路径（`check` + `record_failure`）的区别只在**语义**，状态机是同一个：
    /// 登录是"先判后记、只有失败才记"，而匿名可写的端点（如前端错误上报）没有"失败"
    /// 这个概念——**每一个被受理的请求就是一次计数**，所以把两拍并成一拍。
    ///
    /// 计数语义与 `check` 逐字一致：窗口内第 1..=max 次返回 `Ok`，第 max+1 次起返回
    /// `Err` 并锁定 `lockout_duration`。措辞是**通用的**（不是"登录"），因为这条路径的
    /// `subject` 不一定是账号名（调用方只该拿它做日志/回包，别拿去判断类型）。
    pub fn hit(&self, ip: &str, subject: &str) -> Result<(), String> {
        match self.check(ip, subject) {
            Ok(()) => {
                self.push(ip, subject);
                Ok(())
            }
            // 首次触发的 Err 就是"整段锁定从现在开始"，所以报完整锁定时长是**上界**
            // （后续请求再报也没错，只是偏保守）；不把 check 那句"登录尝试"的措辞
            // 漏到非登录的调用方去。
            Err(_) => Err(format!(
                "请求过于频繁，请 {} 秒后再试",
                self.lockout_duration.as_secs()
            )),
        }
    }

    /// 成功登录时重置该组合的计数
    pub fn record_success(&self, ip: &str, username: &str) {
        let key = format!("{}:{}", ip, username);
        if let Ok(mut map) = self.inner.lock() {
            map.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn allows_first_attempt() {
        let limiter = LoginRateLimiter::new(3, 60, 300);
        assert!(limiter.check("1.2.3.4", "admin").is_ok());
    }

    #[test]
    fn locks_after_max_attempts() {
        let limiter = LoginRateLimiter::new(3, 60, 300);
        let ip = "1.2.3.4";
        let user = "admin";

        // 三次失败均允许
        assert!(limiter.check(ip, user).is_ok());
        limiter.record_failure(ip, user);
        assert!(limiter.check(ip, user).is_ok());
        limiter.record_failure(ip, user);
        assert!(limiter.check(ip, user).is_ok());
        limiter.record_failure(ip, user);

        // 第四次应被锁定
        let result = limiter.check(ip, user);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("过于频繁"));
    }

    #[test]
    fn success_resets_counter() {
        let limiter = LoginRateLimiter::new(3, 60, 300);
        let ip = "1.2.3.4";
        let user = "admin";

        limiter.record_failure(ip, user);
        limiter.record_failure(ip, user);
        limiter.record_success(ip, user);

        // 成功登录后重置，应允许继续
        assert!(limiter.check(ip, user).is_ok());
    }

    #[test]
    fn different_ips_independent() {
        let limiter = LoginRateLimiter::new(2, 60, 300);
        let user = "admin";

        limiter.record_failure("1.1.1.1", user);
        limiter.record_failure("1.1.1.1", user);

        // IP 1.1.1.1 应被锁定
        assert!(limiter.check("1.1.1.1", user).is_err());
        // 不同 IP 不受影响
        assert!(limiter.check("2.2.2.2", user).is_ok());
    }

    #[test]
    fn different_users_same_ip_independent() {
        let limiter = LoginRateLimiter::new(2, 60, 300);
        let ip = "1.2.3.4";

        limiter.record_failure(ip, "admin");
        limiter.record_failure(ip, "admin");

        assert!(limiter.check(ip, "admin").is_err());
        assert!(limiter.check(ip, "other_user").is_ok());
    }

    /// `hit` 的计数语义（20261015）：窗口内放行 max 次，第 max+1 次起锁定。
    /// 与登录那组的差别是**受理的每一次都算数**（登录只有失败才算），所以这里
    /// 连续 `hit` 三次就该满额——判据同时钉住"不早锁一次、也不晚锁一次"。
    #[test]
    fn hit_allows_exactly_max_per_window() {
        let limiter = LoginRateLimiter::new(3, 60, 300);
        for i in 1..=3 {
            assert!(limiter.hit("1.2.3.4", "monitor").is_ok(), "第 {i} 次应放行");
        }
        let err = limiter.hit("1.2.3.4", "monitor").unwrap_err();
        assert!(err.contains("过于频繁"), "{err}");
        // 措辞不许把"登录"漏给非登录的调用方（回给访客的就是这句话）
        assert!(!err.contains("登录"), "非登录路径的措辞里不该出现「登录」: {err}");
    }

    /// `hit` 与登录**共用同一个状态机**（同一张 map），但键不同 ⇒ 配额互不干扰。
    /// 这条是"新增一个限流维度不会顺手把登录配额吃掉"的回归锁。
    #[test]
    fn hit_and_login_quotas_are_independent() {
        let limiter = LoginRateLimiter::new(1, 60, 300);
        assert!(limiter.hit("1.2.3.4", "monitor").is_ok());
        assert!(limiter.hit("1.2.3.4", "monitor").is_err());
        // 同一 IP 的登录路径不受影响（subject 不同 = 不同的键）
        assert!(limiter.check("1.2.3.4", "admin").is_ok());
    }

    #[test]
    fn window_expires() {
        let limiter = LoginRateLimiter::new(1, 1, 300); // 1秒窗口

        limiter.record_failure("1.2.3.4", "admin");
        assert!(limiter.check("1.2.3.4", "admin").is_err());

        // 等待窗口过期
        thread::sleep(Duration::from_secs(1));

        // 窗口过期后应允许（注意：attempts 在 check 时清理，但 locked 状态仍然存在）
        // 这里窗口 = 1 秒，但 locout = 300 秒，所以锁定仍有效
        // 我们测试的是窗口清理而非锁定到期
        assert!(limiter.check("1.2.3.4", "admin").is_err());
    }
}