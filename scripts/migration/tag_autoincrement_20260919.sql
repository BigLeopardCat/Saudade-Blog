USE saudade_blog;
ALTER TABLE `tag_two` AUTO_INCREMENT = 10000;

-- 校验门：tag_two 的 AUTO_INCREMENT 必须 ≥ 10000，且与 tag_one 的值域（< 10000）不相交
SELECT 'auto_increment' AS done, TABLE_NAME, AUTO_INCREMENT
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('tag_one','tag_two')
ORDER BY TABLE_NAME;

-- 校验门：存量 id 不与新起点冲突
SELECT 'tag_two_max' AS done, MAX(id) AS max_id, COUNT(*) AS rows_cnt FROM tag_two;

INSERT INTO migration_flags (flag_name) VALUES ('tag_autoincrement_20260919');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'tag_autoincrement_20260919';
