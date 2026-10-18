-- 删掉 4 张**不属于业务库**的 langgraph checkpoint 表（20261018）。
--
-- 跑法（**以应用角色跑**；理由见 `0003_chat_image.sql` 末节）：
--   psql -h 127.0.0.1 -U saudade_app -d saudade_blog -X -v ON_ERROR_STOP=1 -f - < 本文件
-- 幂等（第二次跑是四条 no-op）。**但跑之前必须先看清下面那条预检的读数。**
--
-- ── 这四张表是怎么来的 ─────────────────────────────────────────────────────
-- `agent/checkpoint.py::build_checkpointer()` 在 agent **启动期**开池并 `saver.setup()`
-- 建表，而它建在 **DSN 指向的那个库**里（`PostgresSaver` 只认 DSN，不认"这是不是业务库"）。
-- 某次把 `CHECKPOINT_DSN` 指到了业务库 `saudade_blog` 起了一次 agent ⇒ 表就落这儿了。
-- 现在 agent `.env` 里那一行是**注释掉的**，所以它们既没人读也没人写。
--
-- ── 为什么"删"是对的，而不只是"眼不见" ─────────────────────────────────────
-- checkpoint 的正经落脚点是 **`agent_checkpoint` 那个库**（角色 `agent_ckpt`；
-- `checkpoints` / `agent_write_idem` / `agent_write_replay` 都已经在那边）。
-- 要真开这一档，`CHECKPOINT_DSN` 指**那边**。
--
-- 留在业务库的代价不是"多几张表"：**第三方库会按自己的节奏在业务库里改结构**，
-- 而这些改动**不经过任何编号迁移** —— 也就是说业务库的 schema 会在没人记账的情况下变化。
-- 现成的读数就是 `verify_parity.py`：它比的是"MySQL 目录 vs PG 目录"，这四张表让它红，
-- 而红在一个与业务数据无关的事实上（判据一旦有恒红项，真红就没人看了）。
--
-- ⚠️ 这**不是**一扇单向门：哪天又把 DSN 指回业务库，`setup()` 会**幂等地重新建**它们。
-- 所以本文件治的是"现在这几张残留 + 那次误配的痕迹"，不是"让业务库永远建不出这些表"。
--
-- ── ① 预检：三张数据表必须为空 ─────────────────────────────────────────────
-- 实测（20261018）：`checkpoints` / `checkpoint_writes` / `checkpoint_blobs` **全 0 行**，
-- 只有 `checkpoint_migrations` 那 6 行 —— 那是 langgraph 自己的 schema 版本账，
-- 随表一起删（它记的是"这套表建到第几版"，不是业务数据）。
--
-- **有数据就停下来**：那说明真有一轮对话的状态存在这里，删之前得先弄清它是不是还被谁读着。
-- 下面那个 DO 块就是这条纪律的可执行版本 —— 它**拒跑**，而不是印一行提示让你自己看着办。
--
-- ⚠️ 四条 `to_regclass` 判空：`EXECUTE 'SELECT count(*) FROM checkpoints'` 在表不存在时
-- 会直接报错（而不是回 0），而"表不存在"是完全正常的状态（在别的库上重放本文件时）。

-- ① 预检（拒跑式）。
DO $$
DECLARE
  n_total bigint := 0;
  n_one   bigint;
BEGIN
  IF to_regclass('public.checkpoints') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM checkpoints' INTO n_one;
    n_total := n_total + n_one;
    IF n_one > 0 THEN RAISE NOTICE 'checkpoints: % 行', n_one; END IF;
  END IF;
  IF to_regclass('public.checkpoint_writes') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM checkpoint_writes' INTO n_one;
    n_total := n_total + n_one;
    IF n_one > 0 THEN RAISE NOTICE 'checkpoint_writes: % 行', n_one; END IF;
  END IF;
  IF to_regclass('public.checkpoint_blobs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM checkpoint_blobs' INTO n_one;
    n_total := n_total + n_one;
    IF n_one > 0 THEN RAISE NOTICE 'checkpoint_blobs: % 行', n_one; END IF;
  END IF;

  IF n_total > 0 THEN
    RAISE EXCEPTION
      'checkpoint 表里还有 % 行数据，拒绝删。先弄清这轮状态还有没有读方（agent .env 里的 '
      'CHECKPOINT_DSN 是不是又指回业务库了），再决定是清数据还是改 DSN。',
      n_total;
  END IF;
  RAISE NOTICE '预检通过：三张数据表都是空的，可以删';
END $$;

-- ② 删。顺序 = 依赖顺序（`checkpoint_writes` / `checkpoint_blobs` 引用 `checkpoints`，
--    虽然这里没建外键，但按依赖序删在读起来时不至于让人以为漏了什么）。
DROP TABLE IF EXISTS "checkpoint_writes";
DROP TABLE IF EXISTS "checkpoint_blobs";
DROP TABLE IF EXISTS "checkpoints";
DROP TABLE IF EXISTS "checkpoint_migrations";

-- ③ 自查：四张表都该查不到了。
DO $$
DECLARE
  left_over text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO left_over
    FROM unnest(ARRAY['checkpoints', 'checkpoint_writes', 'checkpoint_blobs',
                      'checkpoint_migrations']) AS t
   WHERE to_regclass('public.' || t) IS NOT NULL;
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION '还有没删掉的：%', left_over;
  END IF;
  RAISE NOTICE '自查通过：四张 checkpoint 表都不在了';
END $$;

-- 跑完顺手核一遍（不属于本文件，供人眼确认；`verify_parity.py` 那一条才是判据）：
--   python3 scripts/migration/pg/verify_parity.py      # 期望 0 处对不上
