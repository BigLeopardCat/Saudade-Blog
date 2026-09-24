use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 后台首页待办（20260924）。
///
/// 这一行是「某人的待办列表里的第 sort_order 条」，**不是一个有独立身份的对象**：
/// 列表的顺序与身份都由前端拥有（拖拽换位、空行回收、行文本就地编辑），服务端每次
/// 收的是整份列表（`PUT /api/protected/todos`：事务内先删该用户全部行、再逐条插入）。
/// 所以 `id` 只作主键用，**不参与任何前端逻辑**（前端不接、不传、不存 id）。
/// 代价与取舍写在 `scripts/migration/dashboard_todo_20260924.sql` 头注里。
///
/// 无外键：`user_id` 只是过滤条件（与 `user_message_draft` 同一形态），销号不会
/// 自动带走这里的行，如实记着，不假装有级联。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "dashboard_todo")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 待办的主人（后台仅管理员可进，仍按 uid 过滤——鉴权不靠"没人访问得到"）
    pub user_id: i32,
    /// 列表里的位次（0 起，由前端数组下标决定）
    pub sort_order: i32,
    /// 待办正文（写前已 trim；空行的行不会被写进来）
    pub text: String,
    pub done: bool,
    /// 排期那天；None = 未排期（前端按它分组：逾期 / 今天 / 未来 / 未排期）
    pub due_date: Option<Date>,
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
