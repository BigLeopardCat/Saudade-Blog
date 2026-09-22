USE memory_blog;
-- =============================================================================
-- 河灯留言：驳回理由落库（20260923，用户要求「审核完成后发系统通知，带驳回理由」）
--
-- 背景：留言审核的终态会写进 talk.approved（1 通过 / 0 待审 / 2 未通过），但**驳回
-- 理由一直没有落脚点**——AI 侧其实一直在返回 `reason`（agent `moderator.py` 的
-- `{"verdict","reason"}`），是 Rust 只取 `verdict` 把它丢掉了（talks.rs
-- `board_approved`）；人工驳回的界面也没有填理由的地方。通知要带理由，先得有列。
--
-- 列的语义：
--   reject_reason = 非空 : 本条被驳回的说明。来源两选一——AI 驳回时落它给的 reason，
--                        或管理员在后台「评论管理」驳回时手填（可留空）。
--   reject_reason = NULL : 未驳回、或驳回但没有任何理由可写。
-- **改判回通过（approved 2→1）时清空本列**，避免留下一条"已通过的留言带着驳回理由"
-- 的自相矛盾行；AI 的判定另有 ai_result 列留痕，历史不会丢。
--
-- 幂等与执行前提：
--   · `ADD COLUMN` MySQL 8 没有 IF NOT EXISTS ⇒ 重复执行会报 Duplicate column，
--     靠迁移一次性执行 + flag 记录（与 talk_ai_result_20260905 同一口径）；
--   · 不锁表：talk 表行数是留言量级（个位数到百），ALTER 秒级；
--   · **纯结构变更，零数据回填**：不替任何历史驳回行编理由（NULL = 当时没记）。
-- flag: talk_reject_reason_20260923（migration_flags，勿重跑）
-- ⚠️ 后端代码先写：新列一上线就会被 INSERT 引用 ⇒ **迁移没跑不许推送**
--    （与 user_message_draft_20260923 / user_profile_center_20260922 同一口径）。
-- =============================================================================

ALTER TABLE `talk`
    ADD COLUMN `reject_reason` varchar(200) DEFAULT NULL
        COMMENT '驳回理由: AI 判定说明或管理员手填；改判通过时清空'
        AFTER `ai_result`;

-- 校验门：必须看到 1 行 reject_reason
SELECT 'columns' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
  AND COLUMN_NAME IN ('reject_reason')
ORDER BY COLUMN_NAME;

-- 列清单（确认新列紧跟在 ai_result 之后）
SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
ORDER BY ORDINAL_POSITION;

-- 存量分布：应为 0 行（纯新增列，存量行全部 NULL）
SELECT '现有理由行数（预期 0）' AS done, COUNT(*) AS with_reason
FROM `talk` WHERE `reject_reason` IS NOT NULL;

INSERT INTO migration_flags (flag_name) VALUES ('talk_reject_reason_20260923');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'talk_reject_reason_20260923';

-- 回滚（理由列没有历史数据依赖，回滚即丢理由文本）：
--   ALTER TABLE `talk` DROP COLUMN `reject_reason`;
--   DELETE FROM migration_flags WHERE flag_name = 'talk_reject_reason_20260923';
