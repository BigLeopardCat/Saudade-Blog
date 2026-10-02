use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 文章评论（20261002）。**两层结构**：评论 + 回复，回复的回复仍挂在同一个顶层下。
///
/// 三个关系列的分工（写入侧派生、不信客户端，见 `routes/comments.rs::create_comment`）：
///   · `root_id`     顶层评论 id；**本行就是顶层时为 NULL**。它让"取一整棵子树"从
///                   递归 CTE / N+1 变成一次 `root_id IN (…)`；
///   · `parent_id`   直接父评论 id；「回复 @某人」由它定（`reply_to_uid` 从父行的
///                   `user_id` 取）；顶层为 NULL；
///   · `reply_to_uid` 被回复者 uid。**只存 uid、不存昵称快照**——列表本来就要 join
///                   `user`（`profile::peer_map`），永远显示对方最新昵称。
///
/// 审核四列与 `talk` 同名同义（后台两个现成组件可原样搬）：`approved` 0=待审 /
/// 1=通过（公开列表只放行它）/ 2=未通过；`ai_result` 是裁决词留痕（pass/flag/reject）；
/// `ai_reason` 与裁决无关、所有裁决都记；`reject_reason` 人工手填或回落 AI 说明、
/// **改判回通过时清空**。
///
/// `is_deleted` 是**软删**：有回复的顶层评论不能物理删（子行的 `root_id` 会变成
/// 指向不存在 id 的孤儿，整棵子树在组树时凭空消失）。公开读一律过滤 `is_deleted = 0`。
///
/// 迁移：`scripts/migration/note_comment_20261002.sql`（建表型，纯加表、不动既有表）
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_comment")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub note_id: i32, // 所属文章 id（note.id）。无外键：文章可删，评论留着更好考古
    pub user_id: i32, // 评论者 uid（恒 >0：发言强制登录）
    #[sea_orm(column_type = "Text")]
    pub content: String, // 正文（≤300 字）。**不转义存储**，XSS 防线在渲染侧的 markdown 管线
    pub root_id: Option<i32>, // 顶层评论 id；NULL = 本行就是顶层
    pub parent_id: Option<i32>, // 直接父评论 id；NULL = 顶层
    pub reply_to_uid: Option<i32>, // 被回复者 uid；NULL = 顶层
    pub approved: i8, // 0=待审（公开读不到）/ 1=通过 / 2=未通过（驳回）
    pub ai_result: Option<String>, // AI 判定留痕：pass / flag / reject；NULL = 没走 AI
    pub ai_reason: Option<String>, // AI 说明：**与裁决无关**，人工未填驳回理由时回落到它；改判不回溯
    pub reject_reason: Option<String>, // 驳回理由：人工手填或沿用 AI 说明；改判回通过时清空
    pub is_deleted: i8, // 软删：1=已删。有回复的顶层不物理删，否则子行成孤儿
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
