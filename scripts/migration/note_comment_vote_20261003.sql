USE saudade_blog;
-- =============================================================================
-- 评论点赞 / 踩（20261003，用户第 4 条：「讨论区评论增加点赞和踩。」）
--
-- 用户已拍板的形态：「访客也能点，不改排序」——**投票不影响列表顺序**（讨论区仍是
-- 时间序：顶层新→旧、回复旧→新，见 `comments.rs::list_comments`）。这不是"这一版先
-- 不做排序"，是**选的这个形态**：按票数排会让一条新评论永远沉底，而讨论区不是
-- 内容站的热榜。
--
-- ── 为什么另起一张表，不往 `note_comment` 上加两列 ────────────────────────
-- 计数字段（`up`/`down`）看着是"评论的两个属性"，但它们是**并发写**：投一票就要改
-- 那一行的列，同一秒里十几个人投同一条热评就是十几次行锁排队，而**读者每拉一次
-- 讨论区都要读它们**。做成聚合（一行一票）之后，写入只插自己的行、读取一条 GROUP BY
-- 算完，写路径之间零争用。口径与文章卡片那四个数（`note_stats.rs::counts_for`）
-- 完全一致——**那不是"计数也存在表里"**，是从明细现算。
--
-- ── 结构照搬 `note_like`（20261001 匿名点赞那次）────────────────────────────
-- 两列身份并排，一个身份一行，去重全靠唯一键：
--   · 登录 ⇒ `user_id = <uid>`，`visitor_key = NULL`
--   · 匿名 ⇒ `user_id = NULL`，`visitor_key = '<本浏览器标识>'`
-- **两条唯一键各管一边**（`uq_comment_vote_user` / `uq_comment_vote_visitor`）：
-- MySQL 的唯一索引把 NULL 当成互不相同 ⇒ 每条只约束"自己那一半"，另一半对它透明。
-- 这是"两个部分唯一索引"的标准写法，**不是漏了一半**；删掉 `uq_comment_vote_user`
-- 会让登录行当场失去约束（剩下那条对 `user_id IS NULL` 的行不生效）——幂等来自唯一键，
-- 不来自代码里的"先查再插"。这两条纪律的完整版（含"visitor_key 是客户端自报、
-- 可清可换、因此点赞数与阅读量同一档可信度"）写在
-- `note_like_anon_20261001.sql` 的头注里，**这里不重抄**——两份写全了迟早会分叉。
-- 唯一的差别只是判据列从 `note_id` 换成 `comment_id`。
--
-- ── `value` 只有 ±1，**没有 0** ────────────────────────────────────────────
-- 撤回（用户再点一次自己已经点过的那一侧）= **DELETE 那一行**，不是写一个 0。
-- 理由是唯一键：`value = 0` 的行仍占着 (comment_id, user_id) 这个位置，下次再想投
-- 就得先 UPDATE——"投/撤/投"与"改主意"就变成了两种写入形状，多一条分支就多一处
-- 能写歪的地方。行在 = 投过，行不在 = 没投，与 `note_like` 同一套心智。
-- 改主意（赞→踩）走 UPDATE：幂等且不产生"这一瞬间没有行"的窗口。
--
-- ── 无外键（同 `note_comment`）─────────────────────────────────────────────
-- `comment_id` 不指向 `note_comment` 加外键。`note_comment` 自己就不带外键
-- （"文章可删，评论留着更好考古"），而且**评论只有软删**（`is_deleted`，
-- 后台删评论也是软删，见 `comments.rs::delete_comment_admin`）⇒ 不存在级联删除要
-- 委托给外键的场景，也就不存在"孤儿票"。公开读那边更是双重保险：票只按**当页真正
-- 渲染的那些评论 id** 聚合，软删的评论根本不在那个集合里。
--
-- ── 索引：两条唯一键就够，不另加 ──────────────────────────────────────────
-- 读取路径只有两条，都能用上唯一键的最左列 `comment_id`：
--   · 一次讨论区 → 一条 `WHERE comment_id IN (…) GROUP BY comment_id`（`vote_counts_for`）；
--   · 一次投票 → 一条 `WHERE comment_id = ? AND <身份条件>`（`my_votes` / 写入前查）。
-- `(comment_id, user_id)` 的最左前缀就是 `comment_id`，再单独建一条
-- `KEY (comment_id)` 是纯冗余（同 `note_comment` 那四条各自对应一条真实路径的取舍）。
--
-- ── 顺序 ──────────────────────────────────────────────────────────────────
-- **纯加表**，不改任何既有表 ⇒ 先跑后跑都不打挂线上既有功能。硬顺序只有一处：
-- **投票接口上线前这张表必须先在**——否则新端点是 500。
-- `CREATE TABLE IF NOT EXISTS` ⇒ 重复执行是 no-op，不报错。
--
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- flag: note_comment_vote_20261003（migration_flags，勿重跑）
-- =============================================================================

-- ── ① 核对（跑之前先看这三条）──────────────────────────────────────────────

-- 1a) 表是否已经存在。期望**空**——非空说明已经应用过，停手（下面的
--     CREATE TABLE IF NOT EXISTS 虽不会报错，但会让你误以为"这次才建"）。
SELECT '表已存在?' AS done, TABLE_NAME, CREATE_TIME
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_comment_vote';

-- 1b) 现有评论数（只是让执行者对体量有个数；本表建完后为空）。
--     票只挂在 `approved = 1 AND is_deleted = 0` 的评论上，其余评论不会有票。
SELECT '可投票的评论数' AS done, COUNT(*) AS 行数
  FROM `note_comment` WHERE `approved` = 1 AND `is_deleted` = 0;

-- 1c) flag 是否已经打过。期望**空**。
SELECT 'flag 已存在?' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'note_comment_vote_20261003';

-- ── ② 建表 ─────────────────────────────────────────────────────────────────
-- 字符集/排序规则显式跟随全库（`utf8mb4_0900_ai_ci`）——`visitor_key` 要与
-- `note_like.visitor_key` 比得起来（那张表也是这个排序规则），不显式写就会跟
-- 库默认走，哪天默认改了就是"同一串 key 在两张表上算不等"这种鬼故事。
CREATE TABLE IF NOT EXISTS `note_comment_vote` (
    `id`          int         NOT NULL AUTO_INCREMENT,
    `comment_id`  int         NOT NULL COMMENT '被投票的评论 id（note_comment.id）。无外键，理由见文件头注',
    `user_id`     int         DEFAULT NULL COMMENT '投票的账号；**匿名投票为 NULL**（不用 0 当哨兵，同 note_like）',
    `visitor_key` varchar(64) DEFAULT NULL COMMENT '匿名访客标识（浏览器生成、随 X-Visitor-Key 上报）；登录投票为 NULL',
    `value`       tinyint     NOT NULL COMMENT '+1=赞 / -1=踩。**没有 0**：撤回是 DELETE 行，见文件头注',
    `created_at`  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面（库连接已设 timezone=+08:00）',
    `updated_at`  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '改主意（赞↔踩）时刷新；没有任何端点读它，留作事后对账',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_comment_vote_user`    (`comment_id`, `user_id`),
    UNIQUE KEY `uq_comment_vote_visitor` (`comment_id`, `visitor_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='评论点赞/踩（20261003）：一票一行，两种身份并排，见迁移文件头注';

-- ── ③ 验收 ─────────────────────────────────────────────────────────────────
-- 3a) 列与默认值：期望 7 行，逐列肉眼过一遍。**重点看 `user_id`/`visitor_key`
--     两列 IS_NULLABLE 都是 YES**（那是"两种身份并排"的全部机制）与 `value`
--     的 NOT NULL（没有 0 这一档，但**也没有默认值**：写票必须显式给 ±1）。
SELECT '列' AS done, ORDINAL_POSITION AS pos, COLUMN_NAME, COLUMN_TYPE,
       IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_comment_vote'
 ORDER BY ORDINAL_POSITION;

-- 3b) 索引：期望 **5 行**（PRIMARY 一条 + 两条唯一键各两条分列）。
--     列序与文件头注逐字一致——`(a,b)` 与 `(b,a)` 是两条不同的索引，
--     而这里 `comment_id` 必须都在最左（聚合与身份查询都吃这个前缀）。
SELECT '索引' AS done, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_comment_vote'
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 3c) 空表核对：期望 行数 = 0。**若不为 0，先停手查清是谁写的**——
--     本文件不造任何票，能写出票的代码在本次部署之后才存在。
SELECT '空表' AS done, COUNT(*) AS 行数 FROM `note_comment_vote`;

-- ── ④ 打 flag ──────────────────────────────────────────────────────────────
-- 重复执行会因主键/唯一键报错 ⇒ 那说明已经打过，忽略即可。
INSERT INTO migration_flags (flag_name) VALUES ('note_comment_vote_20261003');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'note_comment_vote_20261003';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- **先回滚代码、再删表**：反了的话投票端点在表没了之后 500。讨论区读取那条路
-- 只是少两个数（`vote_counts_for` 查失败按空表处理），不会整页打挂——但别依赖这个。
--   DROP TABLE IF EXISTS `note_comment_vote`;
--   DELETE FROM migration_flags WHERE flag_name = 'note_comment_vote_20261003';
-- ⚠️ DROP TABLE 会**连票一起删**且取不回来（回滚前如需留档先自行
--    `SELECT * FROM note_comment_vote`）。
-- ⚠️ 与 `note_like_anon` 那条不同，这里**没有"必须删掉某半边行才能回滚"的坑**：
--    本文件从头就是两张可空列，回滚只是 drop 一整张表。
-- =============================================================================
