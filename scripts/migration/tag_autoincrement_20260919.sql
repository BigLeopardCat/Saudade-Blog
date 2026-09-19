USE memory_blog;
-- 20260919 标签两级 id 隔离：把 tag_two 的自增起点抬到 10000。
--
-- 背景：tag_one 与 tag_two 是两张独立表、**各自自增**，而前端的选择器/列表把它们
--   混在一个 id 空间里用（`note.tags` 存的就是裸 id 串，两级都可引用）。删标签的老接口
--   还收一个 id 数组然后**同时去两张表删**——两级 id 一旦撞号，删一级 #13 会连带删掉
--   二级 #13（受影响的文章标签被 FK/代码连锁清掉）。20260919 已把删除接口改成带 level
--   只删指定表，这里再把"新分配的 id 永不相交"变成数据层事实。
-- 现状（执行前实测）：tag_one id = 10,11,13,14（AUTO_INCREMENT=15）；
--   tag_two id = 5,6,7,8（AUTO_INCREMENT=**9**）—— 下一个二级标签就是 9，
--   再往下 10/11/13/14 会逐**撞上**现有的一级标签。
--
-- 纯 DDL、零数据改写：只改"下一个自动分配值"，存量行（含 note.tags 里的引用）一个字节不动。
-- MySQL 8.0 起 AUTO_INCREMENT 跨重启持久化（8.0 之前重启会回落成 max(id)+1，那才是坑）。
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
