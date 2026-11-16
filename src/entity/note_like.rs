use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

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
    /// 服务端只校验格式，不作为身份凭据。
    pub visitor_key: Option<String>,
    /// Asia/Shanghai 本地时间，不含时区偏移。
    pub created_at: DateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
