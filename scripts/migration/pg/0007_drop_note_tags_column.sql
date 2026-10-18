-- `note.tags` 那一列退休（20261018）—— Stage 3 的 **contract** 那一半。
--
-- ⚠️⚠️ **别急着跑。这个文件有一条硬前提，跑错会让全站写文章 500。** ⚠️⚠️
--
-- ── 前提：代码那边必须先"停止写这一列" ─────────────────────────────────────
-- `0006` 之后代码是**两处同源**：`routes/note_tags.rs::replace_note_tags` 同时写关联表
-- 与这一列（soak 期刻意如此，理由是"回滚必须是一次 `git revert` 就能做完的事"）。
-- 那一半代码**还在写 `note.tags`** —— 列一删，那条 `UPDATE` 就会
-- `column "tags" of relation "note" does not exist`，于是**每一条写路径全 500**
-- （建文章 / 改文章 / 自动保存；改标签与移动标签也走它）。
--
-- 所以顺序只能是：
--   ① `0006` 上线 + 代码切到关联表（两处同源）→ **soak 几天**
--   ② 上一笔**删掉 `replace_note_tags` 里写列那一半**的代码，部署、观察
--   ③ **再**跑本文件
-- ②与③之间那一小段里，这一列是**陈旧的**（不再有人写它）—— 那是刻意的：
-- 陈旧也无所谓，因为**没有任何读路径看它**（`map_note` 从 20261018 起恒置空串）。
--
-- ── 为什么删它是可逆的 ─────────────────────────────────────────────────────
-- 这一列的内容可以从关联表**无损重算**（`string_agg(tag_id, ',' ORDER BY seq)`，
-- 见下面①的预检 —— 那条查询就是回滚语句）。所以"删列"不是单向门，
-- 回滚 = 重建列 + 跑一遍那条 UPDATE。
--
-- ── 跑法 ───────────────────────────────────────────────────────────────────
--   psql -h 127.0.0.1 -U saudade_app -d saudade_blog -X -v ON_ERROR_STOP=1 -f - < 本文件
--   **先跑①的预检，人眼过一遍（期望 0 行）。**
--
-- ── 本文件不进 CI ──────────────────────────────────────────────────────────
-- `ci_schema_files.py` 的 `EXCLUDED` 里点名了它。理由：CI 的库每次从 `0000` 现建，
-- 而 `0000` 里这一列还在 ⇒ 把 0007 塞进 LOAD 等于让 CI 库比生产**更靠前**，
-- 而"列已经不在了"恰恰是 soak 还没到的事。
--
-- ── 跑完之后 `verify_parity.py` 会红在列 diff 上，这是预期的 ─────────────────
-- MySQL 侧那列**永远留着**（MySQL 已冻结，只减不增）。同笔已经在
-- `verify_parity.py` 里加了**单列**豁免 `COLUMN_EXCEPTIONS = {("note", "tags")}`
-- —— 刻意不用"把整张 `note` 加进 `HAND_WRITTEN`"那种写法（那会把它的索引与外键
-- 一起豁免掉）。豁免是双向的：列还在时它不生效。

-- ① 预检：关联表能不能**逐字**重算出这一列。列出对不上的每一篇（期望 0 行）。
--
--    SELECT n.id, n.tags AS 列里的,
--           (SELECT string_agg(t.tag_id::text, ',' ORDER BY t.seq)
--              FROM (SELECT seq, coalesce(tag_one_id, tag_two_id) AS tag_id
--                      FROM "note_tag" WHERE note_id = n.id) t) AS 关联表算出来的
--      FROM "note" n
--     WHERE coalesce(n.tags, '') <> coalesce(
--             (SELECT string_agg(t.tag_id::text, ',' ORDER BY t.seq)
--                FROM (SELECT seq, coalesce(tag_one_id, tag_two_id) AS tag_id
--                        FROM "note_tag" WHERE note_id = n.id) t), '')
--     ORDER BY 1;
--
--    期望 **0 行**。有行就说明 soak 期两边漂了（或者哪条写路径绕过了
--    `replace_note_tags`）—— **停下来查**，别把列删了。
--    ⚠️ 它比的是**逐字相等**（含顺序），不是集合相等：`seq` 就是顺序的真相，
--    比集合会漏掉"顺序变了"这种漂法，而顺序是前端渲染标签的顺序。
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM "note" n
   WHERE coalesce(n."tags", '') <> coalesce(
           (SELECT string_agg(t.tag_id::text, ',' ORDER BY t.seq)
              FROM (SELECT nt."seq", coalesce(nt."tag_one_id", nt."tag_two_id") AS tag_id
                      FROM "note_tag" nt WHERE nt."note_id" = n."id") t), '');
  IF bad > 0 THEN
    RAISE EXCEPTION
      '有 % 篇文章的 note.tags 与 note_tag 重算出来的串**不一致**（含顺序）——'
      '先按①那条查询列出来查清再删列（本迁移不猜）', bad;
  END IF;
  RAISE NOTICE '① 预检通过：每一篇的 note.tags 都能从 note_tag 逐字重算';
END $$;

-- ② 删列。`IF EXISTS` 让重跑成为 no-op（第二次跑只印一行 NOTICE）。
--    ⚠️ 索引 / 外键不用管：这一列上两样都没有（`note` 的 12 条外键与 45 个索引里
--    没有任何一条引用它，`verify_parity.py` 的两条集合 diff 因此不受影响）。
ALTER TABLE "note" DROP COLUMN IF EXISTS "tags";

-- 跑完自查（**人工**跑一次）：
--
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'note' AND column_name = 'tags';        -- 期望 0
--   SELECT count(*) FROM "note_tag";                            -- 期望 18（产线实测）
--   python3 scripts/migration/pg/verify_parity.py               -- 期望仍绿（靠那条单列豁免）
