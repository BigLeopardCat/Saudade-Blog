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
    #[sea_orm(column_type = "Text", nullable)]
    pub description: Option<String>,
    pub cover: Option<String>,
    // Display mode and focal point refer to the original image.
    pub cover_focus_x: Option<f64>,
    pub cover_focus_y: Option<f64>,
    pub cover_zoom: Option<f64>,
    pub cover_fit: Option<String>,
    pub carousel_focus_x: Option<f64>,
    pub carousel_focus_y: Option<f64>,
    pub carousel_zoom: Option<f64>,
    pub carousel_fit: Option<String>,
    pub is_top: Option<i32>, // 0 or 1
    pub status: Option<String>,
    pub draft_of: Option<i32>,
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
