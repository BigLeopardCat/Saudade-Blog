USE memory_blog;
-- =============================================================================
-- 20260924 测试专用账号 721/722：**核验与登记**（本文件不新增任何账号）
--
-- ⚠️ 执行到本文件时的真实状态，与它第一版写的不一样，如实记在第一段：
--   721/722 两行**已经存在**，用户名是 `agent_test_admin_721` /
--   `agent_test_user_722`（`role` 分别是 admin / user）。第一版的 `INSERT` 撞上
--   `ERROR 1062 Duplicate entry '721' for key 'user.PRIMARY'` 而失败——
--   **没有覆盖任何数据**，因为那一句是全仓一贯的写法：没有任何
--   `ON DUPLICATE KEY` / `REPLACE`（刻意如此，静默改掉一个已有账号是更坏的结果）。
--
--   这两个用户名在**父仓与 agent 仓（含全部 git 历史）grep 零命中** ⇒ 这两行不是
--   任何一个版本的迁移文件建出来的，来历在仓库之外（人工 SQL、或早前会话直接写库）。
--   来源无法从仓库侧确证，**不猜测**：本文件因此只做两件事——核验现状、登记 flag。
--   空库重放用的 INSERT 见 §③（注释形态，用户名与现网一致）。
--
--   **同名 flag 也已经在了**：`migration_flags.test_accounts_20260924` 的
--   `applied_at = 2026-09-24 00:51:49`，比本文件第一次成功运行（02:5x）早两个多小时
--   ⇒ 建号那次操作**当时就手工登记了 flag**。本文件 §⑤ 的 INSERT 因此是**空操作**
--   （`NOT EXISTS` 命中），登录的是 §①/②/⑤ 的核验事实，不是"我建了它"。
--
-- 为什么需要这两个账号（评估加固的前置：需要"真身份"的那一类用例）：
--   评测/探针里有两类用例，**判据不同**——
--     ① 只测权限判定（能做什么）：只给 role 就够，uid 保持 0，不需要任何账号；
--     ② 要以某个身份真调上游（对谁做）：agent 侧 `uid <= 0` 是哨兵，**一个字节都不发**，
--        而 Rust 侧 `prepare_chat` 是按 uid 查库拿 role、再按 UserId 过滤数据的
--        ⇒ 没有一个"库里真实存在、role 对得上"的 uid，这类用例只能跑在虚构态
--        （现状：golden 里 5 条管理员写用例因 `GOLDEN_ADMIN_UID` 未设而常年 SKIP，
--        另有 25 条 role 用例跑在 `role=admin, uid=0` 这个生产上不存在的组合下）。
--   这两个账号只为第 ② 类存在，不是"为了有账号而有账号"。
--
-- **为什么不复用 uid 1**：uid 1 是博主本人在用的账号，写用例拿它跑会真改主人自己的
-- 文章/标签/账号数据；`src/routes/web_info.rs` 里还有三处 `find_by_id(1)` 在结构上
-- 绑定这个账号（已决定不让自动化覆盖那三处）。测试账号与主人账号必须分开。
--
-- **任何自动化都不该拿口令登录**：L3 探针走 JWT 自签 + `X-Agent-Assertion`（只取 uid，
-- Rust 每个请求自己查库拿 role）；golden 的写用例同样只借 uid。
-- ⚠️ 但见 §④：现网这两行的口令**是什么形态，交由核验输出判定**，不由本文件的意图决定。
--
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
--
-- ⚠️ 已知副作用（先知道再落地）：
--   722 是 `role = 'user'` ⇒ 会出现在后台「临时用户」列表里（`temp_user::list_temp_users`
--   按 `role = 'user'` 过滤，是既有实现）。现网用户名带 `agent_test_` 前缀，一眼认得出，
--   不至于被当游客垃圾账号删掉；721 是 admin，不进那个列表。
--   两个 id 都取在 7xx：库里现有行只有个位数 id，留足余量，也不会与任何历史 id 撞上。
--   `user` 表**没有 created_at 列**（`src/entity/user.rs` 只有 id/username/nickname/
--   avatar/password/role）⇒ 这两行**建号时刻无法从库里查出**，别去找。

-- ── ① 现状核对：两行都在、id 与用户名与上文一致 ─────────────────────────────
-- 期望：恰好 2 行，id 721/722，用户名为 agent_test_admin_721 / agent_test_user_722。
-- 口令**只打印形态，不打印值**（长度 / 是否为 64 位十六进制 / 是否为 argon2id PHC）：
-- 口令哈希是凭据材料，纪律禁止把它写进终端、trace 或任何文件。
SELECT id, username, role,
       CHAR_LENGTH(password)                        AS pw_len,
       (password REGEXP '^[0-9a-f]{64}$')           AS looks_like_sha256,
       (password LIKE '$argon2id$%')                AS looks_like_argon2id,
       (password = '' OR password IS NULL)          AS pw_empty
  FROM `user`
 WHERE id IN (721, 722)
 ORDER BY id;

-- ── ② role 拼写核对 ─────────────────────────────────────────────────────────
-- role 是无约束 varchar ⇒ **写错不会报错**，账号能登录但零权限。
-- 只有 'admin' / 'user' 两种拼写（跨语言契约：Rust `authz::KNOWN_ROLES`）。
SELECT COUNT(*) AS must_be_2 FROM `user`
 WHERE id IN (721, 722) AND role IN ('admin', 'user');

-- ── ③ 空库重放用的 INSERT（**本文件不执行**，仅存档，用户名与现网一致）──────
-- 只有当 §① 查出来是 0 行（换库/重建）时才需要它；口令是
-- `SHA2(CONCAT(UUID(),UUID(),UUID()),256)`：三个随机 UUID 拼起来的原文**从来没被任何人
-- 看到过**（不经过终端、不落任何文件）⇒ 结构上登录不进去。口令哈希是合法旧格式：
-- SHA2(x,256) 十六进制 == Rust `utils::encrypt_password`（无盐单轮）的输出，
-- `verify_password` 认这个形状（20260921 实测：本机无 argon2 CLI、agent venv 也无
-- argon2 模块，写不出 PHC 字符串）。将来若真要登录这两个号，唯一途径是 UPDATE 新哈希。
-- INSERT INTO `user` (id, username, nickname, avatar, password, role) VALUES
--   (721, 'agent_test_admin_721', '', NULL, SHA2(CONCAT(UUID(), UUID(), UUID()), 256), 'admin'),
--   (722, 'agent_test_user_722',  '', NULL, SHA2(CONCAT(UUID(), UUID(), UUID()), 256), 'user');
-- （nickname 留空串是有意的：`auth.rs` 的 profile 逻辑 `if nickname.is_empty()` 会回落到
--   账号名，不会显示成空白；avatar 留 NULL = 没设过，展示端回退站点主人头像。）

-- ── ④ 口令形态（**以下是 20260924 实测结果**，不是设计意图）─────────────────
-- 实测：两行都是 `pw_len=64`、`looks_like_sha256=1`、`looks_like_argon2id=0`、
-- `pw_empty=0` ⇒ 是真哈希、非空口令，且**不是**登录/注册链路写的。
-- 为什么能这么断定：20260917 起博客自己的口令写入路径产出的是 Argon2id PHC 字符串
-- （`utils.rs` 的 `hash_password`），SHA-256 只在**校验旧哈希**时出现。现网这两行是
-- 裸 SHA-256 ⇒ 它们是**用 SQL 的 `SHA2()` 直接写进去的**，不是任何人从前台注册/改密的。
-- 这反过来说明：**§③ 那个 UUID 配方（或它的等价物）大概率就是当时的写法**——
-- 但这是推断，不是证据。
--
-- ⚠️ **"不可知"这件事无法事后证明**：哈希不可逆，SQL 里也验不出原文当初是不是
-- `CONCAT(UUID(),UUID(),UUID())`。若原文是某个**有人知道**的短串，那么"721 是真
-- admin 角色 + 有人知道的口令"这条链就成立——本文件**不替它开脱**。
-- 要拿到那个保证只有一条路：**把这两行的口令 UPDATE 成一个新的不可知哈希**
-- （配方同 §③）。这是**另一种性质的写操作**（改已有账号的凭据），
-- 不在本文件的授权范围内，须另行点名；点名串形状：
--   mysql,memory_blog,scripts/migration/<新文件>,迁移允许
-- 在此之前，纪律上就按"这两行口令可能有人知道"对待：**不要在这两个号上放任何
-- 只有主人能看的数据**，也不要把它们加进任何会真写业务数据的自动化。

-- ── ⑤ 验收 + 打标记：仅在 ① 与 ② 都通过时写入 ─────────────────────────────
-- 条件句写全：两行都在、role 拼写正确、口令非空且长度像哈希。任一不满足 ⇒ 不写 flag
-- （flag 的含义是"这两个账号已核验可用"，不是"本文件被打开过"）。
-- 实测（20260924 02:5x 本轮）：条件成立，但 flag 早在 00:51:49 就被建号那次操作登记了
-- ⇒ 这一句是空操作，`NOT EXISTS` 命中。留着它是为了**换库/重建时**仍然能一次跑通。
INSERT INTO migration_flags (flag_name)
SELECT 'test_accounts_20260924'
 WHERE (SELECT COUNT(*) FROM `user`
         WHERE id IN (721, 722) AND role IN ('admin', 'user')
           AND password IS NOT NULL AND password <> '' AND CHAR_LENGTH(password) >= 64) = 2
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'test_accounts_20260924');

-- 回读 flag（期望 1 行；列名是 applied_at——`created_at` 不存在，20260924 首跑就是撞在这）
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'test_accounts_20260924';

-- ── 回滚（如需）：**本文件没有新增任何账号** ⇒ 回滚只需撤 flag ───────────────
-- DELETE FROM migration_flags WHERE flag_name = 'test_accounts_20260924';
-- 确要连账号一起删（会连带影响依赖它们的配置）：
-- DELETE FROM `user` WHERE id IN (721, 722) AND username IN ('agent_test_admin_721', 'agent_test_user_722');
-- （删号后记得同步撤掉依赖它们的配置：GOLDEN_ADMIN_UID / GOLDEN_USER_UID。）
