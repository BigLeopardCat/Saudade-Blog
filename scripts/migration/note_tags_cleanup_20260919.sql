USE saudade_blog;
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
