use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

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
    pub value: i16, // i16 的理由见 `entity/user.rs` 文件头（PG 侧是 smallint）
    /// +08:00 本地钟面（与全库时间列一致，见 CLAUDE.md 时区约定）
    pub created_at: DateTime,
    /// 改主意（赞↔踩）时刷新。**没有任何端点读它**，留作事后对账
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
