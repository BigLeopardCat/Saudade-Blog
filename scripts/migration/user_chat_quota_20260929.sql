USE saudade_blog;
-- =============================================================================
-- 用户对话额度（20260929）：user.chat_quota_used + quota_request 表
--
-- 为什么要有它（用户原话）：「用户增加额度控制，个人中心可以申请重置和查看。每个
-- 普通用户 500 轮对话额度包含 embedding 的检索，管理员不设限。可以在后台管理面板
-- 重置。agent 可以感知对话额度。agent 可以替管理员操作是否批准或者主动重置对话
-- 额度。对于申请额度信息，会像评论待审一样出现在日程面板。」
--
-- 口径（用户逐条拍板，实现不许再改）：
--   · **终身 500 轮**，没有月度/日度周期、没有定时重置；唯一恢复途径 = 管理员清零
--     （用户提交申请 → 管理员批准，或管理员直接重置）；
--   · 计数器**每轮 +1，检索轮不豁免**（embedding 的检索也算一轮）；
--   · **确认轮不计**：主人点一次确认卡不是新的一轮对话（闸门落在 `is_confirm` 之后，
--     见 `src/routes/chat.rs`——位置本身就是判据，早几行落会让每次点确认都烧掉一轮）；
--   · 管理员不增长（`can_access_console` = admin + superadmin 恒不计数）；
--   · 用尽 = **硬拦**：那一轮零 LLM、零工具、**不计数**，但**照常进对话记录**
--     （用户拍板：额度管"能不能用"，记录管"发生过什么"）。
--   判据收敛在 `src/quota.rs` 一处，Rust 侧不散落第二份角色比较或第二份上限。
--
-- ── 列与表的语义 ────────────────────────────────────────────────────────────
--   user.chat_quota_used: 已用轮数，只增。**唯一**的归零途径 = 管理员批准申请或
--     主动重置（`UPDATE user SET chat_quota_used = 0`）。上限不存库里，走环境变量
--     `CHAT_QUOTA_LIMIT`（默认 500）——上限是策略、用量是事实，两者生命周期不同：
--     改上限不该需要一次迁移（与 `CHAT_HISTORY_LIMIT` 同一形态，见 chat.rs）。
--   quota_request.status: 0 = 待处理 / 1 = 已批准 / 2 = 已驳回。
--   quota_request.note:   管理员驳回理由（批准时为 NULL）。**驳回理由在库里可空、
--     在调用侧必填**（前端弹窗必填、agent 工具必填），后端只做回落链——与
--     `audit_board`（留言审核）逐条同形：它同样把"必填"留给调用方，后端在缺理由时
--     回落成 `管理员没有填写理由`，而不是拿一句空话硬闸。理由为空的后果不是数据坏，
--     是**申请人读不到为什么被拒**，所以回落链兜住它、但不假装它填了。
--
-- ── 四件必须写下来的事（承重，别删）────────────────────────────────────────
--
-- ① **零数据回填**。存量账号拿到 `chat_quota_used = 0` ⇒ 每人还剩 500 轮，
--    **上线当天没有任何人被削**。这是刻意的：一次部署不该让既有用户突然不能用。
--    本文件不含任何 UPDATE/DELETE。
--
-- ② **`status` 是三值不是二值**（对齐 `talk.approved` 的 1/0/2 先例，别压成
--    tinyint 的 0/1 布尔——那样"已驳回"与"待处理"就分不开了，而 ② / ③ 两句的
--    行为正好相反：**只有 `0 → 1` 才清零**，`0 → 2` 一个字节的额度都不动）。
--
-- ③ **"一人同时一份申请"由代码保证、不由索引保证**。MySQL 写不出部分唯一索引
--    （`UNIQUE(user_id) WHERE status=0` 这种），而 `UNIQUE(user_id, status)` 是
--    **错的约束**：它会让人永远只能有一行终态——第一次申请被驳回之后，他第二次
--    申请（status=0）合法，但第三次被驳回（又是一行 status=2）就撞唯一键了。
--    所以提交接口在插入前先查有没有 pending 行（有则回
--    `你已经有一份待处理的申请了`）。**代价如实记**：同一用户两个并发提交可能产生
--    两行 pending——管理员驳回多余的那一条即可（`review` 接口按行认领、幂等，
--    见 `src/routes/quota.rs` 的 `WHERE id=? AND status=0`）。个位数用户的站，
--    这个概率的实际值接近 0，而加错索引是每天都在付的代价。
--
-- ④ **无外键**。`user_id` / `handled_by` 只是过滤列与审计列（同 `dashboard_todo`、
--    `user_message_draft` 的既有形态）。销号时 `user` 行的删除不会带走这里的行——
--    如实记在这里，不假装有级联。查询一律带 `user_id` 过滤，不做跨表 JOIN。
--
-- 幂等与执行前提：
--   · ADD COLUMN 没有 IF NOT EXISTS（MySQL 不支持），重复执行会报
--     `Duplicate column name` ⇒ **那说明已经应用过了，停手即可**，不会改坏数据；
--     CREATE TABLE 带 IF NOT EXISTS，重复执行安全。
--   · 不锁表：`user` 表是个位数行，ADD COLUMN 是即时元数据变更，
--     且 NOT NULL + DEFAULT 0 有默认值，存量行原地补齐，不需要重建。
--   · **迁移必须先于 Rust 上线**：给 `entity/user.rs` 加了字段之后，
--     **每一处 `user::Entity::find*` 都会 SELECT 新列**（包括
--     `middleware::auth_guard` 的 `find_by_id` 与 `chat.rs` 的角色查询）——
--     列不存在不是"首页空白"，而是**全部受保护路由 500 + 每轮对话身份不明**。
--     CI 的路径过滤器不认识迁移，没人拦得住这条，只能靠纪律 + 下面的 flag 行。
--   · 反过来的顺序也有代价（agent 必须先于 Rust 上线）：agent 侧 `ChatRequest`
--     对未知字段是 pydantic v2 的 `extra="ignore"` ⇒ **旧 agent 会静默丢弃**
--     `chat_quota`/`quota_blocked`，被拦的用户会拿到一次**真正的 LLM 回答、却既不
--     计数也不拒答**。所以完整顺序是：agent → 本文件 → Rust + 前端。
-- flag: user_chat_quota_20260929（migration_flags，勿重跑）
-- 执行前请按既有约定说清「库名 + 迁移文件」；本文件写好了也不代表可以跑。
-- =============================================================================

-- 1) 计数器：终身已用轮数（只增；归零只有管理员那两条路）
ALTER TABLE `user`
    ADD COLUMN `chat_quota_used` int NOT NULL DEFAULT 0
        COMMENT '终身对话额度已用轮数（每轮 1；确认轮不计；管理员恒不增长）'
        AFTER `token_version`;

-- 2) 重置申请表：用户提交 → 管理员批准/驳回（驳回理由落 note）
CREATE TABLE IF NOT EXISTS `quota_request` (
    `id`         int NOT NULL AUTO_INCREMENT,
    `user_id`    int NOT NULL COMMENT '申请人（无外键，见头注 ④）',
    `reason`     text NULL COMMENT '申请理由（可空；前端与 agent 工具都提示填写，后端不硬闸）',
    `status`     tinyint(1) NOT NULL DEFAULT 0 COMMENT '0=待处理 / 1=已批准 / 2=已驳回（三值，见头注 ②）',
    `note`       varchar(255) NULL COMMENT '管理员驳回理由（批准时为 NULL）；写入上限见调用侧的 500 字校验',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `handled_at` datetime NULL COMMENT '处理时间（未处理为 NULL）',
    `handled_by` int NULL COMMENT '处理人 uid（无外键；管理员主动重置不产生本表行）',
    PRIMARY KEY (`id`),
    -- 后台队列的读取路径：管理员按状态筛（`?status=pending|all`）再按 id 倒序
    KEY `idx_qr_status` (`status`, `id`),
    -- 用户侧的读取路径：「我的最新一份申请」与提交前的 pending 预检
    KEY `idx_qr_user` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── ① 自检：列在、表在、类型与默认值对得上 ──────────────────────────────────
-- 期望：列恰好 1 行（is_nullable=NO、column_default=0、紧挨 token_version 之后）；
--       表恰好 1 行（InnoDB + utf8mb4_0900_ai_ci）。
SELECT '列已存在' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
       ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'user'
   AND COLUMN_NAME = 'chat_quota_used';

SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'quota_request';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'saudade_blog' AND TABLE_NAME = 'quota_request'
 ORDER BY ORDINAL_POSITION;

-- ── ② 存量行核对：不得出现非默认值（本文件不回填任何数据）──────────────────
-- 期望：`不是默认值的行数` = 0。**若不为 0，先停手查清是谁写的**——
-- 本文件之外没有任何代码能写出非 0 的值（只有 chat.rs 那条原子 UPDATE 会产生，
-- 而它在本次部署后才存在）。
SELECT '存量行（预期 0）' AS done,
       COUNT(*)                          AS 账号总数,
       SUM(chat_quota_used <> 0)         AS chat_quota_used_不是默认值的行数
  FROM `user`;

-- ── ③ 申请表现状（跑完本文件后随时可查这一条看现状）────────────────────────
-- 期望：此刻 0 行（新表；本文件不搬任何历史数据）。
SELECT '当前申请行数（预期 0）' AS done, COUNT(*) AS 申请行数 FROM `quota_request`;

SELECT '按状态分组（预期空）' AS done, status, COUNT(*) AS 行数
  FROM `quota_request` GROUP BY status;

INSERT INTO migration_flags (flag_name) VALUES ('user_chat_quota_20260929');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
 WHERE flag_name = 'user_chat_quota_20260929';

-- ── 回滚（如需）────────────────────────────────────────────────────────────
-- 撤列 + 删表 + 清 flag：
--   ALTER TABLE `user` DROP COLUMN `chat_quota_used`;
--   DROP TABLE `quota_request`;
--   DELETE FROM migration_flags WHERE flag_name = 'user_chat_quota_20260929';
-- ⚠️ 撤列必须与**回滚 Rust 二进制**同时做：新代码一律按这一列查 user 表，
--    列没了就是全部受保护路由 500（与"没跑迁移就推送"同一种破坏）。
-- ⚠️ 撤表会丢掉全部申请记录（含已驳回的理由）——撤回前先导一份。
-- ⚠️ 回滚**不会**把窗口期内已经耗尽的用户救回来：计数器是数据、不是代码，
--    列删掉再建回来是 0，而窗口期内的真实用量无法重建。
