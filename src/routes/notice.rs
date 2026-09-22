// ── 单用户站内通知（20260923）────────────────────────────────────────────────
//
// `user_notification.kind='notice'` 这条通道从建表起就留着（entity 注释：「面向单个
// 用户的系统消息——审核结果、被回复…，今天还没有生产者」），本模块就是那个生产者。
// 第一个用户是留言审核结果（talks.rs 的两处终态），后续的回复提醒等照这个口子发。
//
// 三条纪律：
//   · **best-effort**：通知发失败绝不冒泡给调用方——留言该落库照落库，不能因为
//     "通知没发出去"让访客的河灯放不成。失败只记 error 日志（带 uid，便于手工补发）。
//   · **uid <= 0 直接不发**：`user_id` 有外键 REFERENCES user(id)，0 没有对应行，
//     插入必失败；匿名留言（若将来出现）也就没有收件人。
//   · **截断按字符**：title 列宽 varchar(128)、content 是 text——中文按字节切会切在
//     半个汉字上、落库直接报错。理由文案（≤200 字）短，但标题里带留言标题时可能长。
//
// 与公告 `announcement` 类的分工：那类在发布时**按用户逐行展开**（谁读过天然可查），
// 由 announcements.rs 的 fan_out 负责；本模块只管"发给某一个人"。

use sea_orm::{DatabaseConnection, EntityTrait, Set};
use crate::entity::user_notification;

/// 通知类别常量（与 entity 注释、前端渲染分支对齐；改了要三处同步）
pub const KIND_NOTICE: &str = "notice";

/// 标题列宽（varchar(128)）——超出的部分按**字符**截掉，不报错
const TITLE_MAX: usize = 128;

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// 给单个用户发一条站内通知。**永不失败返回 Err**——发不出去只记日志。
///
/// `link` 是站内路径（如 `/guestbook?lid=12`），NULL = 纯文本通知。
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
    let am = user_notification::ActiveModel {
        user_id: Set(uid),
        kind: Set(KIND_NOTICE.to_string()),
        title: Set(clip(title, TITLE_MAX)),
        content: Set(content),
        link: Set(link),
        created_at: Set(chrono::Local::now().naive_local()),
        ..Default::default()
    };
    if let Err(e) = user_notification::Entity::insert(am).exec(db).await {
        tracing::error!("[notice] 通知写入失败 uid={uid} title={title}: {e}");
    }
}
