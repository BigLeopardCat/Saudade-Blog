use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Deserialize, Serialize)]
#[sea_orm(table_name = "user")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub username: String,
    pub nickname: String, // 用户昵称：后台账户面板可配置，默认取账号
    /// 昵称是否被**迁移自动改过**（20261002 昵称唯一）：`1` = 原本的昵称与别人重复，
    /// 迁移给它加了 `_<id>` 后缀（最早注册者保留原名）。个人中心据此显示一条横幅提示
    /// 本人改掉；本人改一次昵称就清 0（见 `routes/profile.rs::update_profile`）。
    /// **不是"这个昵称需要唯一"的开关**——唯一性由库里的函数索引
    /// `uk_user_nickname ((NULLIF(TRIM(nickname),'')))` 保证，与这一列无关。
    /// 迁移：`scripts/migration/nickname_unique_20261002.sql`（列序 `AFTER nickname`）
    pub nickname_auto_renamed: i8,
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
    /// 终身对话额度已用轮数（20260929）：每轮 +1、**检索轮不豁免**、**确认轮不计**
    /// （主人点一次确认卡不是新的一轮对话）、管理员恒不增长。唯一归零途径 =
    /// 管理员批准重置申请或主动重置（`UPDATE user SET chat_quota_used = 0`）。
    /// 上限不在这里——走环境变量 `CHAT_QUOTA_LIMIT`（默认 500），
    /// 判据与算术全在 `crate::quota`，**别在本文件或任何 handler 里内联第二份**。
    /// 迁移：`scripts/migration/user_chat_quota_20260929.sql`（列序 `AFTER token_version`）
    pub chat_quota_used: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
