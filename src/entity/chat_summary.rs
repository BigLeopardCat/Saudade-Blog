use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "chat_summary")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    /// 每会话独立摘要，唯一键为 conversation_id。
    pub conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub summary: String,
    pub message_count: i32,
    /// 已纳入摘要输入的最后一条消息；0 表示尚未登记边界。
    pub covered_through_id: i32,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
