use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 站内信箱（20260922 个人中心一期）：用户 ↔ 用户，一条消息一行。
/// 本期不做会话线程（回复 = 新的一行），因此没有 thread/conversation 列；
/// 两个人之间的往来按 `(from_user_id, to_user_id)` 索引即可查。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user_message")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub from_user_id: i32,
    pub to_user_id: i32,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub is_read: bool,
    pub read_at: Option<DateTime>,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
