use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "conversation")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    /// 会话标题 = 首条用户消息截断（40 字符，剥尾部图片标记）；
    /// NULL/空 = 未派生（纯图首轮或刚创建的空会话），前端显示"新对话"
    pub title: Option<String>,
    pub created_at: DateTime,
    /// 最后用户发言时间（用户消息入库时 touch；列表按它倒序，不用 assistant 收尾）
    pub updated_at: DateTime,
    pub pinned: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
