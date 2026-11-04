use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

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
