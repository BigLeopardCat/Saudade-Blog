USE saudade_blog;
-- 20260905 后台审核双状态显示（issue9）：talk 表补 ai_result 列，持久化 AI 审核判定。
-- 背景：20260905 留言审核上线后，AI 判定只即时决定 approved（pass→1 / flag→0）不留痕，
-- 后台只能看到人工侧结果，无法区分「AI 拦截→人工放行/驳回」与「未走 AI 直接通过」。
-- 分列存储：
--   人工侧 approved : 0=待审 / 1=通过（公开列表只放行 1）/ 2=未通过（驳回，issue8 起）
--   AI 侧 ai_result  : 'pass'=AI 通过 / 'flag'=AI 拦截转人工裁决 /
--                      NULL=未审（AI 审核关、人工全审模式 manual_on 不调 AI、
--                      agent 不可用降级放行、以及存量历史行——不回溯）
-- 展示语义（BoardManage 两段状态列）：AI 拦截 + 人工通过 = 完整双段；NULL 显示「未审」。
ALTER TABLE `talk`
    ADD COLUMN `ai_result` varchar(8) DEFAULT NULL
        COMMENT 'AI审核判定: pass=通过 flag=拦截 NULL=未审(不回溯存量)'
        AFTER `approved`;

INSERT INTO migration_flags (flag_name) VALUES ('talk_ai_result_20260905');
