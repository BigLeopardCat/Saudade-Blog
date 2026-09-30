use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    // New fields
    #[sea_orm(column_type = "Text", nullable)]
    pub description: Option<String>,
    pub cover: Option<String>,
    // 封面裁剪参数（0..1 归一化焦点 + 1..4 额外缩放），NULL = 未设置，展示端按居中 cover 渲染。
    // cover_* = 文章卡片那套；carousel_* = 置顶轮播那套（NULL = 回退跟随 cover_*）
    pub cover_focus_x: Option<f64>,
    pub cover_focus_y: Option<f64>,
    pub cover_zoom: Option<f64>,
    pub carousel_focus_x: Option<f64>,
    pub carousel_focus_y: Option<f64>,
    pub carousel_zoom: Option<f64>,
    pub is_top: Option<i32>, // 0 or 1
    pub status: Option<String>, // 'published', etc
    // 编辑修改稿链接（20260912c）：本行是「哪篇文章的修改稿」。
    // NULL = 普通文章/独立草稿；Some(原文章 id) = 编辑那篇文章时自动保存落下的独立行，
    // 原文章行在编辑期间完全不动（线上仍是旧内容），发布时用它覆盖原文章行并删掉本行。
    pub draft_of: Option<i32>,
    // 发布者 user.id（20261001）。NULL = **未记录**（本列之前发布的老文章，或发布者账号
    // 已销）——展示端回退站点级署名（见 `routes/notes.rs::attach_authors`），不是"无作者"。
    // 只在为空时写入：第一个把文章落库的人即作者，之后谁来编辑都不改署名。
    pub user_id: Option<i32>,

    pub created_at: DateTime,
    pub updated_at: DateTime,
    pub is_public: bool,
    #[sea_orm(column_type = "Text", nullable)]
    pub tags: Option<String>,
    pub category_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::category::Entity",
        from = "Column::CategoryId",
        to = "super::category::Column::Id",
        on_update = "NoAction",
        on_delete = "SetNull"
    )]
    Category,
}

impl Related<super::category::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Category.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
