USE saudade_blog;
SELECT
  (SELECT COUNT(*) FROM `user` WHERE id = 756)                             AS id_free,
  (SELECT COUNT(*) FROM `user` WHERE username = 'agent_golden_admin_20261017') AS name_free,
  (SELECT COUNT(*) FROM dashboard_todo
    WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%')                AS fixture_at_721,
  (SELECT COUNT(*) FROM dashboard_todo
    WHERE user_id = 756 AND `text` LIKE 'agent\_fixture\_%')                AS fixture_at_756;

-- ⚠️ 前置断言：756 必须空着、且夹具必须**还在 721 名下**。两条任一不成立都说明库不是
--    本文件写的时候那个样子 ⇒ 停下来查清楚，别往下走（下面两条写操作都只认"预期旧值"，
--    不成立时它们会改成 0 行，§④ 会报错——但先把话说在前面比事后查便宜）。
SELECT
  ((SELECT COUNT(*) FROM `user` WHERE id = 756) = 0)                        AS gate_id_free,
  ((SELECT COUNT(*) FROM dashboard_todo
     WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%') = 1)          AS gate_fixture_at_721;

SELECT id, username, role, status FROM `user`
 WHERE role IN ('admin', 'superadmin') ORDER BY id;

-- ── ② 建夹具管理员 756 ─────────────────────────────────────────────────────
-- 口令配方与 `test_accounts_rotate_20260924.sql` / `fixture_admin_closeout_20261017.sql`
-- **逐字相同**：四个随机 UUID 拼起来的原文从来没有被任何人看到过（不经过终端、不落任何
-- 文件、不进 shell 历史、不写进本文件）⇒ `utils.rs::verify_password` 拿输入算 SHA-256
-- 去比对，原文不可知 ⇒ 永不相等 ⇒ **结构上登录不进去**。
--
-- 为什么不是 Argon2id：Argon2id 的 PHC 串里带着盐，本文件无法在这里"就地生成"一个
-- 对应的明文；而这个号**根本不该被登录**，不可知的裸 SHA-256 是这条约束最直接的实现
-- （与 721/722 同形）。代价如实记：它和 721 一样是"旧格式哈希"，若日后全站淘汰裸
-- SHA-256，这一行要跟着处理——但它进不了登录路径，所以那是整洁性问题，不是安全问题。
--
-- nickname 留空串、avatar 留 NULL：与 721/722 逐字同形（`auth.rs` 的 `if nickname.is_empty()`
-- 分支与头像回退链都按这个形状写的）。空串在 `uk_user_nickname`（`nullif(trim(nickname),'')`）
-- 里是 NULL ⇒ 不占唯一键名额，多个空昵称账号可以并存。
--
-- 名字取 `agent_golden_admin_20261017`，**刻意不进 `agent_fixture_` 前缀**：账号族的
-- 残留哨兵（`eval/golden_fixture_account.py`）按那个前缀扫后台名录，本号因为
-- `role = 'admin'` 进不了名录（不会被误报）——但别把名字放进那个前缀，免得日后有人
-- 放宽 `is_listable_role` 时，一条夹具哨兵对着一个**身份**号长鸣。
-- 也不叫 `agent_admin_fixture_*`：那读起来像账号族（冻结夹具 `agent_fixture_freeze_a`）
-- 的成员，实际不是。
INSERT INTO `user` (id, username, nickname, avatar, password, role, status, token_version)
SELECT 756, 'agent_golden_admin_20261017', '', NULL,
       SHA2(CONCAT(UUID(), UUID(), UUID(), UUID()), 256), 'admin', 0, 0
 WHERE NOT EXISTS (SELECT 1 FROM `user` WHERE id = 756)
   AND NOT EXISTS (SELECT 1 FROM `user` WHERE username = 'agent_golden_admin_20261017');

-- ── ③ 待办夹具搬到 756 名下 ────────────────────────────────────────────────
-- 待办列表**按 uid 过滤**（`src/routes/todos.rs` 每个 handler 都做 `UserId.eq(uid)`），
-- 而夹具闸与用例读的都是**发起人自己**那份列表（`eval/golden_fixture_todo.py` 用
-- `GOLDEN_ADMIN_UID` 签令牌）⇒ 主人必须等于 `GOLDEN_ADMIN_UID`。
-- 不搬的话：闸判 `absent` ⇒ `admin_todo_done_popup` / `admin_todo_reschedule_popup`
-- 两条用例被 `golden_fixture.gate` **从分母里摘掉**（只在日志里留一行 `[skip]`）。
--
-- 判据 = 前缀 + 旧主人（`user_id = 721`），与那份 SQL 的清场判据同源 ⇒ 碰不到任何真待办。
-- 搬的是**行本身**（id 129 不变），所以 `created_at` 一起带走——那是"这条夹具什么时候建的"，
-- 属于事实，不该被搬迁抹掉。
UPDATE dashboard_todo SET user_id = 756
 WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%';

-- ── ④ 验收：四件事都必须成立 ────────────────────────────────────────────────
-- 期望一行：id=756、role=admin、status=0、token_version=0、
--           pw_len=64、looks_like_sha256=1、pw_empty=0、nickname_empty=1。
SELECT id, username, role, status, token_version,
       CHAR_LENGTH(password)              AS pw_len,
       (password REGEXP '^[0-9a-f]{64}$') AS looks_like_sha256,
       (password LIKE '$argon2id$%')      AS looks_like_argon2id,
       (password = '' OR password IS NULL) AS pw_empty,
       (nickname = '')                     AS nickname_empty,
       (avatar IS NULL)                    AS avatar_null
  FROM `user` WHERE id = 756;

-- 夹具归属：期望 756 名下**恰好 1 行**、done=0、due_date=2026-11-30；721 名下 0 行。
-- （`done` 与排期是族约定，见 `eval/golden_fixture_todo.py` 头注——搬动不该改这两个值；
--  若这一行此刻不是这个态，说明有人在用例跑完之后没复位，那是另一件事，本文件不代它复位。）
SELECT
  (SELECT COUNT(*) FROM dashboard_todo
    WHERE user_id = 756 AND `text` LIKE 'agent\_fixture\_%')                  AS at_756,
  (SELECT COUNT(*) FROM dashboard_todo
    WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%')                  AS at_721_left,
  (SELECT COUNT(*) FROM dashboard_todo
    WHERE user_id = 756 AND `text` LIKE 'agent\_fixture\_%' AND `done` = 0)   AS at_756_pending;

SELECT id, user_id, sort_order, `text`, `done`, due_date, created_at, updated_at
  FROM dashboard_todo WHERE user_id IN (721, 756) ORDER BY user_id, id;

-- 确认没把别人误伤：admin 名录应当**恰好多出 756 这一个**。
-- 期望（降权后 / 建号前）：1 sora(superadmin) / 5 niuniu / 6 jingbao / 748 demo_admin
--                        建号后：1 / 5 / 6 / 748 / 756 —— **721 不在这一列里**。
SELECT id, username, role FROM `user`
 WHERE role IN ('admin', 'superadmin') ORDER BY id;

-- ── ⑤ flag：**两件事都成立才登记** ─────────────────────────────────────────
-- 条件写全（同另两份夹具迁移的写法）：756 的形态合法、且夹具真的在它名下、且 721 已清空。
-- 任一不满足 ⇒ 不写 flag（flag 的含义是"这次收尾做成了"，不是"本文件被打开过"）。
INSERT INTO migration_flags (flag_name)
SELECT 'golden_admin_fixture_20261017'
 WHERE (SELECT COUNT(*) FROM `user`
         WHERE id = 756 AND username = 'agent_golden_admin_20261017'
           AND role = 'admin' AND status = 0
           AND password REGEXP '^[0-9a-f]{64}$') = 1
   AND (SELECT COUNT(*) FROM dashboard_todo
         WHERE user_id = 756 AND `text` LIKE 'agent\_fixture\_%') = 1
   AND (SELECT COUNT(*) FROM dashboard_todo
         WHERE user_id = 721 AND `text` LIKE 'agent\_fixture\_%') = 0
   AND NOT EXISTS (SELECT 1 FROM migration_flags WHERE flag_name = 'golden_admin_fixture_20261017');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_admin_fixture_20261017';
