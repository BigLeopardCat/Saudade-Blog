-- 文章可见性收敛：同义词合并 + 不变量约束（20261018）。
--
-- 跑法（**以应用角色跑**，不是 `sudo -u postgres`；理由见 `0003_chat_image.sql` 末节）：
--   psql -h 127.0.0.1 -U saudade_app -d saudade_blog -X -v ON_ERROR_STOP=1 -f - < 本文件
-- 可反复跑（每条都幂等）。**但跑之前必须先跑下面①的预检，并人眼过一遍。**
--
-- ── 治的是什么 ─────────────────────────────────────────────────────────────
-- `note` 用**两个字段**描述"这篇能不能被读到"：`is_public boolean` + `status varchar(50)`。
-- 而公开侧的守卫一直是**黑名单**（`status <> 'draft'`），不是白名单 —— 于是：
--   · 任何**没见过的** status 词都不在排除名单里 ⇒ **漏过去**（照旧公开）；
--   · `update_note` 那条只带 `{"is_public":true}` 的写会把 `is_public` 置回 true 而
--     `status` 一个字节不动 ⇒ 库里落下 `('private', true)` 这种行，而它**会被公开列出**。
-- 应用侧那一半（谓词翻成白名单 + 写侧只认三个词、未知词拒收）在**代码里**，见
-- `src/routes/notes.rs::public_status_words` / `normalize_status_word`。
-- 本文件是**数据收敛 + 最后一道结构性防线**：库自己不再允许那种组合存在。
--
-- ⚠️ **代码必须先上线，再跑本文件**。反过来做的话，CHECK 落地那一刻，旧二进制那条
-- `{"is_public":true}` 的路会直接 500。CI 不跑本文件（`deploy.yml` 只在 CI 的一次性容器里
-- 建结构），生产上是**手工**跑 —— 顺序由人控制，别把这个前提忘了。
--
-- ── 同义词：`published` → `public` ──────────────────────────────────────────
-- 库里 `public` 与 `published` 是同一个意思（后者是 `0000_schema.sql` 里 `status` 的列缺省）。
-- 本次把**数据**收敛到 `public` 一个词；`published` 作为**兼容别名**保留在约束里，因为：
--   · 列缺省就是它（`0000_schema.sql`：`"status" varchar(50) DEFAULT 'published'`）；
--   · 集成测夹具（`tests/pg_integration.rs::make_note` 等）不带 status 就 INSERT。
-- 写侧（Rust）把 `published` 一律归一成 `public` 再落库 ⇒ 库里最终只有一个"公开"词。
--
-- ── 为什么 CHECK 里写 `status IS NOT NULL`，而不是 `ALTER COLUMN … SET NOT NULL` ──
-- 后者会改列元数据，而 `scripts/migration/pg/verify_parity.py` 会**逐列比对可空性与缺省值**
-- （它是拿 `0000` 那份从 MySQL 生成的产物对账的）⇒ 那条判据会红在一个正确的改动上。
-- CHECK 里的 `IS NOT NULL` **真的会拒 NULL**（求值是 FALSE 而不是 UNKNOWN，与裸的
-- `status IN (…)` 不同），不变量一样拿得到，而 parity 那条看不见 CHECK
-- （它只读 `contype IN ('p','f')`）⇒ 两全。
--
-- ── 为什么不加索引 ──────────────────────────────────────────────────────────
-- 21 行不需要；且新增索引会让 parity 的**索引集合** diff 红（`note` 不在它的
-- `HAND_WRITTEN` 豁免里，而 MySQL 侧没有这个索引）。

-- ① 预检：NULL 词 / 未知词。**本迁移不猜**——这两种要人裁决该归到哪一档，
--    猜错了就是把一篇不该公开的文章公开了。今天生产上两种都是 0 行。
DO $$
DECLARE n_null int; n_unknown int;
BEGIN
  SELECT count(*) INTO n_null FROM "note" WHERE "status" IS NULL;
  SELECT count(*) INTO n_unknown FROM "note"
    WHERE "status" IS NOT NULL
      AND "status" NOT IN ('public','published','private','draft');
  IF n_null > 0 OR n_unknown > 0 THEN
    RAISE EXCEPTION
      'note.status 有 % 行 NULL、% 行未知词 —— 先人工决定它们归哪一档再跑本迁移（本迁移不猜）。预检查询见本文件 ② 上方注释',
      n_null, n_unknown;
  END IF;
  RAISE NOTICE '① 预检通过：status 无 NULL、无未知词';
END $$;

-- ② 收敛矛盾行：`is_public = true` 而状态词是 private/draft。
--    **可见性不变**：翻成白名单之后，这两种词本来就不在公开集合里，置 false 只是把
--    这个字段改成与事实一致。这些行今天在生产上是 0 行（要改之前那条 `{"is_public":true}`
--    的路造出来），所以这一条是**给存量兜底**，不是常规路径。
DO $$
DECLARE n int;
BEGIN
  UPDATE "note" SET "is_public" = false
    WHERE "is_public" = true AND "status" IN ('private','draft');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE '② 收敛了 % 行「私密/草稿却 is_public=true」（可见性不变，只是字段与事实对齐）', n;
  ELSE
    RAISE NOTICE '② 没有矛盾行';
  END IF;
END $$;

-- ③ 同义词合并：`published` → `public`。幂等（第二次跑影响 0 行）。
DO $$
DECLARE n int;
BEGIN
  UPDATE "note" SET "status" = 'public' WHERE "status" = 'published';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '③ published → public：改了 % 行', n;
END $$;

-- ④ 不变量。三条合起来说的是：
--    · 状态词必须在场（`IS NOT NULL` 在 CHECK 里是真的会拒的）；
--    · 状态词必须在词表里（不许有没见过的词）；
--    · **公开可见 ⇒ 状态词是公开那一档**（`is_public = false` 的行不受这条约束，
--      所以 `('published', false)` / `('public', false)` 这种"显式隐藏"照样合法）。
--    约束名按表限定，避免与别处的同名约束混淆。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'note_status_visibility_ck' AND conrelid = 'note'::regclass
  ) THEN
    ALTER TABLE "note" ADD CONSTRAINT "note_status_visibility_ck" CHECK (
      "status" IS NOT NULL
      AND "status" IN ('public','published','private','draft')
      AND ("is_public" = false OR "status" IN ('public','published'))
    );
    RAISE NOTICE '④ 已加约束 note_status_visibility_ck';
  ELSE
    RAISE NOTICE '④ 约束 note_status_visibility_ck 已在（幂等）';
  END IF;
END $$;

-- 跑完自查（**人工**跑一次，不是自动化判据——本文件在 CI 里按构造是空真的：CI 的库是
-- 从 `0000` + 清单现建的，那里面本来就没有违规行，DELETE/UPDATE 全是 no-op）：
--
--   SELECT status, is_public, count(*) FROM note GROUP BY 1,2 ORDER BY 1,2;
--     -- 期望：public/true 12、private/false 4、draft/false 4；**没有 published 那一行**
--   SELECT conname FROM pg_constraint WHERE conrelid='note'::regclass AND contype='c';
--     -- 期望：note_status_visibility_ck
--   INSERT INTO note (title, content, created_at, updated_at, is_public, status)
--     VALUES ('负控', 'x', NOW(), NOW(), true, 'private');  -- 期望：报错（约束拒绝）
