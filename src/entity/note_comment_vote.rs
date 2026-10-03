use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 评论点赞/踩（20261003，用户第 4 条）。一票一行，**与 `note_like` 同形**——
/// 两种身份并排住在一张表里，去重全靠唯一键：
///   · 登录 ⇒ `user_id = Some(uid)`、`visitor_key = None`
///   · 匿名 ⇒ `user_id = None`、`visitor_key = Some(key)`
/// `uq_comment_vote_user` 管登录行、`uq_comment_vote_visitor` 管匿名行
/// （MySQL 的唯一索引不约束 NULL，两边天然互不干扰）。
///
/// `value` 只有 `+1` / `-1`，**没有 0**：撤回 = 删掉这一行，改主意 = 改 `value`。
/// 计数**不落库**，读取时按 `comment_id` 一次 GROUP BY 现算
/// （`routes/comment_votes.rs::vote_counts_for`）——写路径因此零争用。
///
/// `visitor_key` 的信任等级与 `note_like` 那一列**逐字相同**（客户端自报、可清可换、
/// 能刷）：完整说明在 `scripts/migration/note_like_anon_20261001.sql` 头注的语义 ①，
/// 改动前先读它，别在这里另立一套说法。
///
/// 迁移：`scripts/migration/note_comment_vote_20261003.sql`（建表型，纯加表）
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "note_comment_vote")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 被投票的评论 id（`note_comment.id`）。无外键：评论只有软删，不会有孤儿票
    pub comment_id: i32,
    /// 投票的账号。**匿名为 None**（不是 0 —— 同 `note_like` 的取舍）
    pub user_id: Option<i32>,
    /// 匿名访客标识（浏览器生成、随 `X-Visitor-Key` 上报）。登录投票为 None
    pub visitor_key: Option<String>,
    /// `+1` = 赞 / `-1` = 踩。**没有 0**：撤回是 DELETE 行，见迁移文件头注
    pub value: i8,
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
    /// 改主意（赞↔踩）时刷新。**没有任何端点读它**，留作事后对账
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
