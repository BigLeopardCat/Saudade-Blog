# Versioned public RAG corpus API

GET /api/public/rag/corpus exports only records accepted by notes::public_condition:
public/published status, is_public=true, and draft_of IS NULL. It reuses the same
predicate as public detail reads. It does not increment views or expose internal user IDs.

Parameters:

| Parameter | Meaning |
|---|---|
| limit | Page size, default 50, allowed 1..100 |
| after | Exclusive positive article ID cursor; omitted for the first page |
| revision | Required with after; 64-character corpus revision from the first page |

The success envelope remains code/message/data. data contains schema_version=1,
revision, total, documents and next_cursor. Each document has id, title, content
and revision. next_cursor is null on the last page. IDs are strictly increasing.

Document revision is SHA-256 of the compact UTF-8 JSON array [title, content].
Corpus revision is an opaque SHA-256 over the ordered public ID/title/content-hash
metadata; consumers compare it without reconstructing its implementation.
Body changes invalidate it even when updated_at stays unchanged.

Each response is read in a PostgreSQL REPEATABLE READ, READ ONLY transaction.
A later page with an obsolete revision returns HTTP 409, code=409,
message=corpus_revision_changed. The consumer discards that partial attempt and
starts a new snapshot. Database failures return HTTP 503/code=503 with no documents.
Malformed cursor, revision or limit returns HTTP 400. Successful exports use
Cache-Control: no-store.

Consumers verify schema version, per-document revision, stable corpus revision and
total, monotonic unique IDs, forward cursors, and final count before publishing an index.
Empty is valid only after a successful complete snapshot. Never interpret an error
or a partial page as an empty corpus.

The host owns the public corpus contract. The Agent owns index publication,
embedding configuration and retrieval. See the Agent's current RAG documentation:
https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/rag-design.md
