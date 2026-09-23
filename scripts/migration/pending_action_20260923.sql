USE memory_blog;
-- =============================================================================
-- 跨轮待办（20260923）：pending_action 表
--
-- 背景（13:19 那条 trace 复盘出来的结构性缺口）：写操作"已经提出、还没被确认"
-- 这件事，此前只存在于**自然语言的上一轮发言**里——
--   · 执行事实有系统载体（execution_log，checker 验收回执）；
--   · **未执行的提议没有任何载体**，下一轮只能回模型历史里挑一句自然语言当目标，
--     于是 13:19 现场"模型提议驳回 A（A 早已通过）＋系统账上真正的待审是 B"，
--     两次采样都能挑到错的那条。确认令牌（agent/confirm.py）是**无状态**的：
--     状态在令牌自身里，服务端零状态（uvicorn 2 workers），它救不了这个缺口。
-- 本表 = 提议的**结构化载体**：谁（requested_by/user_id）、什么技能与工具、
-- 什么参数（args）、目标的人读表述（target）、为什么会有它（source_event）、
-- 确认到哪一步了（confirmation_required/status）。
--
-- 读写链路（三端契约，改一处必须同步另外两处）：
--   agent 在**弹确认框那一轮**随 `__CONFIRM__` 一起发 `__PENDING__:{json}` 帧
--     （server.py；字段与列一一对应）——该轮零执行、零 LLM；
--   Rust 在 SSE 帧解析的 JSON 文本分支**之前**拦下（与 `__EXEC__` 同族）：
--     **收到即落库、绝不转发前端**（前端无此帧协议，透传会被当正文渲染）；
--   Rust 在 prepare_chat 读**本会话最新一条仍 pending 的待办** → body 的
--     `pending_action` 字段 → agent 注入 system 上下文给 planner。
--
-- 三条状态规则（刻意都在 Rust 侧，不靠模型自觉）：
--   1. **新的顶掉旧的**：同一会话再落一条待办时，先把该会话所有 pending 行删掉
--      ——"最新那次提议"才是主人心里那件事；
--   2. **回执即关闭**：`__EXEC__` 里出现与本行 tool 集合（逗号分隔）相交的工具名
--      ⇒ 该待办已真被执行 ⇒ status='done' + confirmation_status='confirmed'
--      （"系统事实优先于结构化状态"落到代码里，不靠叙述）；
--   3. **读侧 60 分钟时效**：超时的 pending 行不再注入 planner（令牌自身 10 分钟
--      即失效，超时行只会误导）。
--
-- 已知缺口（如实记，不装作没有）：
--   · 主人点「取消」时前端只关窗、不回调后端 ⇒ 那行会一直是 pending，直到被
--     新待办顶掉、随会话删除、或超出读侧时效；status='cancelled'/'expired'
--     目前**没有任何写入方**（留着列是给下一步的收口用）。
--   · 只覆盖**系统自己提出的**待办（弹窗路径）。模型在自然语言里自称"我提议把
--     X 驳回"而转不出结构化动作的那种**不落库**——那属 gate 的辖区（洞⑥：
--     没有确认帧就不许说"点确定我就去办"），本表刻意不替它猜。
--   · 非流式 `/chat` 路径不弹窗（无帧通道）⇒ 也不落待办；前端走的一直是
--     `/chat/stream`。
--
-- 幂等与执行前提：
--   · CREATE TABLE IF NOT EXISTS：重复执行安全；新表此刻必然 0 行，不锁表；
--   · 纯结构变更，零数据回填；
--   · **迁移没跑不许推送**（Rust 一上线就会读它；读失败按"无待办"降级处理，
--     但确认轮会少一条结构化线索）。
-- flag: pending_action_20260923（migration_flags，勿重跑）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `pending_action` (
    `id`                    int NOT NULL AUTO_INCREMENT,
    `task_id`               varchar(64) NOT NULL DEFAULT '' COMMENT '系统生成的待办 id',
    `conversation_id`       int NOT NULL COMMENT '所属会话（读取/关闭/清理按会话隔离）',
    `user_id`               int NOT NULL COMMENT '会话主人 uid（不参与展示）',
    `skill`                 varchar(32) NOT NULL DEFAULT '' COMMENT '技能名',
    `tool`                  varchar(255) NOT NULL DEFAULT '' COMMENT '工具体（逗号分隔；回执关闭的判据）',
    `args`                  text NULL COMMENT '结构化参数（specs 的 JSON，审计线索；超 4000 字符只存前缀）',
    `target`                varchar(300) NOT NULL DEFAULT '' COMMENT '写时定稿的人读目标+动作（与确认弹窗同源）',
    `requested_by`          varchar(32) NOT NULL DEFAULT 'user' COMMENT 'user=主人本轮提出 / system=系统事件自我提出',
    `source_event`          varchar(64) NOT NULL DEFAULT '' COMMENT '具体来源（confirm_popup…）',
    `confirmation_required` tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否需要主人点头',
    `confirmation_status`   varchar(24) NOT NULL DEFAULT 'awaiting' COMMENT 'awaiting/confirmed/expired',
    `status`                varchar(24) NOT NULL DEFAULT 'pending' COMMENT 'pending/done/superseded/cancelled',
    `created_at`            datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `updated_at`            datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    -- 唯一的高频查询：某会话仍 pending 的最新一条
    KEY `idx_pa_conv_status` (`conversation_id`, `status`, `id`),
    KEY `idx_pa_task` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 应用后自检：表在不在、列齐不齐、此刻有几行（预期 0）
SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'pending_action';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'pending_action'
ORDER BY ORDINAL_POSITION;

SELECT '当前行数（预期 0）' AS done, COUNT(*) AS 待办行数 FROM `pending_action`;

INSERT INTO migration_flags (flag_name) VALUES ('pending_action_20260923');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'pending_action_20260923';

-- 回滚（本次没有历史数据依赖，回滚即删表；若主人手上有未办完的待办请先导出）：
--   DROP TABLE `pending_action`;
--   DELETE FROM migration_flags WHERE flag_name = 'pending_action_20260923';
