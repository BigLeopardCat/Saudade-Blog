use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 跨轮待办（20260923）：写操作"已经提出、还没被确认"的结构化载体。
/// 迁移 `scripts/migration/pending_action_20260923.sql`（建表 + flag），
/// 读写链路与三条状态规则见该文件头注（改一处必须同步 agent 侧
/// server.py 的 `__PENDING__` 帧与 `agent/confirm.py` 的令牌语义）。
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
    /// 结构化参数（specs 的 JSON，审计线索；>4000 字符只存前缀）
    #[sea_orm(column_type = "Text", nullable)]
    pub args: Option<String>,
    /// 写时定稿的人读目标+动作（与确认弹窗问句同源，读时零映射）
    pub target: String,
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
