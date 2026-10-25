use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "chat_history")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    /// 注入、摘要与清理均按会话隔离。
    pub conversation_id: i32,
    /// 产生记录时已核实的调用者角色；未知来源的旧记录为 None。
    pub source_role: Option<String>,
    pub role: String,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
