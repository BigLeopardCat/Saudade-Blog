use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_tag")]
pub struct Model {
    /// 复合主键的一半。`auto_increment = false` 两列都要写 —— 漏一个，sea-orm 会当成
    /// 单列主键 + 一个普通列，`insert_many` 生成的 SQL 就少了半条 WHERE。
    #[sea_orm(primary_key, auto_increment = false)]
    pub note_id: i32,
    #[sea_orm(primary_key, auto_increment = false)]
    pub seq: i16,
    pub tag_one_id: Option<i32>,
    pub tag_two_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::note::Entity",
        from = "Column::NoteId",
        to = "super::note::Column::Id",
        on_update = "Cascade",
        on_delete = "Cascade"
    )]
    Note,
    #[sea_orm(
        belongs_to = "super::tag_one::Entity",
        from = "Column::TagOneId",
        to = "super::tag_one::Column::Id",
        on_update = "Cascade",
        on_delete = "Cascade"
    )]
    TagOne,
    #[sea_orm(
        belongs_to = "super::tag_two::Entity",
        from = "Column::TagTwoId",
        to = "super::tag_two::Column::Id",
        on_update = "Cascade",
        on_delete = "Cascade"
    )]
    TagTwo,
}

// SeaORM 的 DeriveRelation 不生成 Related 实现，连接查询需显式声明。
impl Related<super::note::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Note.def()
    }
}

impl Related<super::tag_one::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::TagOne.def()
    }
}

impl Related<super::tag_two::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::TagTwo.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
