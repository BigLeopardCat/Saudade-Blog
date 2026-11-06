-- flag: note_author_meta_write_fix_20261007（migration_flags，勿重跑）
USE saudade_blog;
SELECT 'before' AS done, n.id, n.title, n.status, n.is_public,
       n.user_id, u.nickname AS account, n.updated_at
  FROM note n LEFT JOIN user u ON u.id = n.user_id
 WHERE n.user_id IN (721, 722)
 ORDER BY n.id;

-- ── ② 还原成「未记录」
UPDATE note SET user_id = NULL WHERE user_id IN (721, 722);

INSERT INTO migration_flags (flag_name) VALUES ('note_author_meta_write_fix_20261007');

-- ── ③ 改之后：期望 stale_rows = 0；total_rows 与 ① 之前相同（本脚本不增不删行）
SELECT 'after' AS done,
       (SELECT COUNT(*) FROM note WHERE user_id IN (721, 722)) AS stale_rows,
       (SELECT COUNT(*) FROM note) AS total_rows,
       (SELECT COUNT(*) FROM note WHERE user_id IS NULL) AS null_rows;

SELECT 'flag' AS done, flag_name, applied_at
  FROM migration_flags WHERE flag_name = 'note_author_meta_write_fix_20261007';
