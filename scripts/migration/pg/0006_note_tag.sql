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

-- ② 建表。三个外键都是 `ON DELETE CASCADE`：
--    · `note_id` → `note`：删文章，关联行跟着走（`delete_note` 一行都不用改）；
--    · `tag_one_id` / `tag_two_id` → 标签：删标签，关联行跟着走 —— 因此不再需要
--      `tags.rs::prune_note_tags`（每删一次标签就扫全表 + 逐行重写 `note.tags`）。
--    `num_nonnulls(...) = 1` 是"这一行**恰好**指向一张表"的判据：两个都填或都不填都是错的。
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

-- 同一个标签在同一篇里只能出现一次（`note.tags` 有历史数据把同一个 id 写两遍）。
-- 用**部分唯一索引**而不是把 tag_id 拉出来做主键的一部分：列是两列、只能各管各的。
CREATE UNIQUE INDEX IF NOT EXISTS "note_tag_uk_note_one"
  ON "note_tag" ("note_id", "tag_one_id") WHERE "tag_one_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "note_tag_uk_note_two"
  ON "note_tag" ("note_id", "tag_two_id") WHERE "tag_two_id" IS NOT NULL;

-- 反查"哪些文章挂了这个标签"（移动标签时的影响面统计、以及未来的按标签筛文章）。
-- PK 的前导列是 `note_id`，反方向要单独建。
CREATE INDEX IF NOT EXISTS "note_tag_idx_one" ON "note_tag" ("tag_one_id");
CREATE INDEX IF NOT EXISTS "note_tag_idx_two" ON "note_tag" ("tag_two_id");

-- ③ 回填。三件事：
--    · `WITH ORDINALITY` 拿到每一片在原串里的位置 ⇒ 去重时取**首次出现**（与
--      `parse_tag_ids` 的"保序去重"逐字同义），`row_number()` 落 `seq`（从 0 起）；
--    · 两级归属用 `LEFT JOIN` 判（预检已经保证恰好命中一张表）；
--    · `NOT EXISTS (... note_id ...)` 让重跑成为 no-op（这一篇已经有关联行了就不动它）。
--    ⚠️ 顺序**只由原串决定**，不看 `tag_one`/`tag_two` 的 id 大小 —— "今天恰好升序"是
--    运气，把它当规则写进回填就是给未来的数据埋一个错顺序。
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

-- 跑完自查（**人工**跑一次；本文件在 CI 里按构造接近空真 —— CI 的库是现建的，
-- 里面本来就没有带标签的文章，回填 0 行）：
--
--   -- a) 关联行数与"解析后的 id 数"逐篇相等（往返判据的静态版）
--   SELECT n.id,
--          (SELECT count(DISTINCT substring(t.piece FROM '^\s*([0-9]+)\s*$'))
--             FROM unnest(string_to_array(coalesce(n.tags,''), ',')) AS t(piece)
--            WHERE substring(t.piece FROM '^\s*([0-9]+)\s*$') IS NOT NULL) AS want,
--          (SELECT count(*) FROM "note_tag" nt WHERE nt.note_id = n.id) AS got
--     FROM "note" n WHERE n.tags IS NOT NULL AND n.tags <> ''
--    HAVING (SELECT count(DISTINCT substring(t.piece FROM '^\s*([0-9]+)\s*$'))
--              FROM unnest(string_to_array(coalesce(n.tags,''), ',')) AS t(piece)
--             WHERE substring(t.piece FROM '^\s*([0-9]+)\s*$') IS NOT NULL)
--         <> (SELECT count(*) FROM "note_tag" nt WHERE nt.note_id = n.id);
--     -- 期望 0 行
--
--   -- b) 两级各挂了多少行（人眼看一眼数量级对不对）
--   SELECT count(*) FILTER (WHERE tag_one_id IS NOT NULL) AS 一级,
--          count(*) FILTER (WHERE tag_two_id IS NOT NULL) AS 二级 FROM "note_tag";
--
--   -- c) 负控：这条必须**被拒**（`num_nonnulls = 1`）
--   INSERT INTO "note_tag" (note_id, seq, tag_one_id, tag_two_id)
--     VALUES (1, 9999, 10, 10);   -- 期望：note_tag_one_xor_two 违规
--
--   -- d) ⚠️ **本文件跑完、新代码还没上线**那一段窗口的漂移检查（本文件刻意安排在部署**之前**跑：
--   --    反过来的话，新代码一上线到本文件跑完之间，`note_tag` 还不存在 ⇒ 所有文章的标签
--   --    在页面上集体消失，而且是**静默**的（`load_note_tags` 读不到只 WARN）。
--   --    先跑本文件则那个窗口是空的：新代码上线时关联表已经填好了。）
--   --    代价是反过来的一小段：这一段里**旧代码**仍在写 `note.tags` 那一列，若恰好有人改了
--   --    某篇文章的标签，那一篇的关联行会停在旧值上（本文件的回填按"这一篇还没有关联行"判，
--   --    重跑不会修它）。列出来看一眼（期望 0 行）：
--   SELECT n.id, n.tags,
--          (SELECT string_agg(coalesce(tag_one_id, tag_two_id)::text, ',' ORDER BY seq)
--             FROM "note_tag" nt WHERE nt.note_id = n.id) AS 关联表算出来的
--     FROM "note" n
--    WHERE coalesce(n.tags, '') <> coalesce(
--            (SELECT string_agg(coalesce(tag_one_id, tag_two_id)::text, ',' ORDER BY seq)
--               FROM "note_tag" nt WHERE nt.note_id = n.id), '');
--   --    有行 ⇒ 按那一篇重建关联行（**先删后填**；这就是把回填对那一篇重跑一遍）：
--   --    DELETE FROM "note_tag" WHERE note_id = <那一篇的 id>;
--   --    再跑一遍本文件（它只对"没有关联行"的篇动手 ⇒ 只会补上刚删掉的那一篇）。
--   --    ⚠️ 别在**新代码已经上线之后**做这件事：那时 `note.tags` 与关联表由同一个事务写、
--   --    本来就不会漂；真漂了说明有别的写路径绕过了 `replace_note_tags`，那是要查的 bug，
--   --    不是要擦的数据（`0007` 的预检就是为这件事存在的）。
