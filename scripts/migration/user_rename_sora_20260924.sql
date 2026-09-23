USE memory_blog;
-- =============================================================================
-- 博主账号的用户名：从历史哈希串改回 `sora`（20260924）
--
-- 事实（已读库核实）：
--   `user.id=1` 的 `username` 是 **sha256('sora') 的十六进制串**
--   （`a4c745fa…ffb35`；本地可复核：`printf 'sora' | sha256sum`），
--   `nickname='Sora Saudade'`、`role='admin'`。
--   这是早年 `web_info` 把**用户名也哈希存储**留下的形态（见 `src/utils.rs`
--   的 `encrypt_password` doc：用途 ①「兼容旧用户名的哈希存储」）。
--   登录侧 `src/routes/auth.rs:64` 一直走「明文 + 其哈希」两条路查库，
--   所以输入 `sora` 能登进去；但 `/profile` 回给前端的 `username` 是**库里的哈希串**，
--   于是登录页那份「本机登录过的账号」清单里存的是哈希串 —— 输 `sora` 认不出自己的头像。
--
-- 改前已核的影响面：
--   · 两仓 grep 无任何逻辑硬编码某个具体用户名（`sora` 只出现在版权文案、邮箱、
--     分支名 `cn_sora_blog` 与文档里）；JWT 只认 uid，文章/留言/说说/河灯全按 uid 关联
--     ⇒ 改用户名不动任何业务数据；
--   · `auth.rs:64` 的兼容分支**保留**：改后「输入 sora」走第一条明文路直接命中；
--   · `web_info.rs` 那三处 `find_by_id(1)` 按 **id** 取博主资料，与本行无关。
--
-- 幂等：UPDATE 的 WHERE 同时锁 `id` 与"用户名仍是那一串"，重复执行影响 0 行。
--       两条前置 SELECT 是**断言**（期望值写在列名里），不是查询结果的一部分。
-- flag: user_rename_sora_20260924（migration_flags，勿重跑）
-- =============================================================================

-- 断言 1：目标用户名未被占用（期望 0）—— 若已有 sora 行，UPDATE 会撞 UNIQUE(username)
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
