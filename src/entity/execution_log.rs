use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "execution_log")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    /// 所属会话（20260903 会话化语义同 chat_history）：读取/清理按会话隔离
    pub conversation_id: i32,
    /// 技能名（navigate/effect/darkmode/device_display/device_query/content_query…）
    pub skill: String,
    /// 工具名（结构化动作本体，20260927 加列）：`skill` 是技能，而一个技能可含多个工具
    /// （content_query 下面挂着十几个数据工具）——没这一列，"这个会话调过哪些工具"
    /// 这种最基础的账查不出来。NULL = 加列之前的存量行。
    pub tool: Option<String>,
    /// 渲染后存储（写时一次定稿，读时零映射）：动作词 + 「」内容，≤300 字
    pub detail: String,
    /// 回执原文 JSON 文本（20260927 加列）：`{skill,tool,args,result,ts}` +
    /// `cmd`/`digest`/`title`/审计 meta 各键，键名是 Python 写 / Rust 读的跨语言契约
    /// （见 `agent/graph.py` 的回执构造）。**本层不解析**，与 `agent_task.steps` /
    /// `pending_action.options` 同一条纪律。NULL = 加列之前的存量行 / 序列化失败。
    pub payload: Option<String>,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
