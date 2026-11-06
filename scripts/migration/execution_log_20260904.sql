-- flag: chat_exec_log_20260904（migration_flags 最后插入，勿重跑）
CREATE TABLE IF NOT EXISTS execution_log (
  id int NOT NULL AUTO_INCREMENT,
  user_id int NOT NULL,
  conversation_id int NOT NULL,
  -- 技能名（navigate/effect/darkmode/device_display/device_query/content_query…）
  skill varchar(32) NOT NULL DEFAULT '',
  -- 渲染后存储（写时一次定稿，读时零映射）：动作词 + 「」内容，≤300 字
  detail varchar(300) NOT NULL DEFAULT '',
  created_at datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_conv_id (conversation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 校验门：表结构就位
SELECT 'done' AS done, TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'execution_log';

INSERT INTO migration_flags (flag_name) VALUES ('chat_exec_log_20260904');
SELECT 'flag' AS done, flag_name, applied_at FROM migration_flags WHERE flag_name = 'chat_exec_log_20260904';
