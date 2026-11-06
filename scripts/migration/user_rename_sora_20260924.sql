-- flag: user_rename_sora_20260924（migration_flags，勿重跑）
USE saudade_blog;
SELECT COUNT(*) AS `taken_should_be_0` FROM `user` WHERE `username` = 'sora';

-- 断言 2：待改的那一行确实还是历史形态（期望 1）
SELECT COUNT(*) AS `target_should_be_1` FROM `user`
 WHERE `id` = 1
   AND `username` = 'a4c745facd3a921565e2c12d2db6a4021d4764f633a18400634d68df575ffb35';

UPDATE `user`
   SET `username` = 'sora'
 WHERE `id` = 1
   AND `username` = 'a4c745facd3a921565e2c12d2db6a4021d4764f633a18400634d68df575ffb35';

-- 复核：id=1 的用户名已是 sora，密码 / nickname / role 未动
SELECT `id`, `username`, `nickname`, `role` FROM `user` WHERE `id` = 1;

INSERT INTO migration_flags (flag_name) VALUES ('user_rename_sora_20260924');
