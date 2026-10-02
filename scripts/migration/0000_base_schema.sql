USE saudade_blog;
-- =============================================================================
-- 基架（第 0 号）：26 张表的建表语句 —— **从零建库的第一块积木**
--
-- 为什么在仓库里：`scripts/migration/` 下其余 35 个文件**全是增量 ALTER**
-- （加列/加索引/回填），每一个都假定这些表已经存在。没有这一份，照 CONTRIBUTING
-- 的建库步骤走到一半就会撞上"Table 'saudade_blog.note' doesn't exist"。
--
-- 从哪来：20261001 在生产库上 `mysqldump --no-data` 导出，**只取结构、零行数据**。
-- 表选项里的 `AUTO_INCREMENT=<起始值>` 已全部脱掉（那是"这张表被写过多少行"的
-- 数据痕迹，不是结构）；索引、外键、列注释、字符集与排序规则原样保留。
--
-- 验证到什么程度（20261001）：26 张表的建表语句与线上 `SHOW CREATE TABLE` **逐字
-- 一致**（只差上面说的 AUTO_INCREMENT 起始值），线上 26 张表一张不漏、也没有多出来的。
-- **"倒进一个空库真跑一遍"这一步没做** —— 导出用的那个账号没有 CREATE DATABASE
-- 权限，本机又不允许为验证另建一个库。第一次真跑会发生在贡献者的空库上；
-- 万一出错，多半是外键顺序问题，而文件开头的 `FOREIGN_KEY_CHECKS=0` 正是为它准备的。
--
-- 幂等：每张表都是 `CREATE TABLE IF NOT EXISTS`，**没有 DROP**。已有数据的库上跑
-- 它是彻底的 no-op（不会碰你一行数据、也不会报错）；新库上跑它就是建表。
--
-- 顺序：文件名以 `0000_` 开头，`ls scripts/migration/*.sql | sort` 下必然排第一。
-- **其余迁移都假定这些表已存在**，所以顺序不能动 —— 这里改成别的名字，
-- `agent_task_20260927.sql` 会先跑并在 `ALTER TABLE agent_task` 上失败。
--
-- 依赖：**MySQL 8**。多数表是 `utf8mb4_0900_ai_ci`（8.0 才有的排序规则），
-- 少数老表还是 `utf8mb4_unicode_ci`（历史遗留，别顺手统一 —— 那会改变
-- 已有库上一次排序的语义，属于另一件事）。
--
-- ⚠️ 改这个文件时：**别直接在这儿加新表/新列**，那是 `scripts/migration/` 里增量
-- 迁移的活。这里只该在"整份结构重新导出"时整体替换。
-- =============================================================================

/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `agent_task` (
  `id` int NOT NULL AUTO_INCREMENT,
  `task_id` varchar(64) NOT NULL COMMENT '系统生成的对外任务 id（at_+8位十六进制，跨语言契约）',
  `conversation_id` int NOT NULL COMMENT '所属会话（读取/级联删按会话隔离）',
  `user_id` int NOT NULL COMMENT '会话主人 uid（不参与展示）',
  `goal` varchar(300) NOT NULL DEFAULT '' COMMENT '目标的人读表述（写时定稿；来源=主人原话）',
  `steps` text COMMENT '剩余步骤（JSON 数组，每步 {label,skill,params}；Rust 只做透传不解析）',
  `total_steps` int NOT NULL DEFAULT '0' COMMENT '登记时的总步数（进度展示用，登记后不再变）',
  `cursor` int NOT NULL DEFAULT '0' COMMENT '已推进步数（0..total_steps；与 steps 的下标语义由 agent 定义）',
  `state` varchar(24) NOT NULL DEFAULT 'submitted' COMMENT 'submitted/running/input_required/succeeded/failed/cancelled',
  `pending_question` varchar(300) NOT NULL DEFAULT '' COMMENT 'input_required 时要问主人的那句（下一轮原样回放，不由模型重编）',
  `idempotency_key` varchar(80) DEFAULT NULL COMMENT '幂等键（会话+归一化目标+步骤集合；NULL 可重复，空串只能一行故不给默认值）',
  `attempts` int NOT NULL DEFAULT '0' COMMENT '推进次数（同一轮反复推进同一行时可见）',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_at_task` (`task_id`),
  UNIQUE KEY `uk_at_idem` (`idempotency_key`),
  KEY `idx_at_conv_state` (`conversation_id`,`state`,`id`),
  KEY `idx_at_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='会话级任务状态：未完成的意图（与 execution_log 对偶）';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `announcement` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `content` text NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `category` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `introduce` varchar(255) DEFAULT NULL,
  `path_name` varchar(255) DEFAULT NULL,
  `icon` varchar(255) DEFAULT NULL,
  `color` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `chat_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `conversation_id` int NOT NULL,
  `role` varchar(20) NOT NULL DEFAULT 'user',
  `content` text NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_user_time` (`user_id`,`created_at`),
  KEY `idx_conv_id` (`conversation_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `chat_summary` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `conversation_id` int NOT NULL,
  `summary` text NOT NULL,
  `message_count` int NOT NULL DEFAULT '0',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_conversation` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `conversation` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `title` varchar(64) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `pinned` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_user_updated` (`user_id`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `dashboard_todo` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '待办的主人（后台仅管理员，仍按 uid 过滤）',
  `sort_order` int NOT NULL DEFAULT '0' COMMENT '列表里的位次（0 起，由前端数组下标决定）',
  `text` varchar(200) NOT NULL COMMENT '待办正文（已 trim，空行不落库）',
  `done` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否已完成',
  `due_date` date DEFAULT NULL COMMENT '排期那天；NULL = 未排期',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  KEY `idx_dt_user_sort` (`user_id`,`sort_order`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `execution_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `conversation_id` int NOT NULL,
  `skill` varchar(32) NOT NULL DEFAULT '',
  `tool` varchar(64) DEFAULT NULL COMMENT '工具名（结构化动作本体；skill 是技能，一个技能可含多个工具）',
  `payload` longtext COMMENT '回执原文 JSON 文本（skill/tool/args/result/ts + cmd/digest/title/审计 meta）；NULL=结构化之前的存量行',
  `detail` varchar(300) NOT NULL DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_conv_id` (`conversation_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `friend` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `link` varchar(255) NOT NULL,
  `avatar` varchar(255) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `status` int DEFAULT '1',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `images` (
  `image_key` int NOT NULL AUTO_INCREMENT,
  `image_url` varchar(255) NOT NULL,
  PRIMARY KEY (`image_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `knowledge_base` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `content` text NOT NULL,
  `category` varchar(100) DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  FULLTEXT KEY `idx_search` (`title`,`content`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `migration_flags` (
  `flag_name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `applied_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`flag_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `note` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `content` text NOT NULL,
  `description` text,
  `cover` varchar(255) DEFAULT NULL,
  `is_top` int DEFAULT '0',
  `status` varchar(50) DEFAULT 'published',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `is_public` tinyint(1) NOT NULL DEFAULT '1',
  `category_id` int DEFAULT NULL,
  `tags` text,
  `cover_focus_x` double DEFAULT NULL COMMENT '封面焦点X(0..1归一化, 0.5=居中; NULL=未设置按居中)',
  `cover_focus_y` double DEFAULT NULL COMMENT '封面焦点Y(0..1归一化, 0.5=居中; NULL=未设置按居中)',
  `cover_zoom` double DEFAULT NULL COMMENT '封面额外缩放倍数(1..4, 1=不额外放大; NULL=未设置)',
  `carousel_focus_x` double DEFAULT NULL COMMENT '置顶轮播焦点X(0..1归一化, 0.5=居中; NULL=未设置回退跟随 cover_focus_x)',
  `carousel_focus_y` double DEFAULT NULL COMMENT '置顶轮播焦点Y(0..1归一化, 0.5=居中; NULL=未设置回退跟随 cover_focus_y)',
  `carousel_zoom` double DEFAULT NULL COMMENT '置顶轮播额外缩放倍数(1..4; NULL=未设置回退跟随 cover_zoom)',
  `draft_of` int DEFAULT NULL COMMENT '编辑修改稿：指向被编辑的原文章 id；NULL=普通文章/独立草稿',
  `user_id` int DEFAULT NULL COMMENT '发布者 user.id；NULL = 未记录（老文章或账号已销）⇒ 展示端回退站点级署名',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_note_draft_of` (`draft_of`),
  KEY `category_id` (`category_id`),
  CONSTRAINT `note_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `category` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `note_like` (
  `id` int NOT NULL AUTO_INCREMENT,
  `note_id` int NOT NULL COMMENT '被点赞的文章 note.id',
  `user_id` int DEFAULT NULL COMMENT '点赞的账号（登录用户）；匿名为 NULL',
  `visitor_key` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '匿名访客标识（浏览器生成、随 X-Visitor-Key 上报）；登录行为 NULL',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_like_note_user` (`note_id`,`user_id`),
  UNIQUE KEY `uq_like_note_visitor` (`note_id`,`visitor_key`),
  KEY `idx_like_note` (`note_id`),
  KEY `fk_like_user` (`user_id`),
  CONSTRAINT `fk_like_note` FOREIGN KEY (`note_id`) REFERENCES `note` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_like_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `note_view` (
  `id` int NOT NULL AUTO_INCREMENT,
  `note_id` int NOT NULL COMMENT '被阅读的文章 note.id',
  `view_date` date NOT NULL COMMENT '统计日（服务端 +08:00 本地钟面取日）',
  `cnt` int NOT NULL DEFAULT '0' COMMENT '这一天该文章的阅读次数（同一访客同一天只计一次，去重在前端）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_view_note_date` (`note_id`,`view_date`),
  KEY `idx_view_date` (`view_date`),
  CONSTRAINT `fk_view_note` FOREIGN KEY (`note_id`) REFERENCES `note` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `pending_action` (
  `id` int NOT NULL AUTO_INCREMENT,
  `task_id` varchar(64) NOT NULL DEFAULT '' COMMENT '系统生成的待办 id',
  `conversation_id` int NOT NULL COMMENT '所属会话（读取/关闭/清理按会话隔离）',
  `user_id` int NOT NULL COMMENT '会话主人 uid（不参与展示）',
  `skill` varchar(32) NOT NULL DEFAULT '' COMMENT '技能名',
  `tool` varchar(255) NOT NULL DEFAULT '' COMMENT '工具体（逗号分隔；回执关闭的判据）',
  `args` text COMMENT '结构化参数（specs 的 JSON，审计线索；超 4000 字符只存前缀）',
  `target` varchar(300) NOT NULL DEFAULT '' COMMENT '写时定稿的人读目标+动作（与确认弹窗同源）',
  `question` varchar(500) NOT NULL DEFAULT '' COMMENT '确认卡片问句（与弹窗同源，写时定稿；空串=这张卡片不可重建）',
  `options` varchar(600) NOT NULL DEFAULT '' COMMENT '选项 JSON（label/value/kind；前端不自己造按钮）',
  `jti` varchar(64) NOT NULL DEFAULT '' COMMENT '令牌 id（签在令牌里）——原子核销的键',
  `expires_at` datetime DEFAULT NULL COMMENT '令牌到期时刻（取自令牌自身 exp，展示/过滤用；验签才是唯一凭据）',
  `claimed_at` datetime DEFAULT NULL COMMENT '被认领时刻；NULL=还没被用掉（一次性核销的判据）',
  `requested_by` varchar(32) NOT NULL DEFAULT 'user' COMMENT 'user=主人本轮提出 / system=系统事件自我提出',
  `source_event` varchar(64) NOT NULL DEFAULT '' COMMENT '具体来源（confirm_popup…）',
  `confirmation_required` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否需要主人点头',
  `confirmation_status` varchar(24) NOT NULL DEFAULT 'awaiting' COMMENT 'awaiting/confirmed/expired',
  `status` varchar(24) NOT NULL DEFAULT 'pending' COMMENT 'pending/done/superseded/cancelled',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  KEY `idx_pa_conv_status` (`conversation_id`,`status`,`id`),
  KEY `idx_pa_task` (`task_id`),
  KEY `idx_pa_jti_claim` (`jti`,`claimed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `quota_request` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '申请人（无外键，见头注 ④）',
  `reason` text COMMENT '申请理由（可空；前端与 agent 工具都提示填写，后端不硬闸）',
  `status` tinyint(1) NOT NULL DEFAULT '0' COMMENT '0=待处理 / 1=已批准 / 2=已驳回（三值，见头注 ②）',
  `note` varchar(255) DEFAULT NULL COMMENT '管理员驳回理由（批准时为 NULL）；写入上限见调用侧的 500 字校验',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  `handled_at` datetime DEFAULT NULL COMMENT '处理时间（未处理为 NULL）',
  `handled_by` int DEFAULT NULL COMMENT '处理人 uid（无外键；管理员主动重置不产生本表行）',
  PRIMARY KEY (`id`),
  KEY `idx_qr_status` (`status`,`id`),
  KEY `idx_qr_user` (`user_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `tag_one` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `level` int DEFAULT NULL,
  `color` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `tag_two` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `level` int DEFAULT NULL,
  `color` varchar(50) DEFAULT NULL,
  `tag_one_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `tag_one_id` (`tag_one_id`),
  CONSTRAINT `tag_two_ibfk_1` FOREIGN KEY (`tag_one_id`) REFERENCES `tag_one` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `talk` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) DEFAULT NULL,
  `content` text NOT NULL,
  `cat` varchar(8) NOT NULL DEFAULT '愿',
  `v` tinyint NOT NULL DEFAULT '0',
  `author` varchar(64) NOT NULL DEFAULT '',
  `user_id` int NOT NULL DEFAULT '0',
  `src` varchar(10) NOT NULL DEFAULT 'talk',
  `approved` tinyint NOT NULL DEFAULT '1',
  `ai_result` varchar(8) DEFAULT NULL COMMENT 'AI审核判定: pass=通过 flag=拦截 NULL=未审(不回溯存量)',
  `reject_reason` varchar(200) DEFAULT NULL COMMENT '驳回理由: AI 判定说明或管理员手填；改判通过时清空',
  `ai_reason` varchar(200) DEFAULT NULL COMMENT 'AI 审核说明(所有裁决都留痕); 人工未填驳回理由时回落到它',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_talk_src_appr_created` (`src`,`approved`,`created_at`),
  KEY `idx_talk_src_user_created` (`src`,`user_id`,`created_at`),
  KEY `idx_talk_src_created` (`src`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `user` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  `nickname` varchar(64) NOT NULL DEFAULT '',
  `avatar` varchar(255) DEFAULT NULL COMMENT '头像 URL（裁切后上传产出的站内路径）',
  `password` varchar(255) NOT NULL,
  `role` varchar(50) NOT NULL DEFAULT 'user',
  `status` tinyint(1) NOT NULL DEFAULT '0' COMMENT '0=正常 / 1=冻结（其余值按冻结处理）；冻结即拒登录并作废已签发令牌',
  `token_version` int NOT NULL DEFAULT '0' COMMENT '令牌代次（只增不减）；改密码/管理员重置/冻结时 +1，作废此前签发的全部令牌',
  `chat_quota_used` int NOT NULL DEFAULT '0' COMMENT '终身对话额度已用轮数（每轮 1；确认轮不计；管理员恒不增长）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `user_favorite` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '收藏者',
  `note_id` int NOT NULL COMMENT '被收藏的文章 note.id',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_favorite_user_note` (`user_id`,`note_id`),
  KEY `idx_favorite_note` (`note_id`),
  CONSTRAINT `fk_favorite_note` FOREIGN KEY (`note_id`) REFERENCES `note` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_favorite_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `user_message` (
  `id` int NOT NULL AUTO_INCREMENT,
  `from_user_id` int NOT NULL,
  `to_user_id` int NOT NULL,
  `title` varchar(60) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '信件标题（选填，20260922 起；历史行全为 NULL）',
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT '0',
  `read_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  KEY `idx_message_to_read_created` (`to_user_id`,`is_read`,`created_at`),
  KEY `idx_message_pair_created` (`from_user_id`,`to_user_id`,`created_at`),
  CONSTRAINT `fk_message_from` FOREIGN KEY (`from_user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_message_to` FOREIGN KEY (`to_user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `user_message_draft` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '草稿主人',
  `to_username` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '收件人原文（账号或 UID，发送时才解析）',
  `title` varchar(60) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '信件标题（与 user_message.title 同长度）',
  `content` text COLLATE utf8mb4_unicode_ci COMMENT '正文（上限 500 字在应用层校验，与 user_message 同口径）',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  KEY `idx_draft_user_updated` (`user_id`,`updated_at`),
  CONSTRAINT `fk_draft_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `user_notification` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '收件人',
  `type` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'announcement=站内公告 / notice=站内通知（留接口）',
  `title` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci,
  `link` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '站内路径（点通知跳过去），NULL = 纯文本通知',
  `is_read` tinyint(1) NOT NULL DEFAULT '0' COMMENT '头像红点/未读数按它统计',
  `read_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '+08:00 本地钟面',
  PRIMARY KEY (`id`),
  KEY `idx_notification_user_read_created` (`user_id`,`is_read`,`created_at`),
  CONSTRAINT `fk_notification_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE IF NOT EXISTS `web_info` (
  `id` int NOT NULL AUTO_INCREMENT,
  `key_name` varchar(255) NOT NULL,
  `value` text,
  PRIMARY KEY (`id`),
  UNIQUE KEY `key_name` (`key_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

