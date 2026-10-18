use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 文章 ↔ 标签的关联行（20261018）。`note.tags` 那列逗号串的**结构化替代**。
///
/// 一行 = 「这篇的第 `seq` 个标签是哪个」。两个 id 列**恰好有一个非空**（CHECK
/// `num_nonnulls(...) = 1`）：这就是 `note.tags` 那个 id 串从来给不出的信息 ——
/// `tag_one.id` 与 `tag_two.id` 是两条独立自增序列，光看数字分不出层级。
///
/// ⚠️ **不要**拿 `tag_one_id` / `tag_two_id` 的值去猜层级（比如"小于 10000 就是一级"）：
/// `tag_two` 里仍有 5/6/7/8/19 < 10000。层级 = **哪个列非空**，只有这一个判据。
///
/// 读写都只走 `routes/note_tags.rs`（`replace_note_tags` 是唯一写点）。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_tag")]
pub struct Model {
    /// 复合主键的一半。`auto_increment = false` 两列都要写 —— 漏一个，sea-orm 会当成
    /// 单列主键 + 一个普通列，`insert_many` 生成的 SQL 就少了半条 WHERE。
    #[sea_orm(primary_key, auto_increment = false)]
    pub note_id: i32,
    /// 展示顺序（从 0 起）。前端 `renderNoteTags` 按存储顺序渲染 `<Tag>`，
    /// 而"存储顺序"从 20261018 起**就是这一列**（此前是 `note.tags` 串里的先后）。
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

impl Related<super::note::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Note.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
