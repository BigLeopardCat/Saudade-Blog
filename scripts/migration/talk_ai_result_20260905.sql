USE saudade_blog;
ALTER TABLE `talk`
    ADD COLUMN `ai_result` varchar(8) DEFAULT NULL
        COMMENT 'AI审核判定: pass=通过 flag=拦截 NULL=未审(不回溯存量)'
        AFTER `approved`;

INSERT INTO migration_flags (flag_name) VALUES ('talk_ai_result_20260905');
