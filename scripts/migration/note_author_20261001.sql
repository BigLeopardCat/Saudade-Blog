USE saudade_blog;
-- =============================================================================
-- 文章作者（20261001）：note.user_id
--
-- 病症（用户原话）：「文章发布的卡片没有作者信息，管理员发的文章还是超级管理员的
-- 头像和署名在文章卡片上。」——卡片/详情页的头像与署名取的是**站点级**那一份
-- （`GET /api/public/user`：uid=1 的 nickname/avatar，回退 web_info），
-- 与"这篇文章是谁发的"毫无关系。**根因是数据不存在**：`note` 表从来没有作者列，
-- 发布那一刻的操作者没有被记下来，展示端只能拿站点主人顶上。所以本迁移只加一列
-- 存事实，署名口径仍沿用既有那套（见下）。
--
-- ── 语义（读取端 `src/routes/notes.rs::attach_authors` 逐条实现，改这里要同步改那边）
--
--   `user_id` = **发布那一刻的操作者** uid（`auth_jwt::auth_uid` 解出来的那个）。
--     NULL = 「没有记录」——**不是**「无作者」。两种 NULL 都要如实回退：
--       · 本迁移之前发布的老文章（存量行一律 NULL，零回填）；
--       · 发布者账号后来被销号（`user` 行没了）。
--     回退目标 = 站点级署名（uid=1 的 nickname/avatar，再退 web_info）⇒ 与改造前
--     **逐字相同**，存量文章的外观一个像素都不变。
--
--   **刻意不回填 uid=1**：回填等于替历史文章编一个"作者"，而那是猜的（谁发的已经
--     无从查证），报表上还分不出"真作者"与"回填值"。留 NULL 才有区别——
--     前端拿到的 authorName 就是站点署名，改天谁能考据出来再单独 UPDATE。
--
--   **命名沿用 `web_info::get_user_info` 的口径**（20260930 那条）：署名优先取
--     `user.nickname`，**不回退 `username`**（登录账号没有理由印在每张卡片上）；
--     头像取 `user.avatar`，为空则站点级那一份。
--
-- ── 写入端（`create_note` / `update_note` / `autosave_note`）
--
--   只有**发布**那条路径写这一列（`update_note` 只在原值为 NULL 时补写——
--   别人编辑过的文章不该因为"最后一个保存的人"而改署名，见 `notes.rs` 里那段注释）。
--
-- ── 幂等与执行前提
--
--   · ADD COLUMN 没有 IF NOT EXISTS（MySQL 不支持），重复执行报
--     `Duplicate column name 'user_id'` ⇒ **那说明已经应用过了，停手即可**，
--     不会改坏数据。
--   · 无数据回填、无 UPDATE/DELETE ⇒ 除表结构外零写入。
--   · `note` 表行数在千级，ADD COLUMN 是即时元数据变更（可空、无默认值），不锁表。
--   · ★ **本迁移必须先于 Rust 上线**：`entity/note.rs` 加了字段之后，**每一处
--     `note::Entity::find*` 都会 SELECT 新列**（公开列表 / 详情 / 搜索 / 后台列表 /
--     看板娘读文章），列不存在不是"卡片少个作者"，而是这些接口**全部 500**。
--     CI 的路径过滤器不认识迁移，没人拦得住这条，只能靠纪律 + 下面那行 flag。
--   · 不加索引：读取端只按 `note.user_id` 取值（不反查"某人发过哪些文章"），
--     uid 是主键、走 user 表的 PK。真要做"作者页"时再补 `KEY idx_note_user (user_id)`。
--
-- flag: note_author_20261001（migration_flags，勿重跑）
-- =============================================================================

ALTER TABLE `note`
    ADD COLUMN `user_id` int NULL DEFAULT NULL
        COMMENT '发布者 user.id；NULL = 未记录（老文章或账号已销）⇒ 展示端回退站点级署名'
        AFTER `draft_of`;

INSERT INTO migration_flags (flag_name) VALUES ('note_author_20261001');

-- 校验：列在、类型对、存量行全是 NULL（期望 null_rows = total_rows）
SELECT 'column' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'note' AND COLUMN_NAME = 'user_id';

SELECT 'rows' AS done,
       (SELECT COUNT(*) FROM note) AS total_rows,
       (SELECT COUNT(*) FROM note WHERE user_id IS NULL) AS null_rows,
       (SELECT COUNT(*) FROM note WHERE user_id IS NOT NULL) AS authored_rows;
