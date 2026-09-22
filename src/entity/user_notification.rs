use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 站内通知 / 公告（20260922 个人中心一期）：头像红点与「公告和通知」面板的数据源。
///
/// `type` 是**留给后续扩展的接口**，今天只有两类：
///   · `announcement` = 站内公告。发布公告时**按用户逐行展开**（个位数用户的站，
///     展开最省心，也天然回答"谁读过"）——刻意不做 `user_id=0` 广播哨兵，那会与
///     `ON DELETE CASCADE` 打架（0 没有对应的 user 行）。
///   · `notice`       = 面向单个用户的系统消息（审核结果、被回复…），今天还没有生产者。
///
/// 列名是 SQL 保留字 `type`，Rust 字段名用 `kind` 并在 `column_name` 里写回真名——
/// 这样查询侧读作 `Column::Kind`，与库里的 `type` 列一一对应，不需要 `r#type` 这种
/// 让调用点别扭的写法。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user_notification")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub user_id: i32,
    #[sea_orm(column_name = "type")]
    pub kind: String,
    pub title: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub content: Option<String>,
    /// 站内路径（点通知跳过去），NULL = 纯文本通知；公告类为 NULL（没有公告详情页）
    pub link: Option<String>,
    pub is_read: bool,
    pub read_at: Option<DateTime>,
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
