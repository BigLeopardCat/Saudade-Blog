WITH keywords AS MATERIALIZED (
    SELECT term->>'keyword' AS keyword, term->>'pattern' AS pattern, ordinal
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS input(term, ordinal)
), documents AS (
    SELECT 'announcements'::text AS source, id, title, content,
           ''::text AS display_name, created_at
    FROM announcement
    UNION ALL
    SELECT src, id, CASE WHEN src = 'talk' THEN COALESCE(title, '') ELSE '' END,
           content, author, created_at
    FROM talk WHERE src IN ('board', 'talk') AND approved = 1
), matches AS MATERIALIZED (
    SELECT source, id, left(title, 120) AS title, char_length(title) > 120 AS title_truncated,
           substring(content FROM greatest(COALESCE(matched.content_position, 1) - 60, 1)
                     FOR 240) AS content,
           (char_length(content) > 240
            OR greatest(COALESCE(matched.content_position, 1) - 60, 1) > 1) AS content_truncated,
           left(display_name, 80) AS display_name,
           char_length(display_name) > 80 AS display_name_truncated, created_at,
           matched.keyword_indices AS matched_keyword_indices
    FROM documents
    CROSS JOIN LATERAL (
        SELECT array_agg(ordinal - 1 ORDER BY ordinal) AS keyword_indices,
               min(nullif(strpos(lower(content), lower(keyword)), 0)) AS content_position
        FROM keywords WHERE title ILIKE pattern OR content ILIKE pattern
    ) matched
    WHERE matched.keyword_indices IS NOT NULL
), counts AS (
    SELECT count(*) FILTER (WHERE source = 'announcements') AS announcements,
           count(*) FILTER (WHERE source = 'board') AS board,
           count(*) FILTER (WHERE source = 'talk') AS talk FROM matches
), keyword_counts AS (
    SELECT jsonb_agg(jsonb_build_object(
               'keyword', keyword, 'total', total,
               'counts', jsonb_build_object('announcements', announcements,
                                            'board', board, 'talk', talk))
               ORDER BY ordinal) AS keyword_counts
    FROM (
        SELECT keywords.keyword, keywords.ordinal, count(matches.id) AS total,
               count(matches.id) FILTER (WHERE source = 'announcements') AS announcements,
               count(matches.id) FILTER (WHERE source = 'board') AS board,
               count(matches.id) FILTER (WHERE source = 'talk') AS talk
        FROM keywords LEFT JOIN matches ON keywords.ordinal - 1 = ANY(matches.matched_keyword_indices)
        GROUP BY keywords.keyword, keywords.ordinal
    ) per_keyword
), page AS (
    SELECT source, id, title, title_truncated, content, content_truncated,
           display_name, display_name_truncated, created_at,
           to_jsonb(matched_keyword_indices) AS matched_keyword_indices
    FROM matches ORDER BY created_at DESC NULLS LAST, source ASC, id DESC
    LIMIT $2 OFFSET $3
)
SELECT counts.*, keyword_counts.*, page.*
FROM counts CROSS JOIN keyword_counts LEFT JOIN page ON true
ORDER BY created_at DESC NULLS LAST, source ASC, id DESC
