USE saudade_blog;
-- =============================================================================
-- 文章署名被「元数据写」记错（20261007）：把**不是发布写进去**的作者还原成 NULL
--
-- 病症（主人原话 20261007）：「文章无论怎么提交都是721用户是作者，这个BUG哪来的修掉。」
--   现场 = 文章 23《Python asyncio 异步并发…》：卡片署名 `agent_test_admin_721`
--   （uid 721，**评测专用**管理员账号），而主人**反复在后台编辑器里保存它都改不回来**
--   （20261007 18:26:46 / 20:11:23 / 20:11:58 三次 `POST /api/protected/notes/23`，
--   见 `logs/rust.log`）。
--
-- ── 根因（两半；代码那一半已在 `src/routes/notes.rs::update_note` 修掉）
--
--   ① **写入端判据缺一条**：署名回填原先只判 `user_id IS NULL`，**不判这一笔是不是
--      「发布」** ⇒ 任何一次写都会把**写的人**记成作者。而 `note_author_20261001.sql`
--      写明的契约是「只有**发布**那条路径写这一列」——实现与契约在这一格上是分开的。
--      出事的这两条路都不是发布：
--        · `POST /api/protected/notes/<id>` 只带 `noteTags`（agent 的 `set_article_tags`）；
--        · 同端点只带 `{status,isTop}`（agent 的 `set_article_status`、后台列表的快速改状态）。
--      修法 = 回填再加 `from_editor`（`payload.title` / `content` 至少带来一个，
--      也就是"从编辑器提交的完整发布"这一路）。改完后只有编辑器提交能补署名。
--
--   ② **现场**：20261007 08:26:52 评测跑（`eval/drafts/` 那批，见其 `REVIEW_20261008.md` §0）
--      以 uid 721 执行 `set_article_tags(article_id=23, replace=["Rust"])`
--      → `POST /api/protected/notes/23`（`logs/rust.log` 08:26:52.385）。文章 23 那一行
--      当时 `user_id` 为 NULL——`note_author_20261001.sql` 是**零回填**的，
--      20261001 之前发布的老文章一律 NULL ⇒ 这一笔把它记成了 721。
--      08:26:51 的 `POST /api/protected/category`（分类）与 08:26:20 的
--      `POST /api/protected/tagone`（标签）是同一批判定里另外两条真写，**与署名无关**。
--
--   ③ **错误为什么"改不回来"**：`update_note` 的「只在原值为 NULL 时补写」本意是
--      「别人编辑过的文章不该因为最后一个保存的人而改署名」，它同时把这次误记**固化**了
--      ——主人自己的编辑器保存同样走这条规矩（原值非 NULL ⇒ 不动），于是"无论怎么提交
--      都是 721"。这一格靠本脚本还原，代码侧不做"允许改写已记的署名"（那会推翻那条本意）。
--
-- ── 本脚本做且只做一件事
--
--   把这些「不是发布写进去的」署名还原成 **NULL**（= 未记录）⇒ 展示端回退站点级署名
--   （`GET /api/public/user` 的 `blogAuthor` = `Sora Saudade` + 站点头像），与 20261001
--   之前**逐字相同**、与同站其它老文章一致（老文章本来就全是 NULL，外观不变）。
--
-- ── 为什么还原成 NULL，而不是回填 uid=1
--
--   与 `note_author_20261001.sql` 同一条口径：NULL 是「**没有记录**」（真的），uid=1 是
--   替历史文章**编一个**作者（猜的），两者在报表上分得开（该迁移的注释里写着
--   「留 NULL 才有区别……改天谁能考据出来再单独 UPDATE」）。真要把某一篇署名给自己，
--   那是另一件事、另一次 UPDATE，别混在这一条里。
--   还原成 NULL 之后**这一格是自愈的**：下一次从编辑器保存它，就会照新规矩记成保存者本人。
--
-- ── 为什么靶是 `user_id IN (721, 722)` 而不是 `id = 23`
--
--   · 721 `agent_test_admin_721` / 722 `agent_test_user_722` 是 20260924 建的**评测专用**
--     账号（`test_accounts_20260924.sql`：密码是三个 UUID 拼的、从不登录）。
--   · agent 侧**没有任何工具能创建文章**——写文章的只有 `set_article_status` /
--     `set_article_tags` 两条元数据路（`tools/base.py`），两条都不在发布路径上
--     ⇒ 721/722 名下的文章行**不可能**是它们"发布"的，逐行都是这一类的误记。
--   · 按 id 写死只会修好这一个现场，把同族的下一个留下来。§① 会在改之前把命中的行
--     **连标题一起打出来**，跑之前先看一眼那一屏。
--
-- ── 执行前提与顺序（重要）
--
--   ★ **先确认线上跑的是修好的那版 Rust**（`update_note` 带回填判据 `from_editor`），
--     否则还原之后，下一次元数据写会照旧把它记上，等于白跑。判据 = `curl -s
--     https://saudade.site/build-info.json` 里的 sha **在**这次修复提交之后。
--   · 幂等：flag `note_author_meta_write_fix_20261007`；重跑时 §① 会是 0 行、UPDATE 是空操作。
--   · 只动 `note.user_id` 一列、只动 721/722 这两行主键名下那些行，不碰正文/标签/状态，
--     不删行（§③ 把总行数一起打出来对账）。
--
-- flag: note_author_meta_write_fix_20261007（migration_flags，勿重跑）
-- =============================================================================

-- ── ① 改之前：命中的行连标题、账号名一起打出来（期望：文章 23 一行；若不止一行，看清楚了再往下）
SELECT 'before' AS done, n.id, n.title, n.status, n.is_public,
       n.user_id, u.nickname AS account, n.updated_at
  FROM note n LEFT JOIN user u ON u.id = n.user_id
 WHERE n.user_id IN (721, 722)
 ORDER BY n.id;

-- ── ② 还原成「未记录」
UPDATE note SET user_id = NULL WHERE user_id IN (721, 722);

INSERT INTO migration_flags (flag_name) VALUES ('note_author_meta_write_fix_20261007');

-- ── ③ 改之后：期望 stale_rows = 0；total_rows 与 ① 之前相同（本脚本不增不删行）
SELECT 'after' AS done,
       (SELECT COUNT(*) FROM note WHERE user_id IN (721, 722)) AS stale_rows,
       (SELECT COUNT(*) FROM note) AS total_rows,
       (SELECT COUNT(*) FROM note WHERE user_id IS NULL) AS null_rows;

SELECT 'flag' AS done, flag_name, applied_at
  FROM migration_flags WHERE flag_name = 'note_author_meta_write_fix_20261007';
