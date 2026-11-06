-- flag: note_comment_vote_20261003（migration_flags，勿重跑）
USE saudade_blog;
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

-- ② 建表
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

-- ③ 验收
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

-- ④ 打 flag
-- 重复执行会因主键/唯一键报错 ⇒ 那说明已经打过，忽略即可。
INSERT INTO migration_flags (flag_name) VALUES ('note_comment_vote_20261003');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'note_comment_vote_20261003';

-- 回滚（如需）
-- **先回滚代码、再删表**：反了的话投票端点在表没了之后 500。讨论区读取那条路
-- 只是少两个数（`vote_counts_for` 查失败按空表处理），不会整页打挂——但别依赖这个。
--   DROP TABLE IF EXISTS `note_comment_vote`;
--   DELETE FROM migration_flags WHERE flag_name = 'note_comment_vote_20261003';
-- ⚠️ DROP TABLE 会**连票一起删**且取不回来（回滚前如需留档先自行
--    `SELECT * FROM note_comment_vote`）。
-- ⚠️ 与 `note_like_anon` 那条不同，这里**没有"必须删掉某半边行才能回滚"的坑**：
--    本文件从头就是两张可空列，回滚只是 drop 一整张表。
