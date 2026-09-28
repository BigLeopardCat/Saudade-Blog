use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 额度重置申请（20260929）：用户提交 → 管理员批准/驳回。
///
/// 与 `user.chat_quota_used` 是一对：这张表装的是「**请求**」（谁、为什么、处理了没有），
/// 那个列装的是「**事实**」（还剩多少轮）。**批准是唯一把两者连起来的动作**——
/// 它先原子认领这一行（`WHERE id=? AND status=0`），认领到了才清零、才发通知；
/// 所以重复点通过的第二下不会清第二次零、也不会发第二条通知。
///
/// 三件必须知道的事（承重，细节与代价见迁移文件头注）：
/// ① `status` 是**三值**：`0` = 待处理 / `1` = 已批准 / `2` = 已驳回。只有 `0 → 1`
///    才清零，`0 → 2` 一个字节的额度都不动——压成布尔就没有"已驳回"这个态了；
/// ② "**一人同时一份申请**"由代码保证、**不由索引保证**（`UNIQUE(user_id, status)`
///    是错的约束：它会让人永远只能有一行终态）。提交接口插入前先查有没有 pending 行；
/// ③ **无外键**：`user_id` / `handled_by` 只是过滤列与审计列（同 `dashboard_todo`、
///    `user_message_draft` 的既有形态），销号不会带走这里的行，不假装有级联。
///
/// 管理员**主动**重置不产生本表的行（没有申请这回事），但会给当事人发一条站内通知。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "quota_request")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 申请人 uid。**不是**对外标识——对外一律用账号名（申请行的 id 是模型永远猜不出的
    /// 内部键，见 agent 侧三个工具的名字通道）
    pub user_id: i32,
    /// 申请理由（可空）。前端与 agent 工具都提示填写，**后端不硬闸**——
    /// 与 `audit_board` 同形：把"必填"留给调用方，后端只做回落链
    #[sea_orm(column_type = "Text", nullable)]
    pub reason: Option<String>,
    /// `0` = 待处理 / `1` = 已批准 / `2` = 已驳回（见头注 ①，**别当布尔用**）
    pub status: i8,
    /// 管理员驳回理由（批准时为 NULL）。为空时读取端回落成"管理员没有填写理由"，
    /// **不假装它填了**——理由是给申请人看的，空话等于没答
    pub note: Option<String>,
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
    /// 处理时间（未处理为 NULL）
    pub handled_at: Option<DateTime>,
    /// 处理人 uid（无外键；管理员主动重置不产生本表行）
    pub handled_by: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
