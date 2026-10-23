use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Per-user notifications; announcement copies retain their source identity.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user_notification")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    pub announcement_id: Option<i32>,
    #[sea_orm(column_name = "type")]
    pub kind: String,
    pub title: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub content: Option<String>,
    /// 站内路径（点通知跳过去），NULL = 纯文本通知；公告类为 NULL（没有公告详情页）
    pub link: Option<String>,
    pub is_read: bool,
    pub read_at: Option<DateTime>,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
