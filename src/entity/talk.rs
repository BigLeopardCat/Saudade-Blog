use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "talk")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub cat: String,
    pub v: i16, // PG 侧是 smallint ⇒ 必须 i16，理由见 `entity/user.rs` 文件头
    pub author: String,
    pub user_id: i32, // 发布者用户 id（匿名河灯也留存，供溯源/维护）
    pub src: String,  // 内容来源：talk=后台说说（前台"说说"页） / board=河灯留言（留言板），二者各自独立
    pub approved: i16,
    pub ai_result: Option<String>,
    pub reject_reason: Option<String>,
    pub ai_reason: Option<String>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::user::Entity",
        from = "Column::UserId",
        to = "super::user::Column::Id"
    )]
    User,
}

impl Related<super::user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::User.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
