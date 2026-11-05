use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_comment")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub note_id: i32, // 所属文章，永久删除文章时级联清理
    pub user_id: i32, // 评论者 uid（恒 >0：发言强制登录）
    #[sea_orm(column_type = "Text")]
    pub content: String, // 正文（≤300 字）。**不转义存储**，XSS 防线在渲染侧的 markdown 管线
    pub root_id: Option<i32>, // 顶层评论 id；NULL = 本行就是顶层
    pub parent_id: Option<i32>, // 直接父评论 id；NULL = 顶层
    pub reply_to_uid: Option<i32>, // 被回复者 uid；NULL = 顶层
    pub approved: i16, // 0=待审（公开读不到）/ 1=通过 / 2=未通过（驳回）。i16 的理由见 `entity/user.rs` 文件头
    pub ai_result: Option<String>, // AI 判定留痕：pass / flag / reject；NULL = 没走 AI
    pub ai_reason: Option<String>, // AI 说明：**与裁决无关**，人工未填驳回理由时回落到它；改判不回溯
    pub reject_reason: Option<String>, // 驳回理由：人工手填或沿用 AI 说明；改判回通过时清空
    pub is_deleted: i16, // 软删：1=已删。有回复的顶层不物理删，否则子行成孤儿。i16 的理由见 `entity/user.rs` 文件头
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
