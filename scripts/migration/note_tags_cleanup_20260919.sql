USE memory_blog;
-- 20260919 清理 note.tags 里的悬空标签 id（**会改生产文章数据**，执行前先跑下面的预演 SELECT）。
--
-- 背景：`note.tags` 是逗号分隔的裸 id 串，没有外键、删除标签时也从不回写引用。于是删掉
--   一个标签后，引用它的文章还留着那个 id —— 后台列表上渲染成一排**空白标签小块**、
--   公开页卡片上同理（线上实测 23 篇里 12 篇有这种悬空 id：`12` 出现在 10 篇、`1` 出现在 2 篇，
--   而字典里只剩 tag_one 10/11/13/14 与 tag_two 5/6/7/8）。
--
-- 判据：一个 id 只要**既不在 tag_one 也不在 tag_two** 就是悬空，剔除；同时按数值升序去重
--   （旧数据里没有重复，但顺手把不变量立起来）。全被剔除的行写空串 `''`（=应用里"清空标签"
--   的写法，`joinNoteTags([])` 就产 `''`），而不是 NULL —— 前后端都按"空串/空值都算没有标签"处理
--   （`parseNoteTags`、`as_deref()`），写空串与用户手动清空后的状态一致。
--
-- 为什么不直接用 `UPDATE note ... JOIN (SELECT ... FROM note)`：MySQL 会报 ERROR 1093
--   （不能在子查询里读正在更新的表）。所以先落一张临时表算好变更集，再回写；临时表里**先**
--   打印出来给人看，最后才 UPDATE —— 审计线索留在执行输出里。
DROP TEMPORARY TABLE IF EXISTS `_tag_clean`;
CREATE TEMPORARY TABLE `_tag_clean` (
    `id`      int      NOT NULL PRIMARY KEY,
    `before_` text     NULL,
    `after_`  text     NOT NULL
) AS
SELECT n.`id`                                                                          AS `id`,
       n.`tags`                                                                        AS `before_`,
       IFNULL((SELECT GROUP_CONCAT(DISTINCT jt.v ORDER BY jt.v SEPARATOR ',')
               FROM JSON_TABLE(CONCAT('[', IFNULL(n.`tags`, ''), ']'),
                               '$[*]' COLUMNS (v INT PATH '$')) AS jt
               WHERE jt.v IN (SELECT `id` FROM `tag_one` UNION SELECT `id` FROM `tag_two`)),
              '')                                                                      AS `after_`
FROM `note` n
WHERE n.`tags` IS NOT NULL AND n.`tags` <> ''
  AND n.`tags` <> IFNULL((SELECT GROUP_CONCAT(DISTINCT jt.v ORDER BY jt.v SEPARATOR ',')
                          FROM JSON_TABLE(CONCAT('[', n.`tags`, ']'),
                                          '$[*]' COLUMNS (v INT PATH '$')) AS jt
                          WHERE jt.v IN (SELECT `id` FROM `tag_one` UNION SELECT `id` FROM `tag_two`)),
                         '');

-- 预演：将要变更的行（执行前应先看这一段）。预期：note 1/7/8/9/11/12/17/18/21/46
SELECT 'preview' AS stage, `id`, `before_` AS tags_before, `after_` AS tags_after
FROM `_tag_clean` ORDER BY `id`;

-- 回写
UPDATE `note` n JOIN `_tag_clean` c ON c.`id` = n.`id`
SET n.`tags` = c.`after_`;

-- 校验门 1：变更行数（临时表里的行数 = 实际被改的行数）
SELECT 'changed_rows' AS done, COUNT(*) AS cnt FROM `_tag_clean`;

-- 校验门 2：全部 `before_`/`after_` 的成对留痕
SELECT 'audit' AS done, `id`, `before_`, `after_` FROM `_tag_clean` ORDER BY `id`;

DROP TEMPORARY TABLE `_tag_clean`;

-- 校验门 3：**不该再有悬空 id**（此查询必须返回 0 行）
SELECT 'dangling_left' AS done, n.`id`, n.`tags`
FROM `note` n
WHERE n.`tags` IS NOT NULL AND n.`tags` <> ''
  AND EXISTS (
      SELECT 1 FROM JSON_TABLE(CONCAT('[', n.`tags`, ']'), '$[*]' COLUMNS (v INT PATH '$')) AS jt
      WHERE jt.v NOT IN (SELECT `id` FROM `tag_one` UNION SELECT `id` FROM `tag_two`)
  );

-- 校验门 4：清理后的标签分布（应与字典对得上：10 摄影 / 11 音乐 / 13 嵌入式 / 14 编程 / 5-8 二级）
SELECT 'after_dist' AS done, n.`tags`, COUNT(*) AS cnt
FROM `note` n WHERE n.`tags` IS NOT NULL AND n.`tags` <> ''
GROUP BY n.`tags` ORDER BY n.`tags`;

INSERT INTO migration_flags (flag_name) VALUES ('note_tags_cleanup_20260919');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'note_tags_cleanup_20260919';
