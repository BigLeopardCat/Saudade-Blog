use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// 站内信草稿（20260923）：写信写一半先存着，之后在「站内信 → 草稿箱」里接着写。
///
/// 与 `user_message` 的关系：**草稿不是信**——它没有收件人 id（对方可能还没填，或者填了
/// 但还没发）、不进任何人的收件箱、也不参与未读红点。所以这里是独立一张表，不是给
/// `user_message` 加一个 `is_draft` 列：那会让每一处收/发件箱查询都要记得加
/// `is_draft = 0`，漏一处草稿就漏进别人的收件箱。
///
/// `to_username` 存的是**用户当时敲进去的那串字**（账号或 UID），不是解析后的 user.id——
/// 草稿允许填一个还不存在的收件人（顺手记下"回头填谁"），解析只在真正发送时做。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user_message_draft")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 草稿的主人。只有本人能看/改/删（每个 handler 都按 uid 过滤）
    pub user_id: i32,
    /// 收件人（用户敲的原文：账号或 UID）。可选——草稿可以只写了一半
    pub to_username: Option<String>,
    pub title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
