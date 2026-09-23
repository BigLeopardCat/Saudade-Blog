USE memory_blog;
-- =============================================================================
-- 确认卡片跨刷新存活 + 令牌一次性核销（20260924）：pending_action 加 5 列
--
-- 背景（这张卡片现在只活在**当轮 SSE 帧**里）：
--   `__CONFIRM__` 帧带着问句、选项、令牌飞过一次就没了——用户刷新页面、切走再回来、
--   或者那条流中途断了，卡片就**结构上不可能**再出现，而令牌其实还在有效期内
--   （TTL 600 秒）。用户看到的是"agent 说要确认，可我没地方点"；系统里既没有执行、
--   也没有任何可点的东西。
--
-- 为什么加在 pending_action 上，而不是新建一张 confirm_request 表：
--   同一件事现在有两个载体——`pending_action`（结构化待办，给 planner 认人）与
--   `__CONFIRM__` 帧（给人看的卡片，一次性）。它们是**同一次提议**的两个面，分表存
--   就会出现"待办还在、卡片没了"或反之的**不一致状态**，而读取端要同时面对两张表
--   各自的时效/状态规则。合在一行：一次 write、一个真源、一套状态。
--
-- 5 列各自解决什么（改代码时逐条对齐）：
--   · `question`   卡片问句（与 `target` 同源渲染，写时定稿）——刷新后重建卡片用；
--   · `options`    选项 JSON（`[{"label":"确定","value":"yes","kind":"primary"},…]`）——
--                  按钮的文字/取值/样式都在里面，前端不自己造；
--   · `jti`        令牌 id（**签在令牌里**的随机串，20260924 起 token payload 带它）——
--                  它是"认领"这条链的键：验签证明这枚令牌真是系统签的、绑的是这位主人，
--                  再用 jti 去表上做**一次原子核销**（`claimed_at IS NULL` ⇒ 置位）。
--                  没有它就只能拿客户端给的 row id 认领——那等于让客户端指哪打哪；
--   · `expires_at` 令牌到期时刻（取自令牌自身 `exp`，写时定稿，不是读时重算）——
--                  读取端据此过滤掉早凉的行；
--   · `claimed_at` 被认领时刻（**NULL = 还没被用掉**）——一次性核销的判据。同一枚令牌
--                  被点第二次、或两个标签页同时点，只有第一个能把 NULL 改成值。
--
-- ⚠️ 安全语义（与 `agent/confirm.py` 头注同一套，改之前重读一遍）：
--   本表现在会存**令牌原文**（刷新后要能重建一张真能用的卡片，就得把它交回给同一位
--   主人）。所以：
--     · 读取接口必须**只回本人**（uid 来自令牌/Rust 侧 auth，不是查询参数）；
--     · 令牌列不进日志、不进 trace、不进 prompt（与 confirm.py 同纪律）；
--     · 行本身不是凭据——验签仍是唯一凭据。表里有行、令牌过期或签名不符 ⇒ 零执行。
--
-- 幂等与执行前提：
--   · MySQL 不支持 `ADD COLUMN IF NOT EXISTS`，重复执行会报
--     `Duplicate column name 'question'`（第一个就停）——那说明已经应用过了，停手即可。
--   · 纯结构变更、零回填：存量行 5 列取默认值（空串/NULL = "这张卡片没法重建"），
--     读取端据此**如实不留卡片**，不去编一个问句出来。
--   · 不锁表：本表当前行数是个位数（新表 + 每次只留最新一条）。
--   · **迁移没跑不许推送**：Rust 一上线就会写这 5 列（sea-orm 的 INSERT/UPDATE 会带上
--     它们），缺列会让弹窗那一轮直接失败——与 user_message_title_20260922 同一口径。
-- flag: pending_action_card_20260924（migration_flags，勿重跑）
--
-- 列定义与代码对齐的四处（改一处要四处一起改）：
--   1. `question` varchar(500) ← Rust `PENDING_QUESTION_COL_MAX`、agent 侧同一问句；
--   2. `options`  varchar(600) ← 选项最多两项（确定/取消），紧凑 JSON；
--   3. `jti`      varchar(64) ← agent `confirm.sign` 里 payload 的 `jti`（32 位十六进制）；
--   4. `expires_at` / `claimed_at` 都是 **datetime NULL**——"还没有"只有一种表示（NULL）。
-- =============================================================================

ALTER TABLE `pending_action`
    ADD COLUMN `question` varchar(500) NOT NULL DEFAULT ''
        COMMENT '确认卡片问句（与弹窗同源，写时定稿；空串=这张卡片不可重建）'
        AFTER `target`,
    ADD COLUMN `options` varchar(600) NOT NULL DEFAULT ''
        COMMENT '选项 JSON（label/value/kind；前端不自己造按钮）'
        AFTER `question`,
    ADD COLUMN `jti` varchar(64) NOT NULL DEFAULT ''
        COMMENT '令牌 id（签在令牌里）——原子核销的键'
        AFTER `options`,
    ADD COLUMN `expires_at` datetime DEFAULT NULL
        COMMENT '令牌到期时刻（取自令牌自身 exp，展示/过滤用；验签才是唯一凭据）'
        AFTER `jti`,
    ADD COLUMN `claimed_at` datetime DEFAULT NULL
        COMMENT '被认领时刻；NULL=还没被用掉（一次性核销的判据）'
        AFTER `expires_at`,
    ADD KEY `idx_pa_jti_claim` (`jti`, `claimed_at`);

-- 应用后自检：5 列都在、类型对不对、这几个键有没有建上
SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'pending_action'
  AND COLUMN_NAME IN ('question', 'options', 'jti', 'expires_at', 'claimed_at')
ORDER BY ORDINAL_POSITION;

SELECT '应恰为 5 列' AS done, COUNT(*) AS 新列数
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'pending_action'
  AND COLUMN_NAME IN ('question', 'options', 'jti', 'expires_at', 'claimed_at');

SELECT '核销索引' AS done, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS 列
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'pending_action'
  AND INDEX_NAME = 'idx_pa_jti_claim'
GROUP BY INDEX_NAME;

-- 存量行如实看一眼（**20260924 实测：3 行、全部无令牌**——表 20260923 上线后真的弹过
-- 三次窗。这 3 行的 5 列都是"空"= 卡片不可重建，**不要**为了"看起来完整"去回填问句：
-- 那会编出一张系统从没弹过的卡。它们会随会话删除 / 被新待办顶掉 / 超出读侧时效。）
SELECT '存量行' AS done, COUNT(*) AS 行数,
       SUM(CASE WHEN `jti` = '' THEN 1 ELSE 0 END) AS 无令牌行
FROM `pending_action`;

-- flag（放在最后：跑到这行才算迁移完成）
INSERT INTO migration_flags (flag_name) VALUES ('pending_action_card_20260924');
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'pending_action_card_20260924';

-- 回滚（只在确实要撤时用；注意撤列会一并丢掉"哪张卡片已被认领"的记录）：
--   ALTER TABLE `pending_action` DROP INDEX `idx_pa_jti_claim`,
--     DROP COLUMN `claimed_at`, DROP COLUMN `expires_at`,
--     DROP COLUMN `jti`, DROP COLUMN `options`, DROP COLUMN `question`;
--   DELETE FROM migration_flags WHERE flag_name = 'pending_action_card_20260924';
