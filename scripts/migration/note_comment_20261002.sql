-- flag: note_comment_20261002（migration_flags，勿重跑）
USE saudade_blog;
SELECT '表已存在?' AS done, TABLE_NAME, CREATE_TIME
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_comment';

-- 1b) 评论要挂的文章共有多少篇（只是让执行者对体量有个数；本表建完后为空）。
SELECT '文章总数' AS done, COUNT(*) AS 行数 FROM note;

-- 1c) flag 是否已经打过。期望**空**。
SELECT 'flag 已存在?' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'note_comment_20261002';

-- ── ② 建表 ─────────────────────────────────────────────────────────────────
-- 字符集/排序规则显式跟随全库（`utf8mb4_0900_ai_ci`）——`content` 与 `ai_reason`
-- 都要能存中文与表情。**不写 `COLLATE` 以外的排序规则**，避免与 `talk` 的文本比较
-- 行为出现第二套口径。
CREATE TABLE IF NOT EXISTS `note_comment` (
    `id`            int           NOT NULL AUTO_INCREMENT,
    `note_id`       int           NOT NULL COMMENT '所属文章 id（note.id）。无外键，理由见文件头注',
    `user_id`       int           NOT NULL COMMENT '评论者 uid（恒 >0：发言强制登录）',
    `content`       text          NOT NULL COMMENT '评论正文（≤300 字，服务端校验；**不转义**，渲染走前端 markdown 管线）',
    `root_id`       int           DEFAULT NULL COMMENT '顶层评论 id；NULL = 本行就是顶层（对回复的回复仍挂同一个顶层）',
    `parent_id`     int           DEFAULT NULL COMMENT '直接父评论 id；NULL = 顶层。「回复 @某人」由它派生',
    `reply_to_uid`  int           DEFAULT NULL COMMENT '被回复者 uid；**只存 uid 不存昵称快照**（列表 join user 取最新昵称）',
    `approved`      tinyint(1)    NOT NULL DEFAULT 1 COMMENT '审核状态：0=待审（公开读不到）/ 1=通过 / 2=未通过（驳回）',
    `ai_result`     varchar(8)    DEFAULT NULL COMMENT 'AI 审核判定留痕：pass / flag / reject；NULL = 没走 AI',
    `ai_reason`     varchar(200)  DEFAULT NULL COMMENT 'AI 审核说明：**与裁决无关**，pass/flag/reject 都记；人工未填驳回理由时回落到它。改判不回溯',
    `reject_reason` varchar(200)  DEFAULT NULL COMMENT '驳回理由：管理员手填或沿用 AI 说明；**改判回通过时清空**',
    `is_deleted`    tinyint(1)    NOT NULL DEFAULT 0 COMMENT '软删：1=已删（公开读过滤）。有回复的顶层不物理删，否则子行成孤儿',
    `created_at`    datetime      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    datetime      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_note_comment_public` (`note_id`, `root_id`, `approved`, `created_at`),
    KEY `idx_note_comment_root`   (`root_id`, `created_at`),
    KEY `idx_note_comment_user`   (`user_id`, `created_at`),
    KEY `idx_note_comment_audit`  (`approved`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='文章评论（20261002）：两层结构 root_id/parent_id，见迁移文件头注';

-- ── ③ 验收 ─────────────────────────────────────────────────────────────────
-- 3a) 列与默认值：期望 14 行，逐列肉眼过一遍。**重点看 `approved` 默认 1**
--     （与 talk 一致：审核开关全关时评论照常可见）与 `is_deleted` 默认 0。
SELECT '列' AS done, ORDINAL_POSITION AS pos, COLUMN_NAME, COLUMN_TYPE,
       IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_comment'
 ORDER BY ORDINAL_POSITION;

-- 3b) 索引：期望 5 行（PRIMARY + 4 条），四条二级索引的列序与文件头注逐字一致
--     ——**列序就是查询能不能用上它的全部**，`(a,b)` 与 `(b,a)` 是两条不同的索引。
SELECT '索引' AS done, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note_comment'
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 3c) 空表核对：期望 行数 = 0。
SELECT '空表' AS done, COUNT(*) AS 行数 FROM `note_comment`;

-- ── ④ 打 flag ──────────────────────────────────────────────────────────────
-- 重复执行会因主键/唯一键报错 ⇒ 那说明已经打过，忽略即可。
INSERT INTO migration_flags (flag_name) VALUES ('note_comment_20261002');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'note_comment_20261002';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- **先回滚代码、再删表**（反了的话评论接口在表没了之后 500，虽然不影响站内其它功能）：
--   DROP TABLE IF EXISTS `note_comment`;
--   DELETE FROM migration_flags WHERE flag_name = 'note_comment_20261002';
-- ⚠️ DROP TABLE 会**连评论一起删**，且取不回来（回滚前请自行
--    `SELECT * FROM note_comment` 留档，如需）。
-- =============================================================================
