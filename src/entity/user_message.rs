use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user_message")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub from_user_id: i32,
    pub to_user_id: i32,
    pub title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub is_read: bool,
    pub read_at: Option<DateTime>,
    pub sender_deleted_at: Option<DateTime>,
    pub recipient_deleted_at: Option<DateTime>,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
