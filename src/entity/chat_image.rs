use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 聊天图片（20261018）：用户发的那几张图，**只做展示**。
///
/// 在此之前图片从来不落库 —— 只往 `chat_history.content` 末尾拼一个
/// `[图片]` / `[图片×N]` 标记，刷新/换设备之后前端只剩「ⓘ图片已过期」占位块。
///
/// 三件要说清楚的事：
/// ① **注入给 agent 的历史仍然只有那个文本标记**，模型看不到图。取舍与重开的触发条件
///    写在 agent 仓 `docs/adr/adr-0013-chat-image-persistence.md`；
/// ② 表里存的是**完整 dataURL**（含 `data:image/…;base64,` 前缀），原样存原样取
///    —— 所以"读回来的与写进去的逐字相等"是一条能写的判据；
/// ③ 删除靠 **DB 外键级联**（`fk_chat_image_msg`，`ON DELETE CASCADE`），不是应用层：
///    删 `chat_history` 的地方有 5 处，漏一处就是永久孤儿且没有任何东西会红。
///    ⚠️ 因此本实体**不要**在应用层再补一遍级联删（那反而会掩盖外键失效）。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "chat_image")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 所属消息（`chat_history.id`）。外键带级联，别在应用层再删一次。
    pub message_id: i32,
    /// 同一条消息内的次序（前端发的就是数组，顺序即展示顺序）。
    /// `(message_id, seq)` 唯一 ⇒ 重放/双标签页重复提交挡在库这一层。
    pub seq: i16,
    /// 完整 dataURL。`text` 而不是 `bytea`：前端要的就是这个字符串，
    /// 落库再编码回来只多一次转码。PG 的 TOAST 会把大值挪出主表。
    pub data: String,
    pub created_at: DateTime,
}

/// 空 `Relation` 是本仓实体的一贯形制（"实体零关系"）：实体关系与 DB 外键是两件事，
/// 这一条 DB 外键的存在不改变实体要不要声明 `belongs_to`。
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
