use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "dashboard_todo")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 待办的主人（后台仅管理员可进，仍按 uid 过滤——鉴权不靠"没人访问得到"）
    pub user_id: i32,
    /// 列表里的位次（0 起，由前端数组下标决定）
    pub sort_order: i32,
    /// 待办正文（写前已 trim；空行的行不会被写进来）
    pub text: String,
    pub done: bool,
    pub due_date: Option<Date>,
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
