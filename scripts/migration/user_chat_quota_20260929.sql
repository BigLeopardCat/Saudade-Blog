-- flag: user_chat_quota_20260929（migration_flags，勿重跑）
USE saudade_blog;
ALTER TABLE `user`
    ADD COLUMN `chat_quota_used` int NOT NULL DEFAULT 0
        COMMENT '终身对话额度已用轮数（每轮 1；确认轮不计；管理员恒不增长）'
        AFTER `token_version`;

-- 2) 重置申请表：用户提交 → 管理员批准/驳回（驳回理由落 note）
CREATE TABLE IF NOT EXISTS `quota_request` (
    `id`         int NOT NULL AUTO_INCREMENT,
    `user_id`    int NOT NULL COMMENT '申请人（无外键，见头注 ④）',
    `reason`     text NULL COMMENT '申请理由（可空；前端与 agent 工具都提示填写，后端不硬闸）',
    `status`     tinyint(1) NOT NULL DEFAULT 0 COMMENT '0=待处理 / 1=已批准 / 2=已驳回（三值，见头注 ②）',
    `note`       varchar(255) NULL COMMENT '管理员驳回理由（批准时为 NULL）；写入上限见调用侧的 500 字校验',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `handled_at` datetime NULL COMMENT '处理时间（未处理为 NULL）',
    `handled_by` int NULL COMMENT '处理人 uid（无外键；管理员主动重置不产生本表行）',
    PRIMARY KEY (`id`),
    -- 后台队列的读取路径：管理员按状态筛（`?status=pending|all`）再按 id 倒序
    KEY `idx_qr_status` (`status`, `id`),
    -- 用户侧的读取路径：「我的最新一份申请」与提交前的 pending 预检
    KEY `idx_qr_user` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── ① 自检：列在、表在、类型与默认值对得上 ──────────────────────────────────
-- 期望：列恰好 1 行（is_nullable=NO、column_default=0、紧挨 token_version 之后）；
--       表恰好 1 行（InnoDB + utf8mb4_0900_ai_ci）。
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
       ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND COLUMN_NAME = 'chat_quota_used';

SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'quota_request';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'quota_request'
 ORDER BY ORDINAL_POSITION;

-- ── ② 存量行核对：不得出现非默认值（本文件不回填任何数据）──────────────────
-- 期望：`不是默认值的行数` = 0。**若不为 0，先停手查清是谁写的**——
-- 本文件之外没有任何代码能写出非 0 的值（只有 chat.rs 那条原子 UPDATE 会产生，
-- 而它在本次部署后才存在）。
SELECT '存量行（预期 0）' AS done,
       COUNT(*)                          AS 账号总数,
       SUM(chat_quota_used <> 0)         AS chat_quota_used_不是默认值的行数
  FROM `user`;

-- ── ③ 申请表现状（跑完本文件后随时可查这一条看现状）────────────────────────
-- 期望：此刻 0 行（新表；本文件不搬任何历史数据）。
SELECT '当前申请行数（预期 0）' AS done, COUNT(*) AS 申请行数 FROM `quota_request`;

SELECT '按状态分组（预期空）' AS done, status, COUNT(*) AS 行数
  FROM `quota_request` GROUP BY status;

INSERT INTO migration_flags (flag_name) VALUES ('user_chat_quota_20260929');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'user_chat_quota_20260929';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- 撤列 + 删表 + 清 flag：
--   ALTER TABLE `user` DROP COLUMN `chat_quota_used`;
--   DROP TABLE `quota_request`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_chat_quota_20260929';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码一律按这一列查 user 表，
--    列没了就是全部受保护路由 500（与"没跑迁移就推送"同一种破坏）。
-- ⚠️ 撤表会丢掉全部申请记录（含已驳回的理由）——撤回前先导一份。
-- ⚠️ 回滚**不会**把窗口期内已经耗尽的用户救回来：计数器是数据、不是代码，
--    列删掉再建回来是 0，而窗口期内的真实用量无法重建。
