USE saudade_blog;
-- =============================================================================
-- 匿名点赞（20261001，用户第 2 条：「点赞改为非登录用户也可以点赞」）
--
-- 此前是 `user_id int NOT NULL` + `UNIQUE(note_id, user_id)` —— 一人一行，匿名无位。
-- 放开匿名需要一个新的"访客"身份，且**不能复用 user_id**：那个列上有指向 `user`
-- 的外键，塞不进 0 之类的哨兵值（同 `user_notification` 不用 0 当广播哨兵的取舍）。
--
-- 于是加一列 `visitor_key`（浏览器自己生成、随请求头 `X-Visitor-Key` 上报），
-- 两种身份并排住在一张表里：
--   · 登录   ⇒ `user_id = <uid>`，`visitor_key = NULL`
--   · 匿名   ⇒ `user_id = NULL`，`visitor_key = '<本浏览器标识>'`
--
-- **两个唯一键各管一边，谁都不删**：
--   · `uq_like_note_user(note_id, user_id)`         —— 登录行去重
--   · `uq_like_note_visitor(note_id, visitor_key)`  —— 匿名为去重
-- MySQL 的唯一索引把 NULL 当成**互不相同**的值 ⇒ 每条索引天然只约束"自己那一半"，
-- 另一半（NULL）的行对它完全透明。这是 MySQL 里"两个部分唯一索引"的标准写法，
-- 不是"漏了一半"。**删掉 `uq_like_note_user` 会让登录行失去约束**（剩下那条索引
-- 对 visitor_key=NULL 的行不生效），同一个账号当场能重复点赞 —— 幂等性来自
-- 唯一键，不来自代码里的"先查再插"。
--
-- ★ 两条语义要点（写在这里，否则下一个人会按错的前提读报表/写文档）：
--
--   1. `visitor_key` 是**客户端自己生成、自己上报**的，服务端只做格式校验。
--      清掉 localStorage、换个浏览器、或者直接 curl 换一个 key，同一个人就能
--      重复点赞。**"点赞数"从此与"阅读量"同一档可信度**：它统计的是"有多少次
--      点赞动作被发出来"，不是"多少个人点了赞"。
--      `docs/security-boundary.md` 里那条"点赞没有这个问题（要求登录 + 一人一行）"
--      本次已同步改写 —— 那份文档是仓里对外的信任边界台账，别只改代码不改它。
--
--   2. **登录态的点赞会顺带清掉同一 `visitor_key` 的匿名行**（Rust 侧实现）。
--      否则"先匿名点一下、再登录点一下"会让同一台浏览器投出两票，
--      而两票在报表上分不出来。取消点赞同理：登录后取消，两行一起清。
--
-- 幂等与执行前提：
--   · MySQL 的 `ADD COLUMN` / `ADD KEY` 没有 `IF NOT EXISTS`，重复执行会报
--     `Duplicate column name` / `Duplicate key name` —— **那说明已经应用过了，
--     停手即可**。本文件不含 UPDATE/DELETE，改不坏任何数据。
--   · `MODIFY user_id` 是把 NOT NULL **放宽**为 NULL，存量行全部照旧
--     （它们的 user_id 本来就有值），零回填、零重建语义。
--   · 表极小（个位数行），ALTER 是秒级；`fk_like_user` / `fk_like_note` 两个外键
--     原样保留（外键列可空是合法的：NULL 行不参与外键检查，也**不会**被级联删到）。
--   · **迁移没跑不许推送**：新代码写 visitor_key、按可空 user_id 解码，列不在
--     ⇒ 点赞接口当场 500。顺序只能是"先跑迁移、再 push"。
-- flag: note_like_anon_20261001（migration_flags，勿重跑）
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- =============================================================================

ALTER TABLE `note_like`
    MODIFY COLUMN `user_id` int NULL
        COMMENT '点赞的账号（登录用户）；匿名为 NULL',
    ADD COLUMN `visitor_key` varchar(64) NULL
        COMMENT '匿名访客标识（浏览器生成、随 X-Visitor-Key 上报）；登录行为 NULL'
        AFTER `user_id`,
    ADD UNIQUE KEY `uq_like_note_visitor` (`note_id`, `visitor_key`);

INSERT INTO migration_flags (flag_name) VALUES ('note_like_anon_20261001');

-- ── ① 自检：两列的形状对得上 ────────────────────────────────────────────────
-- 期望：2 行。`user_id` IS_NULLABLE=YES、类型 int；
--       `visitor_key` IS_NULLABLE=YES、varchar(64)、紧排在 user_id 之后。
SELECT '列' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_like'
   AND COLUMN_NAME IN ('user_id', 'visitor_key')
 ORDER BY ORDINAL_POSITION;

-- ── ② 自检：两条唯一键都在，且各自的分列对得上 ──────────────────────────────
-- 期望：uq_like_note_user = (note_id, user_id) 两条分列；
--       uq_like_note_visitor = (note_id, visitor_key) 两条分列。
SELECT '唯一键' AS done, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_like'
   AND INDEX_NAME IN ('uq_like_note_user', 'uq_like_note_visitor')
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- ── ③ 存量行核对：跑完本文件（还没上代码）时，匿名行必须是 0 行 ──────────────
-- 期望：总数不变、`匿名的行数` = 0。**若不为 0，先停手查清是谁写的**——
-- 本文件不造任何匿名行，能写出 visitor_key 的代码在本次部署之后才存在。
SELECT '存量行' AS done,
       COUNT(*)                     AS 点赞总数,
       SUM(user_id IS NULL)         AS 匿名的行数,
       SUM(visitor_key IS NOT NULL) AS 带访客标识的行数
  FROM `note_like`;

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'note_like_anon_20261001';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- 顺序有讲究：**先删匿名行**，否则 `MODIFY ... NOT NULL` 会因为 user_id 为 NULL
-- 的行而失败（或按 sql_mode 被静默填 0 —— 那更糟，会凭空造出指向 user 0 的点赞）。
--   DELETE FROM `note_like` WHERE `user_id` IS NULL;
--   ALTER TABLE `note_like` DROP INDEX `uq_like_note_visitor`, DROP COLUMN `visitor_key`,
--                           MODIFY COLUMN `user_id` int NOT NULL COMMENT '点赞者（仅登录用户可点赞，不存在匿名行）';
--   DELETE FROM migration_flags WHERE flag_name = 'note_like_anon_20261001';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码一律按这两列读写，
--    列没了就是点赞接口 500（与"没跑迁移就推送"同一种破坏）。
-- ⚠️ 上面那句 DELETE 是**不可逆的**：匿名点赞没有别处的副本，删掉就没了。
--    真要回滚，先把那几行 `SELECT *` 存下来。
