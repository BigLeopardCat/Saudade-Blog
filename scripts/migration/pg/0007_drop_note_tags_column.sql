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
--   SELECT count(*) FROM "note_tag";                            -- 期望 18
--   python3 scripts/migration/pg/verify_parity.py               -- 期望仍绿（靠那条单列豁免）
