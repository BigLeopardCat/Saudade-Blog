ALTER TABLE "password_reset_token"
  ALTER COLUMN "token_hash" TYPE varchar(255);

-- 跑完自查（**人工**跑一次）：
--
--   SELECT character_maximum_length FROM information_schema.columns
--    WHERE table_name = 'password_reset_token' AND column_name = 'token_hash';   -- 期望 255
--   SELECT count(*), min(length("token_hash")), max(length("token_hash"))
--     FROM "password_reset_token";        -- 期望：老行一律 64（一个新码都还没签过）
--   python3 scripts/migration/pg/ci_schema_files.py --self-test                     -- 期望 ✅
