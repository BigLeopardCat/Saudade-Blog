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

// ⚠️ `DeriveRelation` **只**生成 `RelationDef`，`Related` 那三个 impl 要手写（本仓
// `entity/note.rs` 也是手写的）。少了它们，`inner_join(tag_one::Entity)` 编译不过 ——
// 而报错是一句"expected `note::Entity`, found `tag_one::Entity`"，看不出真正缺的是什么。
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
