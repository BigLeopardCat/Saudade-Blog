USE saudade_blog;
-- =============================================================================
-- 20261017 给 golden 的管理员身份换一个**专用夹具号**（721 降权之后的收尾）
--
-- ## 为什么还要跑这一趟
--
-- `fixture_admin_closeout_20261017.sql` 把 721 降权成了 user。721 原本同时兼任两件事：
--   ① golden 的**管理员身份**（`GOLDEN_ADMIN_UID`，`scripts/nightly_regression.sh`）；
--   ② 几族**评测夹具的主人**（待办族那一条待办挂在它名下）。
-- 降权之后 ① 必须换人，而 ② 里有一族是**按 uid 过滤**的 ⇒ 跟着 ① 一起走。
--
-- ## 为什么另建一个号，而不是就近指 748 `demo_admin`
--
-- 就近改指 748 是零成本的，但 748 是**在用的号**（20261017 实测：3 个会话 / 89 条消息 /
-- 2 篇文章 / 57 条执行回执，另有一条真人待办 10-09 创建、当天 06:05 还在后台编辑过）。
-- 原设计特意挑一个**从不登录**的号当身份，理由写在 `golden_fixture_todo_20261003.sql`
-- 的《为什么建在 721 名下》：后台首页那张待办卡保存走的是
-- `PUT /api/protected/todos` —— **整份列表覆盖**（`todos.rs::save_todos` 事务内先删该用户
-- 全部行再逐条插入）。也就是说，谁在首页点一下保存，**库里那行会连同前端不知道的其它行
-- 一起被删掉**。夹具落在"从不登录"的号名下就没有第二个写者；落在 748 名下则有。
--
-- 另一个理由与安全无关、与判据有关：golden 的真写通道（`GOLDEN_ALLOW_REAL_WRITE=1`）
-- 会以这个身份真写生产库。身份落在一个真人账号上，出事时"这条记录是谁写的"就再也分不开
-- ——文章 23 被记成 uid 721 那次就是这个形状（见 `src/routes/notes.rs` 的函数内注释）。
--
-- 所以：**新建一个专用夹具管理员**，把 ① 和 ② 一起挪过去。这与
-- `test_accounts_20260924.sql` 当初的做法同形（评测专用号、口令不可知、从不登录），
-- 区别只在于本文件是**显式点名**地建，而不是让评测脚本自己造。
--
-- ## 为什么是显式 id = 756
--
-- `GOLDEN_ADMIN_UID` 是个环境变量，值必须**事先确定**（`AUTO_INCREMENT` 分配的号要跑完
-- 才知道，会让"改指"变成两步）。20261017 实测 `user` 表 `AUTO_INCREMENT = 756` 且 756
-- 空着 ⇒ 写死 756 **不会抬高自增位**（插入 756 只把它推到 757，与自然分配同效）。
-- 换机器/换库重放时若 756 已被占用，§① 的前置断言会**响亮不通过**，而不是插成另一个号。
--
-- ## 本文件做什么
--   ① 核验现状（只读）：756 空着吗、待办夹具现在挂在谁名下、admin 名录长什么样
--   ② 建夹具管理员 756（口令 = 四个随机 UUID 的 SHA-256 ⇒ **结构上登录不进去**）
--   ③ 把待办夹具从 721 挪到 756（`dashboard_todo` 按 uid 过滤，不挪就判 absent）
--   ④ 验收：号的形态、夹具归属、721 名下已清空、admin 名录
--   ⑤ flag（**条件写**：两件事都成立才登记）
--   ⑥ 回滚
--
-- ## 幂等
-- INSERT 带 `NOT EXISTS`（按 id + username 双判据）、UPDATE 带 `user_id = 721` 的旧值
-- 判据 ⇒ 重复执行都是 0 行改动，§④ 照常通过。这是**真幂等**（与口令轮换那格不同：
-- 那格的幂等是"结果的性质相同"，这格是"字节相同"）。
--
-- ## 点名串（跑之前需要主人显式授权）
--   mysql,saudade_blog,scripts/migration/golden_admin_fixture_20261017.sql,迁移允许
-- =============================================================================

-- ── ① 现状核验（**只读**；跑之前看，跑之后对照）────────────────────────────
-- 期望（20261017 实测）：756 不存在（id_free=1、name_free=1）；
--   待办夹具 1 行、user_id = 721；admin 名录 = 1 sora / 5 niuniu / 6 jingbao / 748。
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

-- 回读 flag（期望 1 行；列名是 applied_at——`created_at` 不存在，20260924 首跑就撞在这）
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_admin_fixture_20261017';

-- ── ⑥ 回滚（两段**各自独立**，不要一起撤）───────────────────────────────────
-- ⚠️ 口令**回滚不了**（原文不可知）⇒ 这一段的"回滚"在语义上不存在，只能**再轮换一次**
--    （把 §② 的 SHA2 那一句单独再跑一遍即可，结果仍是"有确定来历的不可知哈希"）。
--
-- ③ 的搬迁可以精确回滚（前提是你要把夹具还给一个已经降权的号——**通常不该回滚**，
--    因为 721 已不是 admin，还回去只会让那两条用例继续判 absent）：
--   UPDATE dashboard_todo SET user_id = 721
--    WHERE user_id = 756 AND `text` LIKE 'agent\_fixture\_%';
--
-- ② 的建号可以精确回滚（**先确认 756 名下没有别的数据**）：
--   DELETE FROM `user` WHERE id = 756 AND username = 'agent_golden_admin_20261017';
--   （删号前先看它挂着什么：talk / dashboard_todo / user_notification / execution_log
--     都是按 uid 关联的。756 是新建的，正常只有 user_notification 会随公告扇出增长。）
--
-- flag 撤销：
--   DELETE FROM migration_flags WHERE flag_name = 'golden_admin_fixture_20261017';

-- ── 已知副作用（先知道再落地）──────────────────────────────────────────────
--   · 756 会**出现在后台「临时用户」列表里吗**？**不会**——那份名录的判据是
--     `authz::is_listable_role(role)`，只收 `role = 'user'`（`src/routes/temp_user.rs`）。
--     这是刻意的：管理员不进那份列表，也就不会被列表页上的一次误点删掉
--     （722 在 20261001 03:28:02 就是这样没的）。
--   · 756 **会**收到此后每一则公告的 `user_notification` 扇出（`announcements.rs::fan_out`
--     遍历整张 `user` 表）⇒ 那一栏会随公告数单调增长。同 721/722/730/743 的既有形状，
--     不额外处理；要清理得连同整个夹具族一起设计。
--   · 756 **不会**出现在公开面任何地方，也不会出现在数据板的用户活动统计里（它没有
--     会话/文章/留言）。
--
-- =============================================================================
-- 本文件之外（跑完必须跟着做，否则 golden 的身份通道仍指着已降权的 721）
-- =============================================================================
-- `GOLDEN_ADMIN_UID` 要从 748/721 改指 **756**，三处（agent 仓）：
--
--   ① `saudade-blog-agent/scripts/nightly_regression.sh` 的 `export GOLDEN_ADMIN_UID=`
--      （长注也在这里——身份为什么换、换了要满足什么条件，单一出处）
--   ② `saudade-blog-agent/eval/param_matrix.py` 的 `IDENTITY_ENV`
--   ③ `saudade-blog-agent/eval/experiments/ckpt_ab_driver.py` 的臂环境
--   （另有两处**跑法文档**同步：`eval/fastpath_pricing.py` 与 `eval/run_golden.py` 的用法串）
--
-- ⚠️ 这一条**不在本文件的授权范围内**（它是 agent 仓的代码改动，不是库写操作）。
--    改指之前先只读探一次，确认 756 真的可用：
--      GOLDEN_ADMIN_UID=756 .venv/bin/python eval/identity_preflight.py
--      GOLDEN_ADMIN_UID=756 .venv/bin/python eval/golden_fixture_todo.py --verify
-- =============================================================================
