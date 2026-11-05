WITH notifications AS MATERIALIZED (
    SELECT id, type, left(title, 64) AS title, char_length(title)>64 AS title_truncated, created_at
    FROM user_notification WHERE user_id=$1 AND deleted_at IS NULL AND NOT is_read
), messages AS MATERIALIZED (
    SELECT m.id, left(coalesce(m.title,''), 64) AS title,
           char_length(coalesce(m.title,''))>64 AS title_truncated,
           m.from_user_id, left(coalesce(nullif(btrim(u.nickname),''),u.username,
                      '用户#'||m.from_user_id::text),80) AS peer_name, m.created_at
    FROM user_message m LEFT JOIN "user" u ON u.id=m.from_user_id
    WHERE m.to_user_id=$1 AND m.recipient_deleted_at IS NULL AND NOT m.is_read
), counts AS (
    SELECT (SELECT count(*) FROM notifications) AS notifications,
           (SELECT count(*) FROM messages) AS messages
), preview AS (
    (SELECT 'notification'::text AS source,id,type,title,title_truncated,
            NULL::integer AS from_user_id,NULL::text AS peer_name,created_at
     FROM notifications ORDER BY created_at DESC,id DESC LIMIT $2)
    UNION ALL
    (SELECT 'message',id,NULL::text,title,title_truncated,from_user_id,peer_name,created_at
     FROM messages ORDER BY created_at DESC,id DESC LIMIT $2)
)
SELECT counts.*,preview.* FROM counts LEFT JOIN preview ON true
ORDER BY source,created_at DESC,id DESC
