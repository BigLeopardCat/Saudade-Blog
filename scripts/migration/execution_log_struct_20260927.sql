-- flag: execution_log_struct_20260927（migration_flags，勿重跑）
USE saudade_blog;
SELECT 'MySQL 版本' AS done, VERSION() AS version;

-- 1) 结构化动作本体：工具名（`skill` 是技能，一个技能可含多个工具）
ALTER TABLE `execution_log`
    ADD COLUMN `tool` varchar(64) DEFAULT NULL
        COMMENT '工具名（结构化动作本体；skill 是技能，一个技能可含多个工具）'
        AFTER `skill`;

-- 2) 回执结构化事实全文（键名见 agent/graph.py 的回执构造；本表不解析、只存档）
ALTER TABLE `execution_log`
    ADD COLUMN `payload` longtext DEFAULT NULL
        COMMENT '回执原文 JSON 文本（skill/tool/args/result/ts + cmd/digest/title/审计 meta）；NULL=结构化之前的存量行'
        AFTER `tool`;

-- ① 自检：两列都在、类型对得上、都是可空
-- 期望：恰好 2 行，is_nullable 全为 YES，ORDINAL_POSITION 依次为 skill 之后的两格。
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'execution_log'
   AND COLUMN_NAME IN ('tool', 'payload')
 ORDER BY ORDINAL_POSITION;

-- ② 存量行核对：本文件不回填任何数据
-- 期望：`结构化之前的存量行` = 总行数（两列全 NULL），且 `不该有值的行` = 0。
-- **若 `不该有值的行` 不为 0，先停手查清是谁写的**——本文件之外此刻没有任何代码
-- 能写这两列（写侧代码在这次部署之后才上线）。
SELECT '存量行（预期全部为 NULL）' AS done,
       COUNT(*)                        AS 总行数,
       SUM(payload IS NULL)            AS 结构化之前的存量行,
       SUM(payload IS NOT NULL)        AS 不该有值的行,
       MIN(created_at)                 AS 最早,
       MAX(created_at)                 AS 最晚
  FROM `execution_log`;

-- ③ 列宽与现值对照（跑完本文件后随时可查这一条看积累了没有）
-- 读法：`最长 detail` 接近 300 就说明截断已经在发生（结构列落库后这条压力消失）。
SELECT '现状快照' AS done,
       COUNT(*)                                AS 回执总数,
       MAX(CHAR_LENGTH(detail))                AS 最长_detail,
       AVG(CHAR_LENGTH(detail))                AS 平均_detail,
       COUNT(DISTINCT skill)                   AS 技能数
  FROM `execution_log`;

INSERT INTO migration_flags (flag_name) VALUES ('execution_log_struct_20260927');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'execution_log_struct_20260927';

-- 回滚（如需）
-- 两列一起撤（撤列会丢掉"哪次执行用了哪个工具"这条事实，撤回前先导出）：
--   ALTER TABLE `execution_log` DROP COLUMN `payload`;
--   ALTER TABLE `execution_log` DROP COLUMN `tool`;
--   DELETE FROM migration_flags WHERE flag_name = 'execution_log_struct_20260927';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码每条回执都往这两列写，
--    列没了就是回执全部插入失败（`let _ =` 吞错 ⇒ 跨轮执行记忆静默全空），
--    而回复主链路照常——属于"看着正常、功能悄悄没了"的那一类，与"没跑迁移就推送"
--    是同一枚硬币的两面。
