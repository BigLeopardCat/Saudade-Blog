use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "agent_task")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 系统生成的对外任务 id（`at_` + 8 位十六进制）。**不用自增 id 做对外标识**：
    /// 序号可枚举，而模型会把它当全局唯一键去引用（同族教训见 id 不带来源那条）。
    pub task_id: String,
    /// 所属会话（读取/级联删按会话隔离）
    pub conversation_id: i32,
    /// 会话主人 uid（不参与展示/日志）
    pub user_id: i32,
    /// 目标的人读表述（取自主人原话，写时定稿；读时零重写）
    pub goal: String,
    /// 剩余步骤（JSON 数组，每步 `{label,tool}`，形状由 agent 定义）。**Rust 只透传不解析**——
    /// 渲染成提示词文本在 Python 侧（与 `execution_log.digest` 同一条纪律：
    /// 跨语言契约只在一侧解释语义，另一侧原样搬运）
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
    /// 幂等键（agent 计算：**会话 + 归一化目标**，步骤刻意不进键——撤下走的是同一个目标，
    /// 进键就会算出另一个键、长出第二行而旧行永远挂着）。NULL 可重复、空串只能一行，
    /// 故列可空且不给默认值 —— 服务端唯一键是最后一道保险，agent 侧才是主判据
    pub idempotency_key: Option<String>,
    /// 推进次数（同一轮反复推进同一行时可见）
    pub attempts: i32,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
