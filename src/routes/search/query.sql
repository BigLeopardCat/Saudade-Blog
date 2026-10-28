WITH visible_notes AS ({visible_notes}),
terms AS (SELECT value AS term FROM jsonb_array_elements_text($1::jsonb)),
documents AS (
    SELECT 'note'::text AS kind, n.id, n.title, n.title AS search_title,
           n.content AS body, COALESCE(n.description, '') AS description,
           n.user_id, NULL::integer AS note_id, ''::text AS fallback_author, n.created_at,
           ARRAY(SELECT COALESCE(t1.name, t2.name) FROM note_tag nt
                 LEFT JOIN tag_one t1 ON t1.id = nt.tag_one_id
                 LEFT JOIN tag_two t2 ON t2.id = nt.tag_two_id
                 WHERE nt.note_id = n.id ORDER BY nt.seq) AS tags
    FROM note n JOIN visible_notes v ON v.id = n.id
    UNION ALL
    SELECT t.src, t.id, CASE WHEN t.src = 'talk' THEN COALESCE(t.title, '') ELSE '' END,
           CASE WHEN t.src = 'talk' THEN COALESCE(t.title, '') ELSE '' END,
           t.content, '', CASE WHEN t.src = 'talk' THEN t.user_id ELSE NULL END,
           NULL::integer, t.author, t.created_at, ARRAY[]::text[]
    FROM talk t WHERE t.src IN ('talk', 'board') AND t.approved = 1
    UNION ALL
    SELECT 'comment', c.id, v.title, '', c.content, '', c.user_id, c.note_id, '', c.created_at, ARRAY[]::text[]
    FROM note_comment c JOIN visible_notes v ON v.id = c.note_id
    WHERE c.approved = 1 AND c.is_deleted = 0
),
scored AS (
    SELECT d.kind, d.id, d.title, d.user_id, d.note_id, d.fallback_author, d.created_at,
           m.hits, m.score + CASE WHEN strpos(lower(d.search_title), $5) > 0 THEN 200 ELSE 0 END AS score,
           CASE WHEN m.first_hit > 0 THEN
               CASE WHEN m.first_hit > 25 THEN '…' ELSE '' END ||
               substring(d.body FROM GREATEST(m.first_hit - 24, 1) FOR 160) ||
               CASE WHEN char_length(d.body) > GREATEST(m.first_hit - 24, 1) + 159 THEN '…' ELSE '' END
           ELSE left(COALESCE(NULLIF(d.description, ''), d.body), 160) END AS excerpt
    FROM documents d CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE title_hit OR tag_hit OR description_hit OR body_pos > 0) AS hits,
               COALESCE(sum(CASE WHEN title_hit THEN 100 ELSE 0 END + CASE WHEN tag_hit THEN 30 ELSE 0 END + CASE WHEN description_hit THEN 20 ELSE 0 END +
                   LEAST((char_length(lower(d.body)) - char_length(replace(lower(d.body), term, ''))) / char_length(term), 10)), 0) AS score,
               COALESCE(min(NULLIF(body_pos, 0)), 0) AS first_hit
        FROM (SELECT term, strpos(lower(d.search_title), term) > 0 AS title_hit,
                     EXISTS (SELECT 1 FROM unnest(d.tags) tag WHERE strpos(lower(tag), term) > 0) AS tag_hit,
                     strpos(lower(d.body), term) AS body_pos,
                     strpos(lower(d.description), term) > 0 AS description_hit FROM terms) matches
    ) m WHERE m.hits > 0
),
ranked AS MATERIALIZED (
    SELECT * FROM scored
),
counts AS (
    SELECT count(*) FILTER (WHERE kind = 'note') AS notes,
           count(*) FILTER (WHERE kind = 'talk') AS talks,
           count(*) FILTER (WHERE kind = 'board') AS board,
           count(*) FILTER (WHERE kind = 'comment') AS comments FROM ranked
),
page AS (
    SELECT * FROM ranked WHERE ($2 = 'all' OR kind = $2)
    ORDER BY CASE kind WHEN 'note' THEN 0 WHEN 'talk' THEN 1 WHEN 'board' THEN 2 ELSE 3 END,
             hits DESC, score DESC, created_at DESC, id ASC
    LIMIT $3 OFFSET $4
)
SELECT counts.*, p.kind, p.id, p.title, p.excerpt, p.note_id, p.created_at,
       CASE WHEN p.kind = 'board' THEN p.fallback_author
            WHEN u.id IS NOT NULL THEN COALESCE(NULLIF(btrim(u.nickname), ''), u.username)
            WHEN p.kind = 'note' THEN COALESCE(
                (SELECT NULLIF(btrim(nickname), '') FROM "user" WHERE id = 1),
                (SELECT value FROM web_info WHERE key_name = 'author' LIMIT 1), '')
            ELSE COALESCE(p.fallback_author, '') END AS author
FROM counts LEFT JOIN page p ON true LEFT JOIN "user" u ON u.id = p.user_id
ORDER BY CASE p.kind WHEN 'note' THEN 0 WHEN 'talk' THEN 1 WHEN 'board' THEN 2 ELSE 3 END,
         p.hits DESC, p.score DESC, p.created_at DESC, p.id ASC
