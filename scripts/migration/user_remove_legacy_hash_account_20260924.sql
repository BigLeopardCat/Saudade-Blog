-- flag: user_remove_legacy_hash_account_20260924（migration_flags，勿重跑）
USE saudade_blog;
SELECT COUNT(*) AS `target_should_be_1` FROM `user`
 WHERE `id` = 3
   AND `username` = 'ae5deb822e0d71992900471a7199d0d95b8e7c9d05c40a8245a281fd2c1d6684'
   AND `role` = 'user';

-- 断言 2：全库里"按名字"引用它的地方必须是 0（非 0 就先别删，回来看看是谁）
SELECT (SELECT COUNT(*) FROM `talk`
         WHERE `author` = 'ae5deb822e0d71992900471a7199d0d95b8e7c9d05c40a8245a281fd2c1d6684')
     + (SELECT COUNT(*) FROM `user_message_draft`
         WHERE `to_username` = 'ae5deb822e0d71992900471a7199d0d95b8e7c9d05c40a8245a281fd2c1d6684')
       AS `name_refs_should_be_0`;

-- 删除前的凭证：这 2 行待删的通知长什么样（回滚靠它）
SELECT `id`, `type`, `title`, `content`, `link`, `is_read`, `created_at`
  FROM `user_notification` WHERE `user_id` = 3;

-- 删除前的凭证：这一行待删的账号（口令只取长度 —— 见头注"回滚"那段）
SELECT `id`, `username`, `nickname`, `avatar`, LENGTH(`password`) AS `pwd_len`, `role`
  FROM `user` WHERE `id` = 3;

DELETE FROM `user_notification` WHERE `user_id` = 3;

DELETE FROM `user`
 WHERE `id` = 3
   AND `username` = 'ae5deb822e0d71992900471a7199d0d95b8e7c9d05c40a8245a281fd2c1d6684';

-- 复核 1：账号没了，且没有第二个同形态的遗留账号（期望 0 / 0）
SELECT
  (SELECT COUNT(*) FROM `user` WHERE `id` = 3)                                  AS `user_should_be_0`,
  (SELECT COUNT(*) FROM `user` WHERE `username` REGEXP '^[0-9a-f]{64}$')         AS `any_hash_user_should_be_0`;

-- 复核 2：它的通知也没了，且没有别的孤儿通知（期望 0 / 0）
SELECT
  (SELECT COUNT(*) FROM `user_notification` WHERE `user_id` = 3)                AS `notif_should_be_0`,
  (SELECT COUNT(*) FROM `user_notification` n
     LEFT JOIN `user` u ON u.`id` = n.`user_id` WHERE u.`id` IS NULL)           AS `orphan_notif_should_be_0`;

-- 复核 3：在用的账号没被碰到（id=1 博主 + 测试账号）
SELECT `id`, `username`, `nickname`, `role` FROM `user` ORDER BY `id`;

INSERT INTO migration_flags (flag_name) VALUES ('user_remove_legacy_hash_account_20260924');
