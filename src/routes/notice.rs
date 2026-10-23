//! Single-recipient notices; checked callers own error handling and transactions.

use sea_orm::{ConnectionTrait, DatabaseConnection, EntityTrait, Set};
use crate::entity::user_notification;

/// 通知类别常量（与 entity 注释、前端渲染分支对齐；改了要三处同步）
pub const KIND_NOTICE: &str = "notice";

/// 标题列宽（varchar(128)）——`push_notice` 那一支按**字符**截掉，不报错。
/// 端点是**校验**（超长直接拒，见 `temp_user::send_user_notice`），不是截断：
/// 静默截断会让主人核对的是没被截的那一句、库里存的是另一句。
pub const TITLE_MAX: usize = 128;

/// 正文长度上限（字符）。库列是 text，这里限的是"一条通知不该这么长"，
/// 与 `clip_reject_reason` 的 200 字不是一个口径（那条是审核理由列宽）。
pub const CONTENT_MAX: usize = 1000;

/// 表单里没填标题时用的默认标题。**是系统写的字**（写在这里一处），不是模型措辞。
pub const DEFAULT_TITLE: &str = "站内通知";

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Persist one notice and return its ID; storage errors propagate to the caller.
/// Callers validate title length and may supply a database transaction.
pub async fn push_notice_checked<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    title: &str,
    content: Option<String>,
    link: Option<String>,
) -> Result<i32, String> {
    push_notice_checked_at(db, uid, title, content, link, chrono::Local::now().naive_local()).await
}

/// Checked transaction callers can supply the database wall clock explicitly.
pub async fn push_notice_checked_at<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    title: &str,
    content: Option<String>,
    link: Option<String>,
    created_at: chrono::NaiveDateTime,
) -> Result<i32, String> {
    if uid <= 0 {
        // `user_id` 有外键，0 没有对应行，插进去必失败——先在这里挡一道，
        // 报的是"收件人无效"而不是数据库的外键报错
        return Err(format!("收件人 uid={uid} 不是有效用户"));
    }
    let am = user_notification::ActiveModel {
        user_id: Set(uid),
        kind: Set(KIND_NOTICE.to_string()),
        title: Set(title.to_string()),
        content: Set(content),
        link: Set(link),
        created_at: Set(created_at),
        ..Default::default()
    };
    match user_notification::Entity::insert(am).exec(db).await {
        Ok(r) => Ok(r.last_insert_id as i32),
        Err(e) => Err(e.to_string()),
    }
}

/// Best-effort notice delivery; invalid recipients and storage failures are logged.
pub async fn push_notice(
    db: &DatabaseConnection,
    uid: i32,
    title: &str,
    content: Option<String>,
    link: Option<String>,
) {
    if uid <= 0 {
        tracing::warn!("[notice] 收件人 uid={uid} 非有效用户，跳过通知：{title}");
        return;
    }
    if let Err(e) = push_notice_checked(db, uid, &clip(title, TITLE_MAX), content, link).await {
        tracing::error!("[notice] 通知写入失败 uid={uid} title={title}: {e}");
    }
}
