DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM (SELECT DISTINCT substring(t.piece FROM '^\s*([0-9]+)\s*$')::bigint AS id
            FROM "note" n, unnest(string_to_array(coalesce(n."tags", ''), ',')) AS t(piece)
           WHERE n."tags" IS NOT NULL AND n."tags" <> '') x
   WHERE x.id IS NOT NULL AND x.id BETWEEN 1 AND 2147483647
     AND (SELECT count(*) FROM "tag_one" o WHERE o."id" = x.id)
       + (SELECT count(*) FROM "tag_two" w WHERE w."id" = x.id) <> 1;
  IF bad > 0 THEN
    RAISE EXCEPTION
      '有 % 个标签 id 在 tag_one/tag_two 里命中数 <> 1（都查不到 = 悬空、都查到 = 撞号）——'
      '本迁移不猜，先按①那条查询列出来人工裁决', bad;
  END IF;
  RAISE NOTICE '① 预检通过：每个 id 恰好命中一张表';
END $$;

-- 外键级联清理文章和标签关联；每行恰好引用一个层级的标签。
CREATE TABLE IF NOT EXISTS "note_tag" (
  "note_id"    integer  NOT NULL,
  "seq"        smallint NOT NULL,
  "tag_one_id" integer,
  "tag_two_id" integer,
  CONSTRAINT "note_tag_pkey" PRIMARY KEY ("note_id", "seq"),
  CONSTRAINT "note_tag_one_xor_two" CHECK (num_nonnulls("tag_one_id", "tag_two_id") = 1),
  CONSTRAINT "note_tag_note_fk" FOREIGN KEY ("note_id")    REFERENCES "note"("id")     ON DELETE CASCADE,
  CONSTRAINT "note_tag_one_fk"  FOREIGN KEY ("tag_one_id") REFERENCES "tag_one"("id")  ON DELETE CASCADE,
  CONSTRAINT "note_tag_two_fk"  FOREIGN KEY ("tag_two_id") REFERENCES "tag_two"("id")  ON DELETE CASCADE
);

-- 部分唯一索引分别约束两级标签，禁止同篇重复关联。
CREATE UNIQUE INDEX IF NOT EXISTS "note_tag_uk_note_one"
  ON "note_tag" ("note_id", "tag_one_id") WHERE "tag_one_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "note_tag_uk_note_two"
  ON "note_tag" ("note_id", "tag_two_id") WHERE "tag_two_id" IS NOT NULL;

-- 反查"哪些文章挂了这个标签"（移动标签时的影响面统计、以及未来的按标签筛文章）。
-- PK 的前导列是 `note_id`，反方向要单独建。
CREATE INDEX IF NOT EXISTS "note_tag_idx_one" ON "note_tag" ("tag_one_id");
CREATE INDEX IF NOT EXISTS "note_tag_idx_two" ON "note_tag" ("tag_two_id");

-- 按原串首次出现的位置保序去重，seq 从 0 开始；不按标签 id 排序。
-- 预检保证每个编号只属于一张标签表，仅为尚无关联的文章回填。
DO $$
DECLARE n int;
BEGIN
  INSERT INTO "note_tag" ("note_id", "seq", "tag_one_id", "tag_two_id")
  SELECT s."note_id", s."seq",
         CASE WHEN o."id" IS NOT NULL THEN s."tag_id" END,
         CASE WHEN o."id" IS NULL AND w."id" IS NOT NULL THEN s."tag_id" END
    FROM (SELECT f."note_id", f."tag_id",
                 (row_number() OVER (PARTITION BY f."note_id" ORDER BY f."first_ord") - 1)::smallint AS "seq"
            FROM (SELECT p."note_id", p."tag_id", min(p."ord") AS "first_ord"
                    FROM (SELECT n."id" AS "note_id", t."ord",
                                 substring(t."piece" FROM '^\s*([0-9]+)\s*$')::bigint AS "tag_id"
                            FROM "note" n,
                                 unnest(string_to_array(coalesce(n."tags", ''), ','))
                                   WITH ORDINALITY AS t("piece", "ord")
                           WHERE n."tags" IS NOT NULL AND n."tags" <> '') p
                   WHERE p."tag_id" IS NOT NULL AND p."tag_id" BETWEEN 1 AND 2147483647
                   GROUP BY p."note_id", p."tag_id") f) s
    LEFT JOIN "tag_one" o ON o."id" = s."tag_id"
    LEFT JOIN "tag_two" w ON w."id" = s."tag_id"
   WHERE (o."id" IS NOT NULL OR w."id" IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM "note_tag" nt WHERE nt."note_id" = s."note_id");
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '③ 回填了 % 行 note_tag', n;
END $$;

-- 回填须在应用写入 note_tag 前完成；已有关联不会被重跑覆盖。
-- 切换写入路径期间停止标签修改，并核对 note.tags 与按 seq 重建的编号串一致。
-- 0007 删除原列前会再次执行一致性预检；发现差异时先定位写入路径。
