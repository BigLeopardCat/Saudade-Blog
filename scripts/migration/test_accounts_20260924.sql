USE memory_blog;
-- 20260924 测试专用账号落库（评估加固的前置：需要"真身份"的那一类用例）。
--
-- 为什么需要这两个账号：评测/探针里有两类用例，**判据不同**——
--   ① 只测权限判定（能做什么）：只给 role 就够，uid 保持 0，不需要任何账号；
--   ② 要以某个身份真调上游（对谁做）：agent 侧 `uid <= 0` 是哨兵，**一个字节都不发**，
--      而 Rust 侧 `prepare_chat` 是按 uid 查库拿 role、再按 UserId 过滤数据的
--      ⇒ 没有一个"库里真实存在、role 对得上"的 uid，这类用例只能跑在虚构态
--      （现状：golden 里 5 条管理员写用例因 `GOLDEN_ADMIN_UID` 未设而常年 SKIP，
--      另有 25 条 role 用例跑在 `role=admin, uid=0` 这个生产上不存在的组合下）。
-- 这两个账号只为第 ② 类存在，不是"为了有账号而有账号"。
--
-- **为什么不复用 uid 1**：uid 1 是博主本人在用的账号，写用例拿它跑会真改主人自己的
-- 文章/标签/账号数据；`src/routes/web_info.rs` 里还有三处 `find_by_id(1)` 在结构上
-- 绑定这个账号（已决定不让自动化覆盖那三处）。测试账号与主人账号必须分开。
--
-- **这两个账号不需要口令也能用**：L3 探针走 JWT 自签 + `X-Agent-Assertion`（只取 uid，
-- Rust 每个请求自己查库拿 role）；golden 的写用例同样只借 uid。口令在这里只为满足
-- NOT NULL 与格式约束，**任何自动化都不该拿它登录**。
--
-- **L4 渲染层（frontend/tests/*.py 的 9 个沙箱）用不到这两个账号**：它们把后端桩掉
-- （esbuild 替换边界模块），测的是真组件 + 无头 Chrome 的渲染与时序，不连真接口。
--
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
--
-- ⚠️ 已知副作用（落地前先知道）：
--   722 是 `role = 'user'` ⇒ 会出现在后台「临时用户」列表里（`temp_user::list_temp_users`
--   按 `role = 'user'` 过滤，是既有实现）。用户名要起得**一眼能认出来**，否则会被当
--   游客垃圾账号删掉；721 是 admin，不进那个列表。
--   两个 id 都取在 7xx：库里现有行只有个位数 id，留足余量，也不会与任何历史 id 撞上。

-- ── ① 预检：721/722 必须**两个都空**（按 id 与按用户名各查一遍）──────────────
-- 期望：第一句 0 行；第二句（按用户名）也 0 行。任何一句回行 ⇒ 停下来先看清楚
-- 那行是什么，**不要**用 ON DUPLICATE KEY / REPLACE 硬覆盖（那会静默改掉一个已有账号）。
SELECT id, username, role FROM `user` WHERE id IN (721, 722);
SELECT id, username, role FROM `user`
 WHERE username IN ('REPLACE_ME_ADMIN_TEST', 'REPLACE_ME_USER_TEST');

-- ── ② 口令占位（建号者当场替换；强随机 ≥20 字符，两个账号必须不同）──────────
-- 为什么不写 PHC：本机没有 argon2 CLI、agent venv 也没有 argon2 模块（20260921 实测）。
-- SHA2(x,256) 十六进制正好等于 Rust 的 `utils::encrypt_password`（无盐单轮旧格式），
-- `verify_password` 认它，且**首次登录那一刻自动升级成 Argon2id**（惰性升级）。
-- 代价：这个哈希在 SQL 文本与终端历史里都是可离线爆破的 ⇒ 强随机 + 只在本地替换、
-- 替换后的文件不要进 git（本文件入库的版本只有占位符）。
SET @admin_pw := 'REPLACE_ME_ADMIN_PW';
SET @user_pw  := 'REPLACE_ME_USER_PW';

-- ── ③ 建号：只新增这两行，不碰任何已有账号 ──────────────────────────────────
-- nickname 留空串是**有意的**：`auth.rs` 的 profile 逻辑 `if nickname.is_empty()`
-- 会回落到账号名，不会显示成空白。avatar 留 NULL（没设过 = 展示端回退站点主人头像）。
-- role 只有 'admin' / 'user' 两种拼写（跨语言契约：Rust `authz::KNOWN_ROLES`），
-- role 是无约束 varchar ⇒ **写错不会报错**，账号能登录但零权限，④ 必须核对拼写。
INSERT INTO `user` (id, username, nickname, avatar, password, role) VALUES
  (721, 'REPLACE_ME_ADMIN_TEST', '', NULL, SHA2(@admin_pw, 256), 'admin'),
  (722, 'REPLACE_ME_USER_TEST',  '', NULL, SHA2(@user_pw,  256), 'user');

-- ── ④ 验收：**必须恰好 2 行**，且 role 拼写就是 admin / user ────────────────
SELECT id, username, role FROM `user` WHERE id IN (721, 722) ORDER BY id;
SELECT COUNT(*) AS must_be_2 FROM `user`
 WHERE id IN (721, 722) AND role IN ('admin', 'user');

-- ── ⑤ 打标记：仅在 ④ 通过时写入（flag 已存在则不重复写，可安全重跑）────────
INSERT INTO migration_flags (flag_name)
SELECT 'test_accounts_20260924'
 WHERE (SELECT COUNT(*) FROM `user` WHERE id IN (721, 722) AND role IN ('admin', 'user')) = 2
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'test_accounts_20260924');

-- ── 回滚（如需）：把两个测试账号整个删掉 ────────────────────────────────────
-- DELETE FROM `user` WHERE id IN (721, 722);
-- DELETE FROM migration_flags WHERE flag_name = 'test_accounts_20260924';
-- （回滚后记得同步撤掉依赖它们的配置：GOLDEN_ADMIN_UID / GOLDEN_USER_UID。）
