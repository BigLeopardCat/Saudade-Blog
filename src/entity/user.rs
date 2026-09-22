use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub username: String,
    pub nickname: String, // 用户昵称：后台账户面板可配置，默认取账号
    /// 头像 URL（20260922 个人中心：上传裁切后落库的站内路径 `/api/protect/download/avatars/…`；
    /// NULL/空 = 没设过，展示端回退到站点主人头像（web_info 的 avatar，个人中心之前的行为）
    pub avatar: Option<String>,
    pub password: String, // Note: In a real app, this should be hashed!
    pub role: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
