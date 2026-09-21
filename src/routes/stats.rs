//! 只读统计端点（20260921）：给 agent 的「用户数据报表」供数据。
//!
//! `GET /api/protected/stats/users` —— 挂在 `protected_routes` 下，自动吃 `middleware::auth_guard`
//! （唯一准入判据 = `authz::can_access_console`，即只有 admin 进得来；非 admin 403、
//! 无/坏 token 401）。agent 侧以**发起人的身份**代调（`.agent_admin_base` + 局部 JWT），
//! 所以"谁问的"就决定了能不能拿到——agent 自己不持有任何后台凭据。
//!
//! ## 口径（重要，读的人容易误读成"注册统计"）
//!
//! `user` 表**没有** `created_at` / `last_login` 列，所以这里给不出"注册趋势"或"上次登录"。
//! 本端点给的是**活动口径**：一个人的活动 = `max(该用户 conversation.updated_at,
//! 该用户 chat_history.created_at)`。没有任何会话与消息的用户，活动时间恒为 NULL
//! （报表侧显示"无活动"而不是拿注册时间冒充）。
//!
//! ## 隐私
//!
//! 出参**不含** `user.password`，也不含 `user.username`：`username` 在改造前是
//! **无盐单轮 SHA-256**（见 `utils::encrypt_password` 的注释），早期用户的 `nickname`
//! 又"默认取账号"⇒ 可能整串就是那个哈希。所以展示名走 [`display_name`]：
//! 像哈希的一律不显示，回落 `用户#<id>`。这条不是洁癖——报表文本会进 LLM 的 prompt、
//! 落进对话 trace、并被 narrator 复述给用户看，任何一环沾上口令派生物都不好收场。

use axum::{extract::State, Json};
use sea_orm::{sea_query::Expr, EntityTrait, PaginatorTrait, QueryOrder, QuerySelect};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

use crate::entity::{chat_history, conversation, execution_log, user};
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// 每行用户明细的展示名上限（防超长昵称把报表撑爆）。
const MAX_NAME_CHARS: usize = 24;

/// `users[]` 一次最多列多少人（按消息数倒序）。总数/活跃数**不受**此上限影响。
const MAX_LISTED_USERS: usize = 50;

/// 明细列表的下界：一行都没有的用户（既无会话也无消息）不进 `users[]`——
/// 它们在 `totalUsers` 里计着，但列出来只是噪声（体验账号/一次性号常见）。
/// **注意这与"活动口径"是两个不同的口径**，别把 `users.len()` 当用户总数读。
#[derive(Serialize, Default)]
pub struct UserStatsDto {
    /// 生成时刻（本地钟面，便于判断"这份报表有多新"）
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    /// 角色分布（按人数倒序，同数按角色名升序——排序确定才好对比两次报表）
    #[serde(rename = "roleCounts")]
    pub role_counts: Vec<RoleCount>,
    #[serde(rename = "totalUsers")]
    pub total_users: i64,
    #[serde(rename = "totalConversations")]
    pub total_conversations: i64,
    #[serde(rename = "totalMessages")]
    pub total_messages: i64,
    #[serde(rename = "totalExecutions")]
    pub total_executions: i64,
    /// 活跃 = 最近一条会话/消息的时间落在窗口内
    #[serde(rename = "activeUsers7d")]
    pub active_users7d: i64,
    #[serde(rename = "activeUsers30d")]
    pub active_users30d: i64,
    /// 有活动、进入 `users[]` 的人数（≤ MAX_LISTED_USERS）
    #[serde(rename = "listedUsers")]
    pub listed_users: usize,
    pub users: Vec<UserRowDto>,
}

#[derive(Serialize, Default)]
pub struct RoleCount {
    pub role: String,
    pub count: i64,
}

/// 一个用户一行的活动明细。
#[derive(Serialize, Default, Clone)]
pub struct UserRowDto {
    pub id: i32,
    /// 展示名（`display_name` 产出；**不是** username，见模块头注的隐私一节）
    pub name: String,
    pub role: String,
    pub conversations: i64,
    pub messages: i64,
    /// `YYYY-MM-DD HH:MM` 本地钟面；NULL = 该用户既无会话也无消息
    #[serde(rename = "lastActiveAt")]
    pub last_active_at: Option<String>,
}

/// 内存里的活动明细（还没定稿成 DTO，供纯函数排序/计数用）。
#[derive(Clone)]
pub struct Activity {
    pub id: i32,
    pub name: String,
    pub role: String,
    pub conversations: i64,
    pub messages: i64,
    pub last_active: Option<chrono::NaiveDateTime>,
}

/// 64 位十六进制 = 改造前的 SHA-256 口令哈希形态（`encrypt_password` 无盐单轮）。
fn looks_like_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 展示名：`nickname` 可用则用，否则 `用户#<id>`。
///
/// 不可用的两种情形：空串（后台没配过）；**像哈希**（早期 nickname 默认取账号，
/// 而账号本身存的就是 SHA-256）。宁可显示 `用户#7` 也不显示一串口令派生物。
pub fn display_name(id: i32, nickname: &str) -> String {
    let n = nickname.trim();
    if n.is_empty() || looks_like_hash(n) {
        return format!("用户#{}", id);
    }
    n.chars().take(MAX_NAME_CHARS).collect()
}

/// 时间戳 → `YYYY-MM-DD HH:MM`。DB 里存的就是本地钟面（见 CLAUDE.md 时区约定），
/// **不要再套时区换算**。
pub fn format_ts(t: chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M").to_string()
}

/// 组装活动明细：以 `users` 为准（每个存在的用户一行），会话/消息聚合表按 user_id 补齐。
/// 排序 = 消息数倒序 → 会话数倒序 → id 升序（全并列时排序确定，报表可比对）。
pub fn build_rows(
    users: Vec<(i32, String, String)>, // (id, nickname, role)
    conv: &HashMap<i32, (i64, Option<chrono::NaiveDateTime>)>,
    msg: &HashMap<i32, (i64, Option<chrono::NaiveDateTime>)>,
) -> Vec<Activity> {
    let mut rows: Vec<Activity> = users
        .into_iter()
        .map(|(id, nickname, role)| {
            let (conversations, conv_last) = conv.get(&id).copied().unwrap_or((0, None));
            let (messages, msg_last) = msg.get(&id).copied().unwrap_or((0, None));
            // 活动 = max(会话最后更新, 最后一条消息)；两者皆无 ⇒ None（不拿注册时间冒充）
            let last_active = match (conv_last, msg_last) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            Activity {
                id,
                name: display_name(id, &nickname),
                role,
                conversations,
                messages,
                last_active,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.messages
            .cmp(&a.messages)
            .then(b.conversations.cmp(&a.conversations))
            .then(a.id.cmp(&b.id))
    });
    rows
}

/// 窗口内活跃人数（`last_active >= cutoff`）。无活动的用户不计。
pub fn active_since(rows: &[Activity], cutoff: chrono::NaiveDateTime) -> i64 {
    rows.iter()
        .filter(|r| r.last_active.map(|t| t >= cutoff).unwrap_or(false))
        .count() as i64
}

/// 只列出"有活动"的人（见 `MAX_LISTED_USERS` 上方的注释）。
pub fn listed(rows: &[Activity]) -> Vec<UserRowDto> {
    rows.iter()
        .filter(|r| r.messages > 0 || r.conversations > 0)
        .take(MAX_LISTED_USERS)
        .map(|r| UserRowDto {
            id: r.id,
            name: r.name.clone(),
            role: r.role.clone(),
            conversations: r.conversations,
            messages: r.messages,
            last_active_at: r.last_active.map(format_ts),
        })
        .collect()
}

/// GET /api/protected/stats/users —— 见模块头注。
pub async fn user_stats(State(state): State<Arc<AppState>>) -> Json<ApiResponse<UserStatsDto>> {
    let db = &state.db;

    // 1. 用户表（只取三列：find() 是 SELECT *，会把 password 哈希一起捞出来）
    let users: Vec<(i32, String, String)> = match user::Entity::find()
        .select_only()
        .column(user::Column::Id)
        .column(user::Column::Nickname)
        .column(user::Column::Role)
        .order_by_asc(user::Column::Id)
        .into_tuple::<(i32, String, String)>()
        .all(db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[stats] 用户表查询失败: {e}");
            return Json(ApiResponse::error("统计查询失败，请稍后再试"));
        }
    };

    // 2. 按 user_id 聚合（会话数+最后更新；消息数+最后一条）
    let conv = match grouped_counts(
        conversation::Entity::find()
            .select_only()
            .column(conversation::Column::UserId)
            .column_as(Expr::col(conversation::Column::Id).count(), "cnt")
            .column_as(Expr::col(conversation::Column::UpdatedAt).max(), "last")
            .group_by(conversation::Column::UserId)
            .into_tuple::<(i32, i64, Option<chrono::NaiveDateTime>)>()
            .all(db)
            .await,
        "conversation",
    ) {
        Ok(v) => v,
        Err(e) => return Json(ApiResponse::error(&e)),
    };
    let msg = match grouped_counts(
        chat_history::Entity::find()
            .select_only()
            .column(chat_history::Column::UserId)
            .column_as(Expr::col(chat_history::Column::Id).count(), "cnt")
            .column_as(Expr::col(chat_history::Column::CreatedAt).max(), "last")
            .group_by(chat_history::Column::UserId)
            .into_tuple::<(i32, i64, Option<chrono::NaiveDateTime>)>()
            .all(db)
            .await,
        "chat_history",
    ) {
        Ok(v) => v,
        Err(e) => return Json(ApiResponse::error(&e)),
    };

    // 3. 执行回执总量（失败不影响主体报表，记 0 + 日志）
    let total_executions = match execution_log::Entity::find().count(db).await {
        Ok(n) => n as i64,
        Err(e) => {
            tracing::warn!("[stats] execution_log 计数失败: {e}");
            0
        }
    };

    let rows = build_rows(users, &conv, &msg);
    let now = chrono::Local::now().naive_local();

    let mut role_counts: Vec<RoleCount> = {
        // 角色分布从内存里的用户表算（不另发一条 GROUP BY：用户表本来就要全取）
        let mut m: HashMap<String, i64> = HashMap::new();
        for r in &rows {
            *m.entry(r.role.clone()).or_insert(0) += 1;
        }
        m.into_iter()
            .map(|(role, count)| RoleCount { role, count })
            .collect()
    };
    role_counts.sort_by(|a, b| b.count.cmp(&a.count).then(a.role.cmp(&b.role)));

    let users_out = listed(&rows);
    let dto = UserStatsDto {
        generated_at: format_ts(now),
        role_counts,
        total_users: rows.len() as i64,
        total_conversations: conv.values().map(|(c, _)| c).sum(),
        total_messages: msg.values().map(|(c, _)| c).sum(),
        total_executions,
        active_users7d: active_since(&rows, now - chrono::Duration::days(7)),
        active_users30d: active_since(&rows, now - chrono::Duration::days(30)),
        listed_users: users_out.len(),
        users: users_out,
    };
    Json(ApiResponse::success(dto))
}

/// 聚合查询的取表助手：统一把 `DbErr` 记日志并翻成给用户看的一句话。
fn grouped_counts(
    r: Result<Vec<(i32, i64, Option<chrono::NaiveDateTime>)>, sea_orm::DbErr>,
    what: &str,
) -> Result<HashMap<i32, (i64, Option<chrono::NaiveDateTime>)>, String> {
    match r {
        Ok(v) => Ok(v.into_iter().map(|(uid, cnt, last)| (uid, (cnt, last))).collect()),
        Err(e) => {
            tracing::error!("[stats] {what} 聚合失败: {e}");
            Err("统计查询失败，请稍后再试".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn ts(y: i32, m: u32, d: u32, h: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, 0, 0)
            .unwrap()
    }

    fn users3() -> Vec<(i32, String, String)> {
        vec![
            (1, "泠月".to_string(), "admin".to_string()),
            (2, "".to_string(), "user".to_string()),
            (3, "a".repeat(64), "user".to_string()), // 早期 nickname 默认取账号 ⇒ 哈希串
        ]
    }

    #[test]
    fn 展示名不显示哈希串() {
        assert_eq!(display_name(1, "泠月"), "泠月");
        assert_eq!(display_name(2, ""), "用户#2");
        assert_eq!(display_name(2, "   "), "用户#2");
        assert_eq!(display_name(3, &"a".repeat(64)), "用户#3");
        // 不是 64 位十六进制的一律照常显示（含大小写混排的短串）
        assert_eq!(display_name(4, "abc123"), "abc123");
        // 63 位十六进制不是哈希形态 ⇒ 照常显示（但要过超长截断）
        assert_eq!(display_name(5, &"a".repeat(63)), "a".repeat(MAX_NAME_CHARS));
        // 超长截断到 MAX_NAME_CHARS 字符（按字符不按字节）
        assert_eq!(display_name(6, &"喵".repeat(50)).chars().count(), MAX_NAME_CHARS);
        // 首尾空白不参与展示
        assert_eq!(display_name(7, "  泠月  "), "泠月");
    }

    #[test]
    fn 活动取会话与消息的较晚者() {
        let mut conv = HashMap::new();
        conv.insert(1, (2i64, Some(ts(2026, 9, 20, 10))));
        let mut msg = HashMap::new();
        msg.insert(1, (5i64, Some(ts(2026, 9, 21, 9))));
        // 用户 2 只有会话无消息，用户 3 什么都没有
        conv.insert(2, (1, Some(ts(2026, 1, 1, 0))));
        let rows = build_rows(users3(), &conv, &msg);

        let u1 = rows.iter().find(|r| r.id == 1).unwrap();
        assert_eq!(u1.messages, 5);
        assert_eq!(u1.conversations, 2);
        assert_eq!(u1.last_active, Some(ts(2026, 9, 21, 9))); // 消息更晚

        let u2 = rows.iter().find(|r| r.id == 2).unwrap();
        assert_eq!(u2.messages, 0);
        assert_eq!(u2.last_active, Some(ts(2026, 1, 1, 0))); // 无消息但会话算活动

        let u3 = rows.iter().find(|r| r.id == 3).unwrap();
        assert_eq!(u3.last_active, None); // 两无 ⇒ None，不编造时间
    }

    #[test]
    fn 排序与截断确定() {
        let mut msg = HashMap::new();
        msg.insert(1, (1i64, Some(ts(2026, 9, 21, 9))));
        msg.insert(2, (1, Some(ts(2026, 9, 21, 9))));
        // 消息数并列 → 会话数倒序 → id 升序
        let mut conv = HashMap::new();
        conv.insert(2, (3i64, None));
        conv.insert(1, (1, None));
        let rows = build_rows(users3(), &conv, &msg);
        let order: Vec<i32> = rows.iter().map(|r| r.id).collect();
        assert_eq!(order, vec![2, 1, 3]); // 2 会话多在前；3 无活动在末
    }

    #[test]
    fn 只列有活动的人且有上限() {
        let rows = build_rows(users3(), &HashMap::new(), &HashMap::new());
        assert!(listed(&rows).is_empty(), "零活动的用户不进明细（但仍在 totalUsers 里）");

        let many: Vec<(i32, String, String)> =
            (0..80).map(|i| (i, format!("u{i}"), "user".to_string())).collect();
        let mut msg = HashMap::new();
        for i in 0..80 {
            msg.insert(i, (i as i64 + 1, Some(ts(2026, 9, 21, 9))));
        }
        let rows = build_rows(many, &HashMap::new(), &msg);
        assert_eq!(rows.len(), 80);
        assert_eq!(listed(&rows).len(), MAX_LISTED_USERS);
        assert_eq!(listed(&rows)[0].id, 79); // 消息最多者居首
    }

    #[test]
    fn 活跃计数按窗口且不受明细上限影响() {
        let many: Vec<(i32, String, String)> =
            (0..80).map(|i| (i, format!("u{i}"), "user".to_string())).collect();
        let mut msg = HashMap::new();
        // 前 40 人近 3 天有消息，后 40 人半年前有消息
        for i in 0..40 {
            msg.insert(i, (1i64, Some(ts(2026, 9, 19, 9))));
        }
        for i in 40..80 {
            msg.insert(i, (1i64, Some(ts(2026, 3, 1, 9))));
        }
        let rows = build_rows(many, &HashMap::new(), &msg);
        let now = ts(2026, 9, 21, 12);
        assert_eq!(active_since(&rows, now - chrono::Duration::days(7)), 40);
        assert_eq!(active_since(&rows, now - chrono::Duration::days(30)), 40);
        assert_eq!(active_since(&rows, now - chrono::Duration::days(365)), 80);
        // 明细只列 50 行，但活跃数是 40（两个口径独立）
        assert_eq!(listed(&rows).len(), MAX_LISTED_USERS);
    }

    #[test]
    fn 时间戳按本地钟面直出() {
        assert_eq!(format_ts(ts(2026, 9, 21, 14)), "2026-09-21 14:00");
    }
}
