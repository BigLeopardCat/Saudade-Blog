-- =============================================================================
-- 会话化一期迁移（20260903）：chat_history/chat_summary 挂 conversation_id
-- 存量语义：60 分钟无消息间隔 = 会话边界（gaps-and-islands）；摘要 nearest-below 归位
--
-- 执行前提（重要，见计划"部署顺序"）：
--   1. systemctl stop saudade-rust     -- 旧二进制会写 NULL conversation_id 行
--   2. mysqldump 备份 chat_history/chat_summary 完成
--   3. 逐段执行本脚本；每段间的 校验门 SELECT 输出必须符合标注的期望，不符即停
-- flag: chat_conv_20260903（migration_flags 最后插入，勿重跑）
-- =============================================================================

-- ************************************************************
-- 第 1 段：建 conversation 表
-- ************************************************************
CREATE TABLE conversation (
  id int NOT NULL AUTO_INCREMENT,
  user_id int NOT NULL,
  -- NULL/空 = 未派生标题（纯图首轮/新建空会话），前端显示"新对话"
  title varchar(64) DEFAULT NULL,
  created_at datetime DEFAULT CURRENT_TIMESTAMP,
  -- 最后用户发言时间（用户消息入库时 touch）；列表排序键
  updated_at datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_updated (user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ************************************************************
-- 第 2 段：两表加列（先 NULL，回填校验后才收紧）
-- ************************************************************
ALTER TABLE chat_history
  ADD COLUMN conversation_id int NULL AFTER user_id,
  ADD KEY idx_conv_id (conversation_id, id);
ALTER TABLE chat_summary
  ADD COLUMN conversation_id int NULL AFTER user_id;

-- ************************************************************
-- 第 3 段：gaps-and-islands 分段（>3600s 间隔 = 新会话）
-- ************************************************************
DROP TABLE IF EXISTS _conv_island;
CREATE TABLE _conv_island (
  user_id int NOT NULL,
  first_id int NOT NULL,
  last_id int NOT NULL,
  min_ts datetime NOT NULL,
  max_ts datetime NOT NULL,
  conv_id int NULL,
  PRIMARY KEY (user_id, first_id),
  KEY idx_conv (conv_id)
) ENGINE=InnoDB;

INSERT INTO _conv_island (user_id, first_id, last_id, min_ts, max_ts)
SELECT user_id, MIN(id) AS first_id, MAX(id) AS last_id, MIN(created_at) AS min_ts, MAX(created_at) AS max_ts
FROM (
  SELECT id, user_id, created_at,
         SUM(is_new) OVER (PARTITION BY user_id ORDER BY id) AS grp
  FROM (
    SELECT id, user_id, created_at,
           IF(TIMESTAMPDIFF(SECOND, LAG(created_at) OVER (PARTITION BY user_id ORDER BY id), created_at) IS NULL
              OR TIMESTAMPDIFF(SECOND, LAG(created_at) OVER (PARTITION BY user_id ORDER BY id), created_at) > 3600, 1, 0) AS is_new
    FROM chat_history
  ) s
) g
GROUP BY user_id, grp;

-- 校验门 ③ 前奏：分段预览（期望：每用户若干岛；user 7 恰好 2 岛 = 28 行 + 4 行）
SELECT user_id, COUNT(*) AS islands FROM _conv_island GROUP BY user_id ORDER BY user_id;
SELECT user_id, first_id, last_id, min_ts, max_ts FROM _conv_island
WHERE user_id = 7 ORDER BY first_id;

-- ************************************************************
-- 第 4 段：插入 conversation（ORDER BY 保证 id 自增与 first_id 同序、确定）
-- ************************************************************
INSERT INTO conversation (user_id, title, created_at, updated_at)
SELECT user_id, NULL, min_ts, max_ts
FROM _conv_island
ORDER BY user_id, first_id;

-- ************************************************************
-- 第 5 段：_conv_island 回填 conv_id（锚点 user_id + min_ts + max_ts：
-- 同用户会话的 min_ts 至少相差 3601s，锚点无歧义）
-- ************************************************************
UPDATE _conv_island i
JOIN conversation c
  ON c.user_id = i.user_id AND c.created_at = i.min_ts AND c.updated_at = i.max_ts
SET i.conv_id = c.id;

-- 校验门 ⑤：无未匹配岛屿、无重复锚定（两者都必须返回 0 行/空）
SELECT '⑤-1 未匹配岛屿(应为空)' AS gate, user_id, first_id FROM _conv_island WHERE conv_id IS NULL;
SELECT '⑤-2 一会话多岛锚定(应为空)' AS gate, conv_id, COUNT(*) AS n FROM _conv_island GROUP BY conv_id HAVING COUNT(*) > 1;

-- ************************************************************
-- 第 6 段：chat_history 回填（id 区间 + user_id 双限定 = 岛屿行集；
-- 全表 id 与 user_id 独立自增，跨用户 id 交错，必须带 user_id 过滤）
-- ************************************************************
UPDATE chat_history h
JOIN _conv_island i
  ON i.user_id = h.user_id AND h.id BETWEEN i.first_id AND i.last_id
SET h.conversation_id = i.conv_id
WHERE h.conversation_id IS NULL;

-- 校验门 ①：NULL 残留必须为 0
SELECT '① NULL 残留(必须 0)' AS gate, COUNT(*) AS n FROM chat_history WHERE conversation_id IS NULL;
-- 校验门 ②：锚点 user_id=7 → 恰好 2 会话、行数 (28, 4)（按 id 序首岛 28 行、次岛 4 行）
SELECT c.id, c.user_id, COUNT(h.id) AS rows_in_conv, c.created_at, c.updated_at
FROM conversation c
JOIN chat_history h ON h.conversation_id = c.id
WHERE c.user_id = 7
GROUP BY c.id ORDER BY c.id;

-- ************************************************************
-- 第 7 段：标题派生 = 每会话第一条 user 消息，剥尾部图片标记后 LEFT 40。
-- 正则转义说明：MySQL 字符串里 \[ 会丢反斜杠（非标准转义），必须写 \\[ 保留给
-- ICU 正则；剥离逻辑与 Rust derive_conv_title 对齐（干跑已确认 37 条全剥净）。
-- NULLIF：纯图首条剥空 → NULL（前端显示"新对话"）
-- ************************************************************
UPDATE conversation c
JOIN (
  SELECT i.conv_id, MIN(h.id) AS first_user_id
  FROM _conv_island i
  JOIN chat_history h ON h.conversation_id = i.conv_id AND h.role = 'user'
  GROUP BY i.conv_id
) fu ON fu.conv_id = c.id
JOIN chat_history h ON h.id = fu.first_user_id
SET c.title = NULLIF(LEFT(TRIM(REGEXP_REPLACE(h.content, '\\n?\\[图片(×[0-9]+)?\\]$', '')), 40), '');

-- 标题抽样（期望：中文截断 ≤40 字符；纯图首条会话标题 NULL）
SELECT id, user_id, title FROM conversation ORDER BY id LIMIT 15;

-- ************************************************************
-- 第 8 段：摘要 nearest-below 归位（归属 = 该用户 updated_at <= 摘要.updated_at
-- 的最新会话；ROW_NUMBER 取每摘要最近者，同秒并列 id 兜底）
-- 干跑结论：6 条摘要全部有归属（无孤儿），未命中分支不会触发
-- ************************************************************
WITH ranked AS (
  SELECT s.id AS summary_id, c.id AS conv_id,
         ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY c.updated_at DESC, c.id DESC) AS rn
  FROM chat_summary s
  JOIN conversation c ON c.user_id = s.user_id AND c.updated_at <= s.updated_at
)
UPDATE chat_summary s
JOIN ranked r ON r.summary_id = s.id AND r.rn = 1
SET s.conversation_id = r.conv_id
WHERE s.conversation_id IS NULL;

-- 校验门 ④：摘要全部归位（孤儿 = 0）、归属会话与摘要同用户（错挂 = 0）
SELECT '④-1 孤儿摘要(必须 0)' AS gate, COUNT(*) AS n FROM chat_summary WHERE conversation_id IS NULL;
SELECT '④-2 跨用户错挂(必须 0)' AS gate, COUNT(*) AS n
FROM chat_summary s LEFT JOIN conversation c ON c.id = s.conversation_id
WHERE c.id IS NULL OR c.user_id <> s.user_id;
-- 归位明细（核对 nearest-below 语义）
SELECT s.id AS summary_id, s.user_id, s.updated_at AS sum_ts, s.conversation_id, c.updated_at AS conv_ts
FROM chat_summary s JOIN conversation c ON c.id = s.conversation_id
ORDER BY s.user_id;

-- ************************************************************
-- 第 9 段：收紧（三处都过前面校验门才执行）
-- ************************************************************
ALTER TABLE chat_history MODIFY conversation_id int NOT NULL;
ALTER TABLE chat_summary MODIFY conversation_id int NOT NULL;
-- 摘要唯一键从 user_id 迁到 conversation_id（每会话一条摘要）
ALTER TABLE chat_summary DROP INDEX uk_user,
  ADD UNIQUE KEY uk_conversation (conversation_id);

-- 校验门 ③：会话内 id 序与时间序无逆序（期望 0）
SELECT '③ 会话内逆序对(必须 0)' AS gate, COUNT(*) AS n
FROM chat_history h1
JOIN chat_history h2
  ON h1.conversation_id = h2.conversation_id
 AND h1.id < h2.id
 AND h1.created_at > h2.created_at;

-- ************************************************************
-- 第 10 段：打迁移标记（防重跑）
-- ************************************************************
INSERT INTO migration_flags (flag_name) VALUES ('chat_conv_20260903');
SELECT '完成' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'chat_conv_20260903';

-- 收尾清理：临时表删除（校验完成后）
DROP TABLE IF EXISTS _conv_island;
