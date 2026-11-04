use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user_message_draft")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 草稿的主人。只有本人能看/改/删（每个 handler 都按 uid 过滤）
    pub user_id: i32,
    /// 收件人（用户敲的原文：账号或 UID）。可选——草稿可以只写了一半
    pub to_username: Option<String>,
    pub title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
