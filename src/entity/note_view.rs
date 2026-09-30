use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 文章阅读量（20260930）：**一篇文章一天一行**，`cnt` 是那一天的次数。
///
/// 为什么不是"一个访客一行"：那是埋点表（要 IP/UA/去重键），而报表只要三个数
/// ——单篇总量、排行榜、30 天趋势。按天聚合一行同时满足三者，行数还小两个数量级。
/// 单访客级去重在前端（localStorage 按天记一次），这里只负责把数收下来。
///
/// `UNIQUE(note_id, view_date)` ⇒ 上报走 upsert（`cnt = cnt + 1`），并发安全。
/// 注意 `note_id` 外键是 ON DELETE CASCADE：**删文章会让总阅读量变小**，
/// 见 `scripts/migration/note_stats_20260930.sql` 头注的语义 ①。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_view")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub note_id: i32,
    /// 统计日（服务端 +08:00 本地钟面取日，与全库时区约定一致）
    pub view_date: Date,
    pub cnt: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
