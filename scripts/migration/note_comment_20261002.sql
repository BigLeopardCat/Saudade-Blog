USE saudade_blog;
-- =============================================================================
-- 文章评论（20261002）：新表 `note_comment` —— 两层结构（评论 + 回复）
--
-- 用户原话：「文章详情页底部增加讨论区……用户之间也可以在评论下面评论，相互回复。」
--
-- ── 为什么**另起一张表**，不塞进 `talk` ───────────────────────────────────
-- `talk` 的 `cat`/`v`/`src`/`author` 是河灯语义（灯型 / 印章 / 来源），它的读取路径
-- 处处以 `src='board'|'talk'` 为判据（`list_by_src`、后台两个视图、风控计数）。
-- 塞第三个 `src` 值等于让**每一处既有过滤都要重审**，而两者要展示的列又完全不同
-- （评论要 note_id 与回复关系，河灯要灯型与印章）。新表的代价是一条 CREATE TABLE，
-- 旧表的代价是"每一处 src 判据都可能漏改"——后者不划算。
--
-- ── 两层结构：`root_id` 与 `parent_id` **都要** ───────────────────────────
-- 产品形态（已拍板）：评论 + 回复两层。**对回复的回复仍挂在同一个顶层评论下**，
-- 显示成「回复 @某人」——不是三层缩进。
--   · `parent_id` = 直接父评论（「回复 @谁」由它定：reply_to_uid 从父行的 user_id 派生）；
--   · `root_id`   = 顶层评论 id；**顶层行自身为 NULL**。
-- 只留 `parent_id` 也能表达同样的树，但取一整棵子树要么写递归 CTE、要么对每条顶层
-- 再发一次查询（N+1）。有 `root_id` 之后整个讨论区只要 **2 条查询**（顶层一次 +
-- `root_id IN (…)` 一次）。**这才是"回复的回复不另起一层"的机械保证**，
-- 而不是靠前端缩进假装。
--
-- ── 写入侧派生，不信任客户端 ──────────────────────────────────────────────
-- 请求体**只收 `parent_id`**。服务端查出父行，校验 `parent.note_id == note_id` 且
-- `parent.approved = 1`（不能回复一条自己都看不见的评论），再令
-- `root_id = parent.root_id.unwrap_or(parent.id)`、`reply_to_uid = parent.user_id`。
-- `reply_to_uid` **只存 uid、不存昵称快照**：列表本来就要 join `user`，多一个
-- LEFT JOIN 成本为零，且永远显示对方**最新**昵称（改名后旧回复不显示旧名）。
--
-- ── 审核四列与 `talk` 同名同义（后台两个现成组件可原样搬）──────────────────
-- `approved` 0=待审 / 1=通过（公开列表只放行 1）/ 2=未通过；
-- `ai_result` pass/flag/reject 三个字面量留痕；`ai_reason` 与裁决无关、所有裁决都记；
-- `reject_reason` 人工手填或回落到 AI 说明，**改判回通过时清空**。
-- 裁决本身走 `routes/talks.rs::decide_review`（留言板那条链路的**同一份实现**，
-- 不是照抄一份），开关是另一对键 `commentAiReviewEnabled`/`commentManualReviewEnabled`
-- （留言板那两个键不动，见 `routes/web_info.rs::COMMENT_REVIEW_KEYS`）。
--
-- ── 无外键（同 `quota_request`）────────────────────────────────────────────
-- `note_id` / `user_id` 都不加外键。理由与那张表一致：文章有删除动作，加了外键就
-- 要么改删除路径、要么让删除失败；评论在文章没了之后本就没有读取路径（公开读按
-- note_id 过滤），留着比级联删更好考古。
--
-- ── 软删 ──────────────────────────────────────────────────────────────────
-- `is_deleted` 而非物理删：**有回复的顶层评论不能被硬删**——删了父行，子行就成
-- 了孤儿（`root_id` 指向一个不存在的 id），组树时整棵子树凭空消失。软删之后
-- 公开读直接过滤 `is_deleted = 0`，回复的子行仍在库里（将来要做"该评论已删除"
-- 占位也不用再迁数据）。
--
-- ── 索引：四条，各对应一条真实读取路径 ───────────────────────────────────
--   · `idx_note_comment_public (note_id, root_id, approved, created_at)` — 公开读
--     （按 note_id 取某一篇的可见评论，再按 root_id 分组）；
--   · `idx_note_comment_root   (root_id, created_at)` — 取某个顶层下的全部回复；
--   · `idx_note_comment_user   (user_id, created_at)` — **风控窗口计数**（数这个人
--     最近 N 秒发了多少条，见 `routes/risk.rs`）；
--   · `idx_note_comment_audit  (approved, created_at)` — 后台待审队列。
--
-- ── 顺序（与迁移 A/C 不同，这里**不紧急但仍然是硬顺序**）────────────────────
-- 本文件是**纯加表**：不像 `user` 加列那样"列不存在 ⇒ 每一次用户查询都报错"
-- （本文件不改任何既有表），所以**先跑后跑都不会打挂线上既有功能**。硬顺序只在
-- 一处：**评论接口上线前，这张表必须先在**——否则新端点是 500。
-- 反过来说：先跑本文件、隔天再推代码是完全安全的（空表不影响任何既有查询）。
-- `CREATE TABLE IF NOT EXISTS` ⇒ 重复执行是 no-op，不报错。
--
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- flag: note_comment_20261002（migration_flags，勿重跑）
-- =============================================================================

-- ── ① 核对（跑之前先看这三条）──────────────────────────────────────────────

-- 1a) 表是否已经存在。期望**空**——非空说明已经应用过，停手（下面的
--     CREATE TABLE IF NOT EXISTS 虽不会报错，但会让你误以为"这次才建"）。
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
