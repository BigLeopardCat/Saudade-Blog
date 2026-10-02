USE saudade_blog;
-- =============================================================================
-- 删掉遗留的第二个哈希账号（`user.id = 3`，20260924）
--
-- 事实（已读库核实，只读点名两轮）：
--   `user.id=3` 的 `username` 与 `nickname` 都是 **64 位十六进制串**
--   `ae5deb822e0d71992900471a7199d0d95b8e7c9d05c40a8245a281fd2c1d6684`、`role='user'`。
--   与 20260924 那次把 `id=1` 改回 `sora` 是**两回事**：那一行是博主的号（早年
--   `web_info` 把用户名也哈希存储的形态，见 `src/utils.rs` 的 `encrypt_password` doc），
--   改回 `sora` 后继续在用；这一行没有任何真实主人，留着只会在登录页与后台
--   「临时用户」列表里露一串谁也认不出的哈希。
--
-- 改前已核的足迹（全库 22 张表的列清单 + 逐表 COUNT，见 commit 说明）：
--   按 `user_id` 引用用户的 12 张表里，只有 `user_notification` 有 2 行；
--   `chat_history` / `chat_summary` / `conversation` / `dashboard_todo` /
--   `execution_log` / `pending_action` / `user_favorite` / `user_message`
--   (from/to) / `user_message_draft` / `talk` 全部为 0；
--   按**名字**引用的两处（`talk.author`、`user_message_draft.to_username`，都是
--   按名字存的 varchar）也都是 0。
--   ⇒ 这次删除动到的只有：`user_notification` 2 行 + `user` 1 行。
--
-- 为什么连那 2 条通知一并删：它们指向一个从此不存在的 uid，留着就是孤儿行
--   （通知接口按 uid 过滤，谁也读不到，但它是"删干净"与"删一半"的区别）。
--
-- 幂等：两条 DELETE 的 WHERE 都带"仍是历史形态"的条件，重复执行影响 0 行。
--       下面每条 SELECT 都是**断言/凭证**（期望值写在列名里），不是查询本身。
--
-- 回滚：删除前那条 SELECT 的输出（id / type / title / content / link / created_at）
--       就是全部凭证 —— 要还原就照那行 INSERT 回 `user_notification`；
--       `user.id=3` 那行同理（username/nickname 用本文档里的哈希串、role='user'）。
--       **口令不回显**（这里只取长度做凭证）：那是个连主人是谁都认不出的遗留号，
--       没人会去登录它，真要还原就给一个新随机口令。本条迁移不删任何文章/说说/收藏。
--
-- flag: user_remove_legacy_hash_account_20260924（migration_flags，勿重跑）
-- =============================================================================

-- 断言 1：目标行确实还是那个遗留形态（期望 1）—— 万一 id 被复用，这条会先爆
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
