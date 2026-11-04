use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

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
    pub status: i16,
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
