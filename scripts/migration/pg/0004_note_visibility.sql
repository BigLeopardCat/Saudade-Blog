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

-- 将私密和草稿文章的 is_public 收敛为 false，保持可见性不变。
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

-- 迁移后检查状态分布和约束；存量数量以目标数据库为准。
-- SELECT status, is_public, count(*) FROM note GROUP BY 1,2 ORDER BY 1,2;
-- SELECT conname FROM pg_constraint WHERE conrelid='note'::regclass AND contype='c';
