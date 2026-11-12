use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "agent_task")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 系统生成的对外任务标识，与数据库自增主键分开。
    pub task_id: String,
    /// 所属会话（读取/级联删按会话隔离）
    pub conversation_id: i32,
    /// 会话主人 uid（不参与展示/日志）
    pub user_id: i32,
    /// 目标的人读表述（取自主人原话，写时定稿；读时零重写）
    pub goal: String,
    /// 步骤 JSON 由 Agent 定义；Rust 保留原值。
    #[sea_orm(column_type = "Text", nullable)]
    pub steps: Option<String>,
    /// 登记时的总步数（进度展示用，登记后不再变）
    pub total_steps: i32,
    /// 已推进步数（0..total_steps）
    pub cursor: i32,
    /// submitted / running / input_required / succeeded / failed / cancelled
    pub state: String,
    /// `input_required` 时要问主人的那一句（下一轮**原样回放**，不由模型重编）
    pub pending_question: String,
    /// 可空幂等键；非空值由数据库唯一约束防重。
    pub idempotency_key: Option<String>,
    /// 推进次数（同一轮反复推进同一行时可见）
    pub attempts: i32,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
