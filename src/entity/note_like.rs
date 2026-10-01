use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 文章点赞（20260930）。与 `user_favorite` 同形：唯一约束让重复点赞天然幂等，
/// 两个外键都 ON DELETE CASCADE（销号/删文章时点赞行自动消失，不留孤儿）。
///
/// 与收藏的区别只有一处：收藏是"我私人的清单"（要有列表页），点赞是**公开计数**
/// （只需聚合），所以这里没有任何"列出我点过赞的文章"的端点。
///
/// 20261001 起**匿名也能点赞**（用户第 2 条），于是有了两种身份，一行只可能是其中之一：
///   · 登录 ⇒ `user_id = Some(uid)`、`visitor_key = None`
///   · 匿名 ⇒ `user_id = None`、`visitor_key = Some(key)`
/// 去重由两条唯一键分工负责（`uq_like_note_user` 管登录行、`uq_like_note_visitor`
/// 管匿名行；MySQL 的唯一索引不约束 NULL，两边天然互不干扰）。
/// 两条身份纪律写在迁移文件 `scripts/migration/note_like_anon_20261001.sql` 的头注里
/// ——**`visitor_key` 是客户端自己生成自己上报的，它把"点赞数"拉到了与"阅读量"
/// 同一档可信度**（能刷，只是每次要换一个 key）。改这里的读写之前先读那段。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_like")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub note_id: i32,
    /// 点赞的账号。**匿名为 None**（不是 0：`user_id` 上有指向 `user` 的外键，
    /// 0 没有对应行；同 user_notification 不用 0 当广播哨兵的取舍）。
    pub user_id: Option<i32>,
    /// 匿名访客标识（浏览器生成、随 `X-Visitor-Key` 上报）。登录行为 None。
    /// 服务端只做格式校验，**不当身份凭据用**——见迁移头注语义 ①。
    pub visitor_key: Option<String>,
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
