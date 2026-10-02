USE saudade_blog;
-- =============================================================================
-- 河灯留言：AI 审核说明落库（20260926，用户要求「驳回理由别太模糊」）
--
-- 背景：管理员在后台「评论管理」看到的驳回理由一直是**未填写**，通知里只能写一句
-- 循环定义的「不符合留言板的留言规范」。根因不是"AI 没给理由"——agent 的
-- `moderator.py` 一直在返回 `{"verdict","reason"}`（全文实测分布见
-- `logs/agent/agent.log*` 的 `[review]` 行，20260920–25 共 18 条：13 flag / 4 pass /
-- 1 reject）——而是 Rust 侧 `talks.rs::board_approved` 只把 reason 用在 reject 那一支，
-- **flag（存疑）那一支的第三项返回 None**。存疑占绝大多数 ⇒ 绝大多数留言走的就是这条
-- 丢信息的路径：`ai_result` 库里存的是**裁决词**（pass/flag/reject 三个字面量），
-- 说明全文只存在于 AI 服务那一次的 HTTP 响应里，响应一关就没了。
--
-- 列的语义：
--   ai_reason = 非空 : **AI 那一次审核给出的说明**，与裁决无关（pass/flag/reject 都记）。
--                     它是"AI 怎么看这条留言"的留痕，不是"驳回理由"。
--   ai_reason = NULL : 该行在本次上线之前审核过（当时没有落脚点），或 AI 那一次没给说明。
-- **人工未填驳回理由时，驳回通知的理由回落到它**（优先级：人工手填 > reject_reason
-- （AI 判 reject 的说明）> ai_reason（AI 存疑说明））。改判回通过（approved 2→1）时
-- **只清 reject_reason**，ai_reason 作为历史留痕不动——与 ai_result 同一纪律
-- （AI 的判定不回溯）。
-- **只给后台看**：`BoardAdminDto` 才带 aiReason，公开河灯列表与「我的河灯」共用的
-- `TalkDto` 绝不动（AI 的内部注记不该发给全体访客；访客要的理由已经在 reject_reason 里）。
--
-- 幂等与执行前提：
--   · `ADD COLUMN` MySQL 8 没有 IF NOT EXISTS ⇒ 重复执行会报 Duplicate column，
--     靠迁移一次性执行 + flag 记录（与 talk_reject_reason_20260923 同一口径）；
--   · 不锁表：talk 表行数是留言量级，ALTER 秒级；
--   · **纯结构变更，零数据回填**：不替历史行编一份 AI 说明（NULL = 当时没记，是事实）。
-- flag: talk_ai_reason_20260926（migration_flags，勿重跑）
-- ⚠️ 后端代码先写：`create_board` 的 INSERT 会引用新列 ⇒ **迁移没跑不许 push**
--    （与 talk_reject_reason_20260923 / user_status_token_version_20260926 同一口径）。
--    这一条的代价比通常更响：列不存在不是"某条功能降级"，而是**每一条河灯留言都落库失败**。
-- =============================================================================

ALTER TABLE `talk`
    ADD COLUMN `ai_reason` varchar(200) DEFAULT NULL
        COMMENT 'AI 审核说明(所有裁决都留痕); 人工未填驳回理由时回落到它'
        AFTER `reject_reason`;

-- 校验门：必须看到 1 行 ai_reason
SELECT 'columns' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
  AND COLUMN_NAME IN ('ai_reason')
ORDER BY COLUMN_NAME;

-- 列清单（确认新列紧跟在 reject_reason 之后）
SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'talk'
ORDER BY ORDINAL_POSITION;

-- 存量分布：应为 0 行（纯新增列，存量行全部 NULL）。这一列**不回填**：
-- 历史上那些 flag 行的 AI 说明只存在于当时的 HTTP 响应里，今天编不回来。
SELECT '现有 AI 说明行数（预期 0）' AS done, COUNT(*) AS with_ai_reason
FROM `talk` WHERE `ai_reason` IS NOT NULL;

-- 顺带把"理由显示为未填写"的存量规模留在执行记录里（只读，不是判据）：
-- 已驳回但没有任何理由的行，就是后台「评论管理」里那些"未填写"。
SELECT '已驳回且无理由的存量行' AS done, COUNT(*) AS rejected_without_reason
FROM `talk` WHERE `approved` = 2 AND (`reject_reason` IS NULL OR `reject_reason` = '');

INSERT INTO migration_flags (flag_name) VALUES ('talk_ai_reason_20260926');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'talk_ai_reason_20260926';

-- 回滚（AI 说明没有其它依赖，回滚即丢说明文本；回滚前先想清楚"为什么"——
-- 丢的是"AI 当时怎么看这条留言"的唯一记录，而它无法重建）：
--   ALTER TABLE `talk` DROP COLUMN `ai_reason`;
--   DELETE FROM migration_flags WHERE flag_name = 'talk_ai_reason_20260926';
