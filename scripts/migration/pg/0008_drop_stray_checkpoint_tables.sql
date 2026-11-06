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
