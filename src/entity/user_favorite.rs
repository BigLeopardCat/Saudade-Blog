use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 收藏的文章（20260922 个人中心一期）。
/// `UNIQUE(user_id, note_id)` ⇒ 重复收藏是幂等的（后端 INSERT 撞唯一键即当成功返回）。
/// 两个外键都 ON DELETE CASCADE：销号或删文章时收藏行自动消失，不留孤儿。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user_favorite")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    pub note_id: i32,
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
