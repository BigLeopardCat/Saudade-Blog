WITH documents AS (
    SELECT 'announcements'::text AS source, id, title, content,
           ''::text AS display_name, created_at
    FROM announcement
    UNION ALL
    SELECT src, id, CASE WHEN src = 'talk' THEN COALESCE(title, '') ELSE '' END,
           content, author, created_at
    FROM talk WHERE src IN ('board', 'talk') AND approved = 1
), matches AS MATERIALIZED (
    SELECT source, id, left(title, 120) AS title, char_length(title) > 120 AS title_truncated,
           substring(content FROM greatest(strpos(lower(content), lower($4)) - 60, 1)
                     FOR 240) AS content,
           char_length(content) > 240 AS content_truncated,
           left(display_name, 80) AS display_name,
           char_length(display_name) > 80 AS display_name_truncated, created_at
    FROM documents WHERE title ILIKE $1 OR content ILIKE $1
), counts AS (
    SELECT count(*) FILTER (WHERE source = 'announcements') AS announcements,
           count(*) FILTER (WHERE source = 'board') AS board,
           count(*) FILTER (WHERE source = 'talk') AS talk FROM matches
), page AS (
    SELECT * FROM matches ORDER BY created_at DESC NULLS LAST, source ASC, id DESC
    LIMIT $2 OFFSET $3
)
SELECT counts.*, page.* FROM counts LEFT JOIN page ON true
ORDER BY created_at DESC NULLS LAST, source ASC, id DESC
