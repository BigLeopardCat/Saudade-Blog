use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Pending approval identity, display fields, and lifecycle state scoped to a conversation.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "pending_action")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 系统生成的待办 id（agent 生成；重发同一条时用它对齐）
    pub task_id: String,
    /// 所属会话（读取/关闭/清理按会话隔离）
    pub conversation_id: i32,
    /// 会话主人 uid（不参与展示/日志）
    pub user_id: i32,
    /// 技能名（board_audit/article_status/tag_create…）
    pub skill: String,
    /// 工具体（逗号分隔）——`__EXEC__` 回执命中其中任一 ⇒ 该待办已真被执行
    pub tool: String,
    /// Complete specs JSON for audit, bounded to 32768 characters by the writer.
    #[sea_orm(column_type = "Text", nullable)]
    pub args: Option<String>,
    /// 写时定稿的人读目标+动作（与确认弹窗问句同源，读时零映射）
    pub target: String,
    /// Complete frozen confirmation text, bounded to 32768 characters without truncation.
    /// Empty legacy values cannot reconstruct a confirmation card.
    #[sea_orm(column_type = "Text")]
    pub question: String,
    /// 选项 JSON（`[{"label","value","kind"}]`）——按钮的文字/取值/样式都在里面，
    /// 前端不自己造按钮（改了问句却不改按钮，就会变成一张"点确定做另一件事"的卡）
    pub options: String,
    /// 令牌的一次性编号（签在令牌里的随机串）——原子核销的键。空串 = 无法核销
    pub jti: String,
    /// 令牌到期时刻（取自令牌自身 `exp`，写时定稿不是读时重算）。NULL = 未知
    pub expires_at: Option<DateTime>,
    /// 被认领时刻；NULL = 还没被用掉（一次性核销的判据）
    pub claimed_at: Option<DateTime>,
    /// user=主人本轮提出 / system=系统事件自我提出
    pub requested_by: String,
    /// 具体来源（confirm_popup…）
    pub source_event: String,
    /// 是否需要主人点头
    pub confirmation_required: bool,
    /// awaiting / confirmed / expired
    pub confirmation_status: String,
    /// pending / done / superseded / cancelled
    pub status: String,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
