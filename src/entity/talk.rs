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
    pub v: i8,
    pub author: String,
    pub user_id: i32, // 发布者用户 id（匿名河灯也留存，供溯源/维护）
    pub src: String,  // 内容来源：talk=后台说说（前台"说说"页） / board=河灯留言（留言板），二者各自独立
    pub approved: i8, // 审核状态：1=通过（公开列表可见）/ 0=待审 / 2=未通过（驳回），20260905 审核生效
    pub ai_result: Option<String>, // AI 审核判定落库（20260905 issue9）：pass=AI通过 / flag=AI拦截转人工 / NULL=未审（AI关、人工全审或降级放行）
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
