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
    pub ai_result: Option<String>, // AI 审核判定落库（20260905 issue9）：pass=AI通过 / flag=AI拦截转人工 / NULL=未审（AI关、人工全审或审核服务不可用转人工）
    pub reject_reason: Option<String>, // 驳回理由（20260923）：AI 驳回时落它给的 reason，或管理员在后台驳回时手填；**改判回通过时清空**（不留"已通过却带驳回理由"的矛盾行）
    pub ai_reason: Option<String>,     // AI 审核说明（20260926）：**与裁决无关**，pass/flag/reject 都把它带出来留痕；人工未填驳回理由时通知回落到它。**改判不回溯**（同 ai_result）
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    /// 发布者（`user_id` → `user.id`）。20261014 加：后台留言管理的**服务端检索**要能
    /// 按用户名/昵称过滤（那两列在 user 表上）——此前那一页是"整表拉回来在前端 includes"，
    /// 所以从没需要过这条关系。user_id → user.id 是**多对一**，join 不会让 talk 行翻倍
    /// （计数因此照旧正确，见 `routes/talks.rs::board_admin_filter`）。
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
