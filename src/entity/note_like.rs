use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 文章点赞（20260930）。与 `user_favorite` 同形：唯一约束让重复点赞天然幂等，
/// 两个外键都 ON DELETE CASCADE（销号/删文章时点赞行自动消失，不留孤儿）。
///
/// 与收藏的区别只有一处：收藏是"我私人的清单"（要有列表页），点赞是**公开计数**
/// （只需聚合），所以这里没有任何"列出我点过赞的文章"的端点。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_like")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub note_id: i32,
    /// 点赞者。**不存在 user_id = 0 的匿名行**——仅登录用户可点赞，
    /// 而 user 外键也决定了 0 没有对应行（同 user_notification 不用 0 当广播哨兵的取舍）。
    pub user_id: i32,
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
