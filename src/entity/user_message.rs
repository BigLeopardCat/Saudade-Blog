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
    /// 信件标题（20260922 补，用户要求）。
    /// **可空且历史行全是 NULL**：这一列是在已有数据之后加的，早期的信没有标题。
    /// 落库前统一 trim，空串一律存 NULL（"没填"只有一种表示，前端不必区分 '' 与 None）。
    pub title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub is_read: bool,
    pub read_at: Option<DateTime>,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
