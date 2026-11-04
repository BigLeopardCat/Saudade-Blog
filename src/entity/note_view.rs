use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_view")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub note_id: i32,
    /// 统计日（服务端 +08:00 本地钟面取日，与全库时区约定一致）
    pub view_date: Date,
    pub cnt: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
