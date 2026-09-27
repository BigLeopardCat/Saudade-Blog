USE memory_blog;
-- =============================================================================
-- 执行事实类型化（20260927）：execution_log 从"中文一行"到"结构化 + 渲染"
-- roadmap `toolcall-stability-roadmap.md` §D2 的第一步（**只剩这一步需要迁移**）。
--
-- 现状（为什么必须加列，而不是"把结构塞进 detail"）：
--   `detail varchar(300)` 一行同时承担三个角色——**用户可读**、**模型可读**、
--   **去重键**（读侧按 detail 相等去重 + 附 `（×N）`）。三个角色互相妥协：
--     · 300 字上限会截断（`render_exec_row` 里已经到处是 `[:120]`/`[:300]` 的将就）；
--     · 去重靠**渲染文本相等**——同一工具不同目标之所以没有被误并，恰恰是因为
--       渲染出来的字面不同（`搜索「A」` ≠ `搜索「B」`），即"判据长在措辞上"，
--       改一个动作词就可能把两件事并成一件；
--     · 回执帧里**本来就有**的结构化事实（`args` 全量、`cmd` 命令本体、
--       `digest` 实体摘要、审计的 `op/tag_name/account_name/before/after`…）
--       落库时全丢了：Rust 只存渲染行，**读侧拿不回原始事实**。
--   把结构塞进 varchar(300) 是错的（装不下）⇒ 只能加列。
--
-- 目标形状（本文件只加列；写侧双写、读侧先不改是本文件之后的第二批）：
--   · `tool`    —— 结构化动作本体。今天连**工具名**都没落库（只落了 `skill`，
--                  而一个技能可含多个工具：content_query 下面挂着十几个数据工具）
--                  ⇒ "这个会话调过哪些工具"这种最基础的账现在查不出来；
--   · `payload` —— 回执结构化事实全文（JSON 文本）。**刻意用一列装长尾**，不再为每个
--                  新 meta 键加一列：回执的键集一个月内扩过三次（20260921 二轮加审计族、
--                  三轮加 category_name/change、20260926 加 account_name），
--                  每加一次都要一次生产迁移是不可接受的；而**热字段已经落成列**
--                  （skill/tool/detail），查询与去重不必去这列里挖。
--
--   为什么是 `longtext` 而不是 MySQL 的 `json` 类型（两者都能装，这是刻意的选择）：
--     ① **本仓的 JSON 列一律是文本**（`agent_task.steps text`、`pending_action.options
--        varchar(600)`），两处都写明"形状由 agent 定义，Rust 只做透传不解析"——
--        三处 JSON 承载列用两种类型，是与"全面规范化"相反的那种漂移；
--     ② 本批 Rust **只写不解析**（读侧切结构化行是下一批），json 类型换来的
--        `->>` 查询能力当下零消费方；
--     ③ 更要紧的是**失败模式**：`save_execution_log` 用 `let _ =` 吞错（辅助事实不许
--        阻断对话，这是既有纪律），于是任何"落库时被拒"都表现为**静默**。json 类型会在
--        写入时校验并在不合法时拒绝整条插入（跨轮执行记忆静默全空）；文本列不会。
--        拿"可能静默丢数据"换一个没人用的查询能力，是亏的。
--
-- **刻意没加的列：`status`（`ToolResult.kind` 三态）** —— 它确实缺（`empty`＝空结果是
--   事实，与 `unavailable`＝服务不可用**不是**事实，在库里现在分不出来），但这一批不加：
--     ① 它的消费方在 D1（前端回报）那一批——"动作类三态可答"要的是**前端**回报的
--        送达/失败，库里的 kind 只是顺带，等那一批一起定形状更准；
--     ② 它必须由 agent 补进回执行 ⇒ **扩跨语言契约的键集**，而
--        `tests/test_admin_write.py` 正锁着这条纪律：「回执键集固定（多出来的键是
--        无声的兼容性债）」。加一列顺手、加一个键不是顺手——键要跟着消费方一起来。
--
-- 三端链路（跨语言契约，改一处必须同步另外两处）：
--   agent（Python，`agent/graph.py` 的回执构造）：**一个字都不改**。
--     `payload` = 回执行**原样**（`{skill,tool,args,result,ts}` + `cmd`/`digest`/
--     `title`/`_RCPT_META_KEYS` 各键），`tool` 也取自现有键 ⇒ 本批不新增键名、
--     不动跨语言契约面（契约测试因此不需要改，改动了才是信号）。
--   Rust（`src/routes/chat.rs::save_execution_log`）：写侧**双写**——渲染行照旧进
--     `detail`（读侧今天仍只认它，向后兼容），结构列同步落库；
--   Rust（`prepare_chat`）：读侧**本批不动**（仍取 40 条按 `detail` 去重取 8 条）。
--     切结构化行是下一批的事——**切之前这批数据已经在库里攒着**，那正是先迁移的意义。
--
-- 为什么先写后读（而不是"读侧一起改完再上"）：
--   读侧一旦改成结构化行，存量行（本文件之前的全部历史）就没有结构列可读 ⇒
--   要么回填（把渲染行反解析回结构，正是要消灭的那种"从字面猜语义"）、要么两路并存。
--   先攒数据、后切读侧，存量行的处置就变成一个**可以慢慢做的纯读侧问题**。
--
-- 已知边界（如实记）：`payload` 存的是**回执行**，而回执行在 agent 侧就已经被截过
--   （`args` 值 `[:200]`、审计 meta `[:120]`、`result` `[:200]`，见 agent/graph.py 的
--   回执构造）。本列解决的是"**结构**丢了"，不是"**内容**被截了"——把截断放开是另一件
--   事（牵动 SSE 帧体积、读侧注入预算与提示词预算），不在本批。
--
-- 幂等与安全：
--   · 纯加列、全部 NULL 允许（**不给 DEFAULT ''**：空串会假装"这行有值"，
--     而 `NULL` 才能诚实表达"这行是结构化之前写的" ⇒ 读侧的两路并存判据就是它）；
--   · 零数据回填、不锁表（两个 NULL 列 + 即时 DDL）；
--   · **迁移没跑不许推送**（这次比通常更要紧，两个方向都会静默失败）：
--     ① **写侧**：每条回执的插入都失败（`let _ =` 吞错）；
--     ② **读侧**：sea-orm 的 `Entity::find()` 按**模型全列**SELECT ⇒ 列不存在时
--        查询本身失败，而 `prepare_chat` 那边是 `.unwrap_or_default()` ⇒
--        `recent_executions` 恒空（"执行记忆"整块消失，回复里那些"据实转述"全变成
--        "系统记录里没有"——**看着像诚实，其实是读不到**）。
--     两路都静默、回复主链路照常 ⇒ 这是"功能悄悄没了"的典型形状。
-- flag: execution_log_struct_20260927（migration_flags，勿重跑）
-- =============================================================================

-- 0) 前置：看一眼版本（纯加列 + longtext 在 5.7/8.0 都成立；这里只是留个档）
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

-- ── ① 自检：两列都在、类型对得上、都是可空 ───────────────────────────────────
-- 期望：恰好 2 行，is_nullable 全为 YES，ORDINAL_POSITION 依次为 skill 之后的两格。
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'execution_log'
   AND COLUMN_NAME IN ('tool', 'payload')
 ORDER BY ORDINAL_POSITION;

-- ── ② 存量行核对：本文件不回填任何数据 ───────────────────────────────────────
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

-- ── ③ 列宽与现值对照（跑完本文件后随时可查这一条看积累了没有）───────────────
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

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- 两列一起撤（撤列会丢掉"哪次执行用了哪个工具"这条事实，撤回前先导出）：
--   ALTER TABLE `execution_log` DROP COLUMN `payload`;
--   ALTER TABLE `execution_log` DROP COLUMN `tool`;
--   DELETE FROM migration_flags WHERE flag_name = 'execution_log_struct_20260927';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码每条回执都往这两列写，
--    列没了就是回执全部插入失败（`let _ =` 吞错 ⇒ 跨轮执行记忆静默全空），
--    而回复主链路照常——属于"看着正常、功能悄悄没了"的那一类，与"没跑迁移就推送"
--    是同一枚硬币的两面。
