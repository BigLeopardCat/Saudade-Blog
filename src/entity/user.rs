use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub username: String,
    pub nickname: String,
    pub nickname_auto_renamed: i16,
    pub avatar: Option<String>,
    pub password: String, // Note: In a real app, this should be hashed!
    pub role: String,
    pub status: i16,
    pub token_version: i32,
    pub chat_quota_used: i32,
    pub muted_until: Option<chrono::NaiveDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
