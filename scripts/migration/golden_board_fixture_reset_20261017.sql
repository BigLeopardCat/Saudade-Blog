USE saudade_blog;
-- =============================================================================
-- 20261017 留言族夹具**复位**：把 `agent_fixture_待审留言（评测夹具，用后即删）`
--        从「未通过」`approved = 2` 复位回「待审」`approved = 0`
--
-- ## 为什么需要单独一份，而不是重跑 20260930 那份
--
-- `golden_board_fixture_20260930.sql` 的 §② 是**只插不改**的：
--   `INSERT INTO talk (...) SELECT ... WHERE NOT EXISTS
--      (SELECT 1 FROM talk WHERE content LIKE 'agent\_fixture\_%');`
-- 行还在、只是状态不对时，那一句是**空操作**。而夹具闸给出的跳过理由里写着
-- 「重跑 `scripts/migration/golden_board_fixture_20260930.sql` 重建」——**那句话对
-- 「行不在」成立、对「行在但状态不对」不成立**（`wrong_state` 这一格 20260930 写文件时
-- 还不存在，那句提示是照分类族那半抄的）。本文件补的正是那一格该有的动作。
-- 与账号族那半**刻意对称**：`golden_fixture_account_20260926.sql` 的 §② 里就带着
-- `UPDATE user SET status = 1 ...` 这句复位，所以那一族重跑就够；留言族缺的就是这一句。
--
-- ## 不复位的代价（为什么值得单独跑一趟）
--
-- 留言族两条用例都声明了 `requires_fixture_kind: "board"`：
--   · `admin_board_identity_from_roster`（读，**夜间跑**）——它的前提**逐字**是「这条留言
--     是待审的」：待审行在公开池里根本不存在（`src/routes/talks.rs::list_by_src` 恒
--     `filter(Approved = 1)`）⇒ 只要回复给出了这条的身份，就一定是走了后台名册。
--     状态不是待审时这条前提不成立。
--   · `board_audit_from_ledger_exec`（真写；夜间按设计不跑，`needs_real_write`）。
-- 状态不是待审 ⇒ 夹具闸判 `wrong_state` ⇒ 两条用例**静默掉出分母**（只打一行 `[skip]`）。
-- 那不是红，是**没评**——分母少了两条这件事，只有读那行 skip 才看得见。
--
-- ## 谁把它改成 2 的
--
-- 后台复核那条写路径（`approved`：0=待审 / 1=通过 / 2=未通过，见 `src/routes/talks.rs`
-- 的字段注与 `comments.rs` 的同类注释）。夹具正文里那句「用后即删」是**骗人的**
-- （`board_audit_from_ledger_exec` 的 `_note` 自己就写着这句）：复核只有通过/驳回两态，
-- 点完那条就不在待审队列里了 ⇒ 这一族与账号族一样是**常驻夹具**。本文件复位的是
-- **状态**，不是存在性。
--
-- ## 判据只认前缀族，碰不到任何真留言
--
-- 唯一的 WHERE 是 `content LIKE 'agent\_fixture\_%'`（前缀保留族，与清场 SQL 同一判据）
-- ＋ `approved <> 0`（只改状态不对的那一行）。本机即生产，后台队列里随时可能有真实访客的
-- 待审留言——它们的正文**不可能**以该前缀开头 ⇒ 结构上碰不到。
--
-- ── ① 现状核对（**只读**；先看，再决定要不要改）────────────────────────────
-- 期望 `family_rows` = 1（本文件只认这一行）。`other_pending` 只是把落地这一刻**真待审**
-- 的条数留在执行记录里（不是判据，本文件一行都不碰它）。
-- 第二句把该行的**全部状态列**印出来：本文件会把这些列清回 NULL，而清之前先把原值
-- 留在执行记录里——回滚段因此是"照记录填回去"而不是"猜原来是什么"。
SELECT 'state' AS done,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%')          AS family_rows,
       (SELECT COUNT(*) FROM talk WHERE src = 'board' AND approved = 0)           AS other_pending,
       (SELECT COUNT(*) FROM talk WHERE src = 'board' AND approved = 2)           AS board_rejected;

SELECT 'before' AS done, id, approved, src, user_id, author,
       ai_result, ai_reason, reject_reason, created_at, updated_at, LEFT(content, 60) AS content
  FROM talk WHERE content LIKE 'agent\_fixture\_%';

-- 停机闸：**前缀族恰好一行**才允许往下。0 行说明行被删了（那种情况该重跑 20260930 那份
-- 去重建，不是本文件）；多于 1 行说明有东西脱离了契约（重复插入 / 手工建过同族名字）
-- ——那种库里状态不该被本文件顺手改掉，先查清"到底哪一行才是那条夹具"。
SELECT 'must_be_exactly_1' AS done,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') AS n,
       CASE WHEN (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') = 1
            THEN 'OK' ELSE 'STOP' END AS gate;

-- ── ② 复位：状态回到「待审」，审核列清回 NULL ─────────────────────────────────
-- 三件一起做才是"回到夹具原形"（20260930 的 §② 插出来的就是 approved=0 且三个审核列
-- 全 NULL）：只把 approved 改回 0、留着 `reject_reason`，那一行就会带着一条"为什么被驳回"
-- 的理由躺在待审队列里——后台渲染、以及任何按 reject_reason 判断的读路径都会看到一个
-- 自相矛盾的行。`ai_result` / `ai_reason` 同理（20260930 写明它们为 NULL = **没走过 AI 审核**，
-- 那正是"人工全审"这个开关组合下的正常形态；不编一个假的 pass/flag）。
--
-- `AND approved <> 0` 让重复跑成为**空操作**（真幂等：第二次跑改 0 行，一个字节都不动）。
--
-- ⚠️ **本表没有 `ON UPDATE CURRENT_TIMESTAMP`**（20261017 首跑实测修正）：`talk` 的
-- `created_at` / `updated_at` 在 `0000_base_schema.sql` 里是裸的 `datetime NOT NULL`
-- ——本仓其余多数表那一列带着 `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`，
-- 这一张**不带**，两个时刻由 Rust 写时显式赋值。所以这句 UPDATE **不会**顺带把
-- `updated_at` 推到现在（首跑回读逐字印证：改前改后都是 `2026-10-01 02:44:15`）。
-- 也**不手工写它**：它记的是"这一行最近被业务动作动过是什么时候"，拿它去记"夹具什么时候
-- 被复位过"是两件事，抹平它只会让前一件事变模糊。要查复位时刻看 `migration_flags.applied_at`。
UPDATE talk
   SET approved      = 0,
       ai_result     = NULL,
       ai_reason     = NULL,
       reject_reason = NULL
 WHERE content LIKE 'agent\_fixture\_%'
   AND approved <> 0;

-- ── ③ 回读：确认**恰好一行**、字段如预期 ────────────────────────────────────
-- 期望：1 行，approved = 0，三个审核列都是 NULL，must_be_1 = 1。
SELECT 'fixture' AS done, id, approved, src, user_id, author,
       ai_result, ai_reason, reject_reason, created_at, updated_at,
       (SELECT COUNT(*) FROM talk WHERE content LIKE 'agent\_fixture\_%') AS must_be_1
  FROM talk WHERE content LIKE 'agent\_fixture\_%';

-- ── ④ 写后复核：这一行**真的能被后台接口看到、且是待审态** ──────────────────
-- 用例的台账帧读的是 `GET /api/protect/board`（`tools/base._board_index`），所以"在位"
-- 的定义就是**那个接口读得到它、且 approved = 0**。SQL 里读不到 HTTP，这一条用一枚
-- **只读的管理员令牌**验：
--   `GOLDEN_ADMIN_UID=756 .venv/bin/python eval/golden_fixture_board.py --verify`
-- （跑在 agent 仓；夹具闸那一路是 `golden_fixture.gate(cases)`，逐族判 present/wrong_state。）
-- ⚠️ 库里改对了、闸仍判 wrong_state ⇒ 先查身份与路由（管理员 uid 今天还通不通），
--    不要改用例去迁就。

-- ── ⑤ 登记 flag（**不参与幂等**，只记"本文件被应用过至少一次"）────────────────
-- 同其余夹具文件：真正的门是 §② 的 `approved <> 0` 与用例侧的夹具在位检查，flag 不参与
-- 判断（否则"用例复核掉它之后想复位"这条正常循环会静默不动）。
INSERT INTO migration_flags (flag_name)
SELECT 'golden_board_fixture_reset_20261017'
 WHERE NOT EXISTS (SELECT 1 FROM migration_flags
                    WHERE flag_name = 'golden_board_fixture_reset_20261017');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'golden_board_fixture_reset_20261017';

-- ── 回滚（如需）：把 approved 填回 2（§① 第二句已经把当时的三个审核列印在记录里，
--    要还原成"驳回过"的原样就照它填回；只填 approved 会得到一条没有理由的驳回行）──
--   UPDATE talk SET approved = 2 WHERE content LIKE 'agent\_fixture\_%';
-- 行本身**不要**顺手删（删了就是"行不在"那一态，得重跑 20260930 那份重建、且 id 会变）。
--
-- ── 已知副作用（先知道再落地）──────────────────────────────────────────────
--   · 这一行会**重新出现在后台待审队列里**（本机即生产，那是主人自己在看的清单）。
--     它正文里写着「评测夹具，用后即删」，是刻意让人一眼认出来的。
--   · 它**不**出现在公开面任何地方（公开池恒 `approved = 1`，待审行不在其中）——
--     这正是 `admin_board_identity_from_roster` 那条判据成立的原因。
--   · `created_at` / `updated_at` **两个都保持原值**（首跑实测：`2026-10-01 02:15:17` /
--     `02:44:15` 一字未动——本表那两列不带 ON UPDATE，见 §② 的注）。这一趟真正改动的
--     只有 `approved` 一列（2 → 0）；`ai_result` / `ai_reason` / `reject_reason` 首跑前
--     就已经全是 NULL（§① 的 `before` 行留了证），所以"清回 NULL"这一步实际是空写。
