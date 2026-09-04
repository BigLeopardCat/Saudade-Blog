use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "execution_log")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    /// 所属会话（20260903 会话化语义同 chat_history）：读取/清理按会话隔离
    pub conversation_id: i32,
    /// 技能名（navigate/effect/darkmode/device_display/device_query/content_query…）
    pub skill: String,
    /// 渲染后存储（写时一次定稿，读时零映射）：动作词 + 「」内容，≤300 字
    pub detail: String,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
