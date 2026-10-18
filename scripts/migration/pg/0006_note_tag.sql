-- `note.tags` 归一成关联表 `note_tag`（20261018）—— Stage 3 的 **expand** 那一半。
--
-- 跑法（**以应用角色跑**，不是 `sudo -u postgres`；理由见 `0003_chat_image.sql` 末节）：
--   psql -h 127.0.0.1 -U saudade_app -d saudade_blog -X -v ON_ERROR_STOP=1 -f - < 本文件
-- 可反复跑（建表 `IF NOT EXISTS`；回填按"这一篇还没有关联行"判）。**跑之前先跑①的预检。**
--
-- ⚠️ **顺序：本文件必须在"切到关联表的那笔代码部署之前"跑完。** 反过来的话，新代码一上线
-- 到本文件跑完之间 `note_tag` 还不存在 ⇒ 每一篇文章的标签在页面上集体消失，而且是静默的
-- （`load_note_tags` 读不到只写一行 WARN、不报错）。先跑本文件则那个窗口是空的 ——
-- 新代码上线时关联表已经填好了，旧代码那一段照旧只写 `note.tags`（两边不冲突）。
-- 那一段反过来有个小代价（旧代码改了标签而关联行停在旧值），检查与修法见末尾自查 d)。
--
-- ── 治的是什么 ─────────────────────────────────────────────────────────────
-- `note.tags` 是一列**逗号分隔的标签 id 字符串**（`text`），没有外键、没有类型、没有顺序
-- 保证。它同时承担三件事：① 这一篇挂了哪些标签；② 那些标签**各自是哪一级**（靠去两张表
-- 挨个查 id 猜）；③ 展示顺序（前端 `renderNoteTags` 按存储顺序渲染）。
--
-- 三个后果，都是**静默**的：
--   · **撞号**：`tag_one.id` 与 `tag_two.id` 是两条独立自增序列（今天 `tag_one` 有
--     {10,11,13,14,15,43,44,45,46,47}、`tag_two` 有 {5,6,7,8,19,10006,10007,10008}），
--     一个 id 在两张表都存在时，**没有第三个字段能说明它指的是哪一个** —— 后端取二级、
--     前端取一级，两边对同一篇给出不同的标签名（③c 只把两边对齐到"一级优先"，是治症状）。
--   · **悬空**：标签删了，`note.tags` 里的 id 还在（`prune_note_tags` 靠"每删一次标签就
--     扫全表"来擦，是**尽力而为**，不是不变量）。
--   · **顺序靠运气**：今天 11 篇带标签的串恰好升序，那是历史巧合，不是语义。
--
-- 关联表让这三件事**结构性消失**：一行自己知道指向哪张表（`tag_one_id` XOR `tag_two_id`）、
-- 外键让悬空行跟着父行一起走、`seq` 让顺序成为被存储的事实。
--
-- ── 线格式**逐字不变**（本 Stage 的关键取舍）──────────────────────────────────
-- `noteTags` 对外的形状仍然是**逗号分隔的 id 串**，只是内容改由 join 表重建
-- （`routes/note_tags.rs::load_note_tags` / `attach_tags`）。
-- ⇒ **agent 仓零改动、前端零改动**，`tests/test_note_tags_codec.py` 继续绿。
-- 本文件**不删列**：`note.tags` 留着当回滚保险，代码那一半同时写两处（见下），
-- 跑几天 soak 之后再由 `0007_drop_note_tags_column.sql` 摘掉。**先 expand、后 contract。**
--
-- ── 为什么 `seq` 必须在 ────────────────────────────────────────────────────
-- 前端 `utils/noteTags.ts::joinNoteTags` 保序、`renderNoteTags` 按存储顺序渲染 `<Tag>`。
-- 只存一个 id 集合（比如 `PRIMARY KEY (note_id, tag_id)`）就丢掉了顺序，而那正是今天的
-- 存储里**唯一**承载顺序的地方。
--
-- ── 两个被否掉的备选（写下来免得下次再想一遍）────────────────────────────────
--   · **单列 + 偏移量区分层级**（一级存原 id、二级存 id + 10000）：`tag_two` 里
--     **仍有 5/6/7/8/19 < 10000**，偏移量不是干净的分界 ⇒ 要用它就得**改真实 id**，
--     而 id 被 `noteTags` / `$tool[N].noteTags` / `build_word_graph.py` 逐字搬着。
--   · **单列 + discriminator 列**：外键不能带条件 ⇒ 丢掉 DB 级完整性，而那正是这件事的
--     全部意义（"这一行指向哪张表"必须由库来保证，不能靠应用层记得）。
--
-- ── 索引名：PG 是 schema 级全局唯一（见 `0003_chat_image.sql` 末节）────────────
-- 本文件的五个名字与现存 46 个都不同，不会撞。

-- ① 预检（**先跑这一条，人眼过一遍**）：
--
--    SELECT x.id, o.cnt AS in_one, w.cnt AS in_two
--      FROM (SELECT DISTINCT substring(t.piece FROM '^\s*([0-9]+)\s*$')::bigint AS id
--              FROM "note" n, unnest(string_to_array(coalesce(n."tags", ''), ',')) AS t(piece)
--             WHERE n."tags" IS NOT NULL AND n."tags" <> '') x
--      LEFT JOIN (SELECT "id", count(*) cnt FROM "tag_one" GROUP BY "id") o ON o."id" = x.id
--      LEFT JOIN (SELECT "id", count(*) cnt FROM "tag_two" GROUP BY "id") w ON w.id = x.id
--     WHERE x.id IS NOT NULL AND x.id BETWEEN 1 AND 2147483647
--       AND coalesce(o.cnt, 0) + coalesce(w.cnt, 0) <> 1
--     ORDER BY 1;
--
--    期望：**0 行**（产线实测就是 0 行）。列出来的每一行都要人裁决：
--      · 都查不到（悬空）—— 它本来就渲染成一个空白标签块，丢掉是安全的，但**丢数据要人点头**；
--      · 都查到（撞号）—— 必须人指定归哪一级，**本迁移绝不猜**（猜错就是把一篇的标签挂到
--        另一个同号标签上，而且不会有任何东西报错）。
--    解析口径 = `substring(… FROM '^\s*([0-9]+)\s*$')`：**只认 ASCII 数字**、两侧空白，
--    与 `routes/note_tags.rs::parse_tag_ids`、前端 `utils/noteTags.ts::toTagId`、
--    agent `adminops_tags.py::parse_tag_ids` 是同一套（`\d` 在 Python 里认全角数字，
--    这一族刻意不学，见 `tests/test_note_tags_codec.py` ④）。
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
--    · `tag_one_id` / `tag_two_id` → 标签：删标签，关联行跟着走 —— 这正是
--      `tags.rs::prune_note_tags`（每删一次标签就扫全表 + 逐行重写 `note.tags`）**整个退休**
--      的原因。它是本 Stage 删掉的第二处全表读放大。
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
