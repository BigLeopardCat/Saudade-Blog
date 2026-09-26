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
//
// **20260926 拆出 `push_notice_checked`**：上面那条 best-effort 纪律是给"通知是副作用"
// 的场景定的，而「管理员给某个用户发通知」这条通道里**通知本身就是那件事**——
// 发不出去必须如实报失败，不能吞。所以写入抽成一个会返回 Result 的实现，
// `push_notice` 降级成它的薄包装（行为逐字节不变）：
//   · `push_notice`（best-effort）：审核通知等副作用的调用方用它；
//   · `push_notice_checked`（可回执）：`POST /api/temp-users/:id/notice` 用它——
//     **插入成功并拿到新 id，就是"这一行真的在"的唯一证据**（站内没有"读别人的通知"
//     的通道，所以这里没有"发完再读回来核对"那条腿可走，回执本身就是复核判据）。

use sea_orm::{DatabaseConnection, EntityTrait, Set};
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

/// 写入一条站内通知，**成功返回新通知 id**（数据库分配的 id 即"这一行真的在"）。
///
/// 失败返回 `Err(原因)`——给调用方决定是吞还是报。`title` 在这里**不截断**：
/// 会返回 Result 的调用方都得先自己校验长度（否则就是在"主人核对过的句子"和
/// "库里存的句子"之间悄悄换了一版）。
///
/// `link` 是站内路径（如 `/guestbook?lid=12`），NULL = 纯文本通知。
pub async fn push_notice_checked(
    db: &DatabaseConnection,
    uid: i32,
    title: &str,
    content: Option<String>,
    link: Option<String>,
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
        created_at: Set(chrono::Local::now().naive_local()),
        ..Default::default()
    };
    match user_notification::Entity::insert(am).exec(db).await {
        Ok(r) => Ok(r.last_insert_id as i32),
        Err(e) => Err(e.to_string()),
    }
}

/// 给单个用户发一条站内通知。**永不失败返回 Err**——发不出去只记日志。
///
/// 行为与 20260926 之前逐字节相同（含 title 按字符截 128、uid<=0 只 warn 不报错），
/// 它现在只是 `push_notice_checked` 的薄包装——一件事只有一个实现，
/// 免得"审核通知"与"管理员发通知"两条路在写入细节上各自演化。
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
