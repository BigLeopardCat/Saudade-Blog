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
    /// 账号状态（20260926 冻结账号）：`0` = 正常（唯一放行值）/ `1` = 冻结。
    /// 取值域与判据在 `crate::authz`（`STATUS_ACTIVE` / `is_frozen`）——**别在本文件
    /// 或任何 handler 里内联数字**，未登记的值一律按冻结处理（失败取向不默认放行）。
    /// 迁移：`scripts/migration/user_status_token_version_20260926.sql`
    pub status: i8,
    /// 令牌代次（20260926 令牌收回）：签发时写进 JWT 的 `ver` 声明，之后每个请求
    /// 拿这里的值与之比对——**库里的值一变大，此前签发的全部令牌当场作废**。
    /// 改密码 / 管理员重置 / 冻结账号都会 +1（见各自的 handler）。
    /// **只增不减**：解冻不把它减回去，所以解冻不会复活冻结前的登录态。
    pub token_version: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
