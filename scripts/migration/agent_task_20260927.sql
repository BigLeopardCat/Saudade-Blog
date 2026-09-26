USE memory_blog;
-- =============================================================================
-- 会话级任务状态（20260927）：agent_task 表
--
-- 背景（批 B 五档对照实测出来的那个洞）：agent 缺一个「**要做完什么**」的载体。
--   · 已发生事实有系统载体：execution_log（checker 验收回执，跨轮注入 recent_executions）；
--   · **未完成的意图没有任何载体**——剩余步骤只活在当轮 `state["plan"]` 里，
--     那一轮结束即蒸发。于是下一轮的 planner 只能回对话历史里重新猜"主人一共要几件事"，
--     而它只看得见**这一轮**该做什么。
-- 现场实证两处，都指向同一个缺口：
--   ① 多步目标只走第一步——原话「带我过去后开启一个特效」，轮 0 导航完成后**直接 chat 收尾**，
--      第二步从未被规划。第二步的宾语"一个特效"未具名，模型没有一个地方能承载
--      "这件事还欠着、我需要先问主人是哪个" ⇒ 它只能丢掉。批 B 五档 3 次复跑里，
--      剩下的红**只剩这一族**（`multi_step` 4 条）。
--   ② 模型自己写过 TODO 却无人消费——trace 20260927T011952 里模型输出 `TODO: 开启特效`，
--      提示词在教它写，而消费者只有 trace 记录：**有写无读**。
-- 本表 = 意图的**结构化载体**，与 execution_log 构成对偶：
--   execution_log 答「做了什么」，agent_task 答「还剩什么要做完」。
--
-- 为什么不复用 pending_action（两条可判定的理由，不是口味问题）：
--   1. **读取端会互相污染**：chat.rs 的 prepare_chat 按 `conversation_id + status='pending'`
--      读"本会话最新一条跨轮待办"注入 planner。任务行混进同一张表，那段注入的判据就
--      从"最新一条待确认动作"**静默**变成"最新一条待确认动作或任务"；
--   2. **一次装的东西不同**：pending_action 一次只装**一个动作**（skill 单值、分钟级、
--      主人点头即关）；任务装**一串步骤**（steps JSON）、跨多轮、缺参时挂着等。
-- 两表的生命周期与写入端都不同 ⇒ 分表。
--
-- 三端链路（跨语言契约，改一处必须同步另外两处）：
--   agent：planner 决策轮认定"这一轮做不完"（还有剩余步骤 / 某步缺参数要问主人）时，
--     随该轮一起发 `__TASK__:{json}` 帧（server.py；字段与列一一对应），
--     同一 task_id 重复发 = 更新（推进 cursor / 改 state），不是新建；
--   Rust：在 SSE 帧解析的 JSON 文本分支**之前**拦下（与 `__EXEC__` / `__PENDING__` 同族）：
--     **收到即落库、绝不转发前端**（前端无此帧协议，透传会被当正文渲染），
--     落库失败只记一行 WARNING、不影响本轮对话；
--   Rust：prepare_chat 读**本会话全部未完结任务**（state ∉ 终态）→ body 的
--     `agent_tasks` 字段 → agent 注入 system 上下文给 planner。
--
-- 状态机（六态；写入方都是 agent，终态由**系统事实**收口）：
--   submitted → running → succeeded / failed / cancelled
--                     ↘ input_required（缺参数，挂起等主人回答，**不消失**）
--   · `input_required` 是本表存在的核心理由：缺参时**保留目标**并把要问的那句原样存下来，
--     下一轮原样回放给 planner（`pending_question` 逐字复用，不由模型重编）；
--   · `succeeded` / `failed` / `cancelled` 为终态，不再注入 planner；
--   · planner 只被允许推进**本会话未完结的**任务行（task_id 由系统给出，模型不自造）。
--
-- 为什么"意图"可以由 agent 自报、"事实"不行（与 mainline 那句「服务端记录不许模型自报」不冲突）：
--   已经发生的事实由 checker 回执认定（execution_log，模型说了不算）；
--   而"主人一共要几件事、还差哪一步"只有 planner 的决策里才有这个信息，
--   没有任何下游能推导出来 ⇒ 它由 agent 提出、由 Rust 持久化、由下一轮的执行回执证实或证伪。
--
-- 幂等与限额（都在读侧或唯一键，不靠模型自觉）：
--   · `idempotency_key`（agent 计算：**会话 + 归一化目标**）唯一键 + **可空**
--     ——MySQL 唯一索引允许多个 NULL，故不给 DEFAULT ''（空串只能存在一行）；
--     ⚠️ 步骤**刻意不进键**（下方 20260927 补记有理由：撤下走的是同一个目标）；
--   · 同一会话未完结任务**读侧**最多注入 3 条（最新优先），与 execution_log
--     "去重与时间戳都在读侧"同一条纪律：存量行无需迁移；
--   · `task_id` 唯一键（系统生成 `at_` + 8 位十六进制；不复用 DB 自增 id 做对外标识，
--     避免把可枚举的序号暴露给模型——同族教训见 id 不带来源那条）。
--
-- 已知缺口（如实记，不装作没有）：
--   · 主人中途改主意（"算了别开了"）目前只能靠下一轮 planner 判定后发 `__TASK__`
--     改 state='cancelled'；没有独立的取消通道；
--   · `/chat` 非流式路径不发帧 ⇒ 不落任务；前端走的一直是 `/chat/stream`；
--   · 刻意不加 `requested_by`（pending_action 有它是为了区分"系统事件自我提出"；
--     任务当前只有主人提出这一种来源，等真出现系统自发任务再加列）。
--
-- 开关（代码侧，与本迁移无关）：`AGENT_TASK_STATE` 默认 **off** ⇒ 本表落库先于启用，
-- 代码上线后线上行为逐字节不变，由 flag 决定是否开始登记/注入。
--
-- 幂等与执行前提：
--   · CREATE TABLE IF NOT EXISTS：重复执行安全；新表此刻必然 0 行，不锁表；
--   · 纯结构变更，零数据回填；
--   · **迁移没跑不许推送**（Rust 一上线就会读写它；读写失败按"无任务"降级，
--     但那正是本表要治的那个洞，等于功能静默不生效）。
-- flag: agent_task_20260927（migration_flags，勿重跑）
-- =============================================================================

CREATE TABLE IF NOT EXISTS `agent_task` (
    `id`                int NOT NULL AUTO_INCREMENT,
    `task_id`           varchar(64) NOT NULL COMMENT '系统生成的对外任务 id（at_+8位十六进制，跨语言契约）',
    `conversation_id`   int NOT NULL COMMENT '所属会话（读取/级联删按会话隔离）',
    `user_id`           int NOT NULL COMMENT '会话主人 uid（不参与展示）',
    `goal`              varchar(300) NOT NULL DEFAULT '' COMMENT '目标的人读表述（写时定稿；来源=主人原话）',
    `steps`             text NULL COMMENT '剩余步骤（JSON 数组，每步 {label,tool}；形状由 agent 定义，Rust 只做透传不解析）',
    `total_steps`       int NOT NULL DEFAULT 0 COMMENT '登记时的总步数（进度展示用，登记后不再变）',
    `cursor`            int NOT NULL DEFAULT 0 COMMENT '已推进步数（0..total_steps；与 steps 的下标语义由 agent 定义）',
    `state`             varchar(24) NOT NULL DEFAULT 'submitted' COMMENT 'submitted/running/input_required/succeeded/failed/cancelled',
    `pending_question`  varchar(300) NOT NULL DEFAULT '' COMMENT 'input_required 时要问主人的那句（下一轮原样回放，不由模型重编）',
    `idempotency_key`   varchar(80) DEFAULT NULL COMMENT '幂等键（会话+归一化目标+步骤集合；NULL 可重复，空串只能一行故不给默认值）',
    `attempts`          int NOT NULL DEFAULT 0 COMMENT '推进次数（同一轮反复推进同一行时可见）',
    `created_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    `updated_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_at_task` (`task_id`),
    UNIQUE KEY `uk_at_idem` (`idempotency_key`),
    KEY `idx_at_conv_state` (`conversation_id`, `state`, `id`),
    KEY `idx_at_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='会话级任务状态：未完成的意图（与 execution_log 对偶）';

-- 应用后自检：表在不在、列齐不齐、此刻有几行（预期 0）
SELECT '表已存在' AS done, TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'agent_task';

SELECT '列清单' AS done, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'agent_task'
ORDER BY ORDINAL_POSITION;

SELECT '索引清单' AS done, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, NON_UNIQUE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'memory_blog' AND TABLE_NAME = 'agent_task'
GROUP BY INDEX_NAME, NON_UNIQUE;

SELECT '当前行数（预期 0）' AS done, COUNT(*) AS 任务行数 FROM `agent_task`;

INSERT INTO migration_flags (flag_name) VALUES ('agent_task_20260927');

SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags
WHERE flag_name = 'agent_task_20260927';

-- 回滚（本次没有历史数据依赖，回滚即删表；若届时已有未完结任务请先导出）：
--   DROP TABLE `agent_task`;
--   DELETE FROM migration_flags WHERE flag_name = 'agent_task_20260927';

-- =============================================================================
-- 20260927 补记（迁移**已执行**之后补的，代码侧定稿时对齐）
--
-- 表结构、索引、flag 一字未改，**本文件不重跑**。补记的是三件头注里写粗了、
-- 或实现时被证据改掉的事——按实际落地的样子记，不按当初的设想记。
--
-- ① 幂等键**不含步骤集合**（头注原文是"会话 + 归一化目标 + 步骤集合"，已就地更正）。
--    改掉的理由是一个会被踩到的洞：撤下这件事走的也是同一个目标（见 ④），若步骤进键，
--    撤下声明会算出**另一个键** ⇒ 长出第二行，而原来那行永远挂在"未完结"里——
--    也就是说"取消"这个功能会以"多出一条幽灵任务"的形式失败。
--    键 = `tk_` + sha1(`c{会话}|g{目标指纹}`)[:40]，指纹先抹空白与标点再小写
--    （主人复述一次、多一个句号，不该长出一行新任务）。
--
-- ② **写入方是模型的一次显式声明**，不是确定性扫描器（头注没写这一层）。
--    扫描器（`decisions.py::_scan_action_intents`）只认**具名别名**，而本表要治的那个
--    现场故障里，第二步的宾语恰恰是**未具名指称**（「开启一个特效」）⇒ 结构上扫不出来。
--    落地形态：native 档的 `tools` 数组里多一个伪函数 `task_hold`（**不是技能**：
--    `SKILLS` 里没有它、`instantiate_plan` 也不认它），模型调用它给出
--    `{goal, steps:[{label,tool}], pending_question}`；`tool` 的闭集 = 该身份可见技能
--    模板里的工具 ∪ 点名白名单（**不是**全量注册表——闭集里不许出现模型够不到的名字）。
--    这不违反「服务端记录不许模型自报」：那条管的是**已发生的事实**（由 checker 回执认定），
--    而"主人一共要几件事、还差哪一步"只存在于 planner 的决策里，没有任何下游推得出来。
--
-- ③ **结算（推进/收口）由 producer 在流尾按回执确定性完成**，不在 planner、也不在 Rust。
--    判据 = 本轮的 PASS 回执里出现过该步骤声明的工具（**工具粒度，不看参数**——
--    主人手动换了别的特效也会把该步算作完成；粗但确定，比"模型自称做完了"可信）。
--    从当前游标**连续**推进、不跳跃；全部推完 ⇒ `succeeded`。同轮新登记的行用
--    自己的声明时刻做下界（`declared_after`），否则"先导航再登记"的那半步会被
--    自己刚执行的回执立刻算完成。模型不参与结算。
--    因此六态里 `submitted` 与 `failed` **当前没有写入方**：登记只产出
--    `running` / `input_required`，撤下产出 `cancelled`，结算产出 `succeeded`。
--    两个状态留着是因为它们是这张表语义的一部分（外部写入方随时可以出现），
--    但别按"六态都被用到"去读这张表。
--
-- ④ 撤下只有一条通道，且**不需要新字段**：用同一个 `goal`、`steps` 留空（`[]`）再登记
--    一次 ⇒ `state='cancelled'`，并把 `pending_question` 一并清空（撤下的事不该还挂着
--    一个要问的问题——那会让下一轮又把它捡起来）。空步骤是本表里"撤下"的唯一编码。
--
-- ⑤ **身份两列不在帧里**：`__TASK__` 载荷与列一一对应，**唯独不带 `user_id` /
--    `conversation_id`**——Rust 落库时从**请求**取（`save_agent_task(db, uid, 会话, v)`）。
--    模型碰不到身份字段，这一条是结构性的，不是靠它自觉。
--
-- ⑥ 读侧时效 = 72 小时（`chat.rs::TASK_READ_TTL_HOURS`），**单执行者是 Rust**：
--    Python 侧刻意不再判一次（那要解析 `created_at` 的钟面格式，解析失败在注入侧的
--    后果是整块静默消失）。上限 3 条同理落在 SQL 的 `limit` 里，先取再筛会让已完结的
--    行把窗口吃掉。两条都是"限额与裁剪都在读侧"这条既有纪律的延续。
--
-- ⑦ 本文件在跑完之后改过两处**注释文案**（`steps` 形状 `{label,tool}`、幂等键口径），
--    库里那两处列 COMMENT 仍是旧文案。**表结构/索引/列一字未改**，故不重跑：
--    重跑不会生效（`IF NOT EXISTS` + flag），改注释只能走 `ALTER TABLE ... MODIFY`，
--    为零信息量的差异去动生产表不划算。以本文件为准。
-- =============================================================================
