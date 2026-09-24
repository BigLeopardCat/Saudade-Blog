USE memory_blog;
-- =============================================================================
-- 20260925 golden 真写用例夹具：分类 `agent_fixture_category_a`
--
-- 这是**第一个会真写生产库的评测用例**（`golden_write_category_delete_exec`）要删的
-- 那一行。此前的 11 条确认类用例全部只到"弹了卡 + 零写"：它们靠 agent 侧 uid=0 的
-- 哨兵兜住（`tools/base.py` 里 `_device_get_user_id() <= 0` ⇒ 一个请求都不发），
-- 结构上走不到执行。要覆盖"点了确定之后**真的执行**"这条路径，就必须给一个真身份
-- （uid=721，测试专用管理员账号，见 `test_accounts_20260924.sql`）和一个**真目标**。
--
-- ## 为什么夹具必须是"可以被删掉的东西"
--
-- 用例的正确行为是**把这个分类删掉**（删不掉就是红），所以它天然是"用一次少一次"的：
-- 跑之前在上位、跑完不在位。这不是缺陷，是本文件与用例之间的分工——
--     本文件负责"让它在上位"（幂等，可反复跑），用例负责"把它删掉"。
-- ⇒ **flag 不参与幂等判断**（见 §⑤ 的注释）：若让 "已 applied 就跳过 INSERT"，
--    那么"用例删掉之后想再跑一次"这条正常循环会静默什么都不做，而用例会红成
--    "站内没有叫 X 的分类"——一个看起来像模型退化、其实是文件逻辑导致的红。
--
-- ## 为什么名字必须带保留前缀 `agent_fixture_`
--
-- 清场、排查、任何手工兜底都可以写成 `... WHERE name LIKE 'agent_fixture_%'`——
-- **结构上不可能误删真数据**。这是一次真写"只许碰夹具、碰不到别人的东西"唯一
-- 可证明的形态（断言是事后的，前缀是事前的）。前缀与测试账号的 `agent_test_` 同族。
--
-- ⚠️ 夹具在位期间它**在站上是可见的**（`/api/public/category` 是公开接口，分类页
-- 也读它）——名字一眼认得出是夹具，且用例跑完即消失。别把它当"隐形测试数据"。
--
-- ## 为什么**不指定 id**
--
-- 让 AUTO_INCREMENT 自己分配。参照 `tag_autoincrement_20260919.sql` 立的不变量
-- （tag_one id < 10000 ≤ tag_two id）：显式写一个高 id 会把它**永久抬上去**，
-- 那是给后来人埋的一颗"为什么新分类 id 从 9xxxx 开始"的雷。夹具不需要 id 稳定
-- ——用例全程按**名字**找它（`delete_category` 就是名字通道）。
--
-- ## 与用例侧的约定（改这里要同步改那边）
--
--   · 名字逐字：`agent_fixture_category_a`
--     （`eval/golden/basic.jsonl` 的 `golden_write_category_delete_exec`：
--      `requires_fixture` 声明本条、第 2 轮 `require_exec_args` 逐字锁参数）
--   · 不在位 ⇒ 用例**响亮 SKIP**（`[skip] ... 夹具不在位`，计入 skipped_ids 分母）
--     ——不静默豁免，也不"没夹具就照跑"（那会红成一个误导性的"站内没有此分类"）。
--   · 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
--
-- ── ① 现状核对（先看，再决定要不要插）──────────────────────────────────────
-- 期望：`rows` 为 0（第一次跑）或 1（用例没删掉/重复跑过）。`total_categories`
-- 与 `next_id` 只是让落地这一刻的库现状留在执行记录里（不是判据）。
SELECT 'state' AS done,
       (SELECT COUNT(*) FROM category WHERE name = 'agent_fixture_category_a') AS rows_now,
       (SELECT COUNT(*) FROM category) AS total_categories;

-- 前缀族的完整清单：**这份清单里的每一行都是夹具**，不含任何真分类。
-- 有意外的东西（名字像夹具却不是本文件建的）时，先查清楚再往下走。
SELECT 'prefix_family' AS done, id, name, path_name FROM category
 WHERE name LIKE 'agent\_fixture\_%';

-- ── ② 幂等插入（重复跑是空操作）────────────────────────────────────────────
-- 判据只有"这个名字的行在不在"，**不看 flag**（理由见文件头）。不指定 id；
-- 不写 icon/color（留 NULL = 没设过，与 `create_category` 的用户习惯一致）。
-- **没有任何 `ON DUPLICATE KEY` / `REPLACE`**（全仓一贯：静默改掉一行已有数据
-- 是比失败更坏的结果）。
INSERT INTO category (name, path_name, introduce)
SELECT 'agent_fixture_category_a', 'agent_fixture_category_a',
       '评测夹具（golden 真写用例的目标，用例跑完即删；见 golden_write_fixture_20260925.sql）'
 WHERE NOT EXISTS (SELECT 1 FROM category WHERE name = 'agent_fixture_category_a');

-- ── ③ 回读：确认**恰好一行**、字段如预期 ───────────────────────────────────
-- 期望：1 行，id 是自增分配的（不写死），icon/color 为 NULL。
-- 行数与名字是后面每一步的前提；这里读不出 1 行就不要继续。
SELECT 'fixture' AS done, id, name, path_name, introduce, icon, color,
       (SELECT COUNT(*) FROM category WHERE name = 'agent_fixture_category_a') AS must_be_1
  FROM category WHERE name = 'agent_fixture_category_a';

-- ── ④ 写后复核：这一行**真的能被公开接口看到** ─────────────────────────────
-- 用例第 1 轮的名通道要按名字把它解析出来（`agent/adminops.find_category` ←
-- `/api/category`，与下面的公开接口同一个 handler：`routes/mod.rs:110`），
-- 所以"在位"的定义就是**这个接口读得到它**。库里插进去了、接口读不到 ⇒ 用例
-- 仍会 SKIP，那种情况要先查为什么（缓存/路由），不要改用例去迁就。
-- （SQL 里读不到 HTTP，这一条用 curl 验：`curl -s https://saudade.site/api/public/category`
--   找 `agent_fixture_category_a`。eval 侧有机械检查：`python eval/golden_fixture.py --verify`。）

-- ── ⑤ 登记 flag（**不参与幂等**，只记"本文件被应用过至少一次"）──────────────
-- 与其它迁移文件同名同表；这里的语义偏"登记"而非"门"——真正的门是 §② 的
-- `NOT EXISTS` 与用例侧的夹具在位检查。
INSERT INTO migration_flags (flag_name)
SELECT 'golden_write_fixture_20260925'
 WHERE NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'golden_write_fixture_20260925');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_write_fixture_20260925';

-- ── 回滚（如需）：只删前缀族，**一条真数据都碰不到** ───────────────────────
-- DELETE FROM category WHERE name LIKE 'agent\_fixture\_%';
-- DELETE FROM migration_flags WHERE flag_name = 'golden_write_fixture_20260925';
-- 注意：删分类会让原本属于它的文章 category_id 置 NULL（FK ON DELETE SET NULL，
-- 文章还在、只是没有分类）。**夹具建出来时它名下一篇都没有**（新行，没有文章引用它），
-- 所以这条回滚对真数据零影响——除非有人在夹具在位期间把文章挂到了它名下，
-- 那就不该用这条回了（先查 `SELECT COUNT(*) FROM note WHERE category_id = <夹具 id>`）。
--
-- ── 已知副作用（先知道再落地）──────────────────────────────────────────────
--   · 夹具在位期间会出现在**公开**分类列表面向访客（见文件头 ⚠️）。
--   · `note.tags` 那类"引用即字符串"的问题这里不存在：分类走 category_id 外键。
--   · 用例失败中途留下残留（删不掉）时，下一次跑会**继续尝试删它**——那正是清场；
--     若想立刻清掉，跑 §回滚 那句前缀 DELETE 即可。
