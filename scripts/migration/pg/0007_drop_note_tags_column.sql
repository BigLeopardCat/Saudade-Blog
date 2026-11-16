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

-- 一致性预检通过后删除原列；IF EXISTS 允许重复执行。
ALTER TABLE "note" DROP COLUMN IF EXISTS "tags";

-- 迁移后确认 note.tags 不存在，note_tag 关联数量以迁移前备份为准。
