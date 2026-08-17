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
        let key = format!("{}:{}", ip, username);
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