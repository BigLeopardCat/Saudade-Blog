# Public document reads and RAG corpus

## Original text

`GET /api/public/documents/{type}/{id}/read` reads one public document without
recording a view. `type` is `note`, `talk`, `board` or `announcement`; IDs are
positive i32 values. Notes use the published-root predicate below; talks and
board messages must match their source type and be approved. Private drafts and
editor buffers are not available through this route.

`offset` and `limit` count Unicode code points in the selected original Markdown.
The default limit is 12,000 and the maximum is 24,000. An optional `section`
selects a unique heading or source section ID; a parent section includes its
descendants. Duplicate titles return an empty unresolved frame with `source=null`,
never an arbitrary match. Images remain their original Markdown references.

Successful data includes `content`, `contentRevision`, `sectionSchema`,
`readOffset`, `nextOffset`, `totalChars`, `readComplete` and a bounded section list.
`source` binds type, ID, canonical revision, section schema, selected section ID
and the exact visible range. A complete selected section does not imply the
whole document was read. For continuation or an `sN` section ID, provide both
`revision=contentRevision` and `section_schema=sectionSchema`. Changed content or
section policy returns 409; missing locator versions or invalid ranges return 400.
The current section policy is `commonmark-top-level-source-v1`. Oversized source
bodies above 4 MiB return 413; unavailable data, admission or deadline returns 503.
Successful reads use `Cache-Control: no-store`.

For notes, `metadata` also contains the existing public author display name/avatar,
article description and cover/fit/focal/zoom fields. It reuses the public article
profile projection, without exposing author IDs, email, role or credentials.
Display names and descriptions are bounded to 80 and 2,000 Unicode code points.
URLs above 2,048 code points become null rather than an invalid URL prefix. Each
bounded text/URL has its corresponding `Truncated` flag. Unknown authors remain
null; an unset description is an empty string. Nonfinite or invalid image geometry
is unknown, not a fabricated default. Metadata-only consumers may request `limit=1`;
no separate body/statistics or per-author HTTP request is needed.

`GET /api/public/notes/{id}/stats` is independent of body reads and does not add a
view. It shares the same public-root rule; database failures return 503 rather
than pretending the article is missing. Public consumers should use numeric
counts only; anonymous `liked=false` does not describe an authenticated user.

## Corpus export

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

Each complete serialized document is limited to 4 MiB and the complete corpus
page to 12 MiB. PostgreSQL projects JSON sizes before any selected bodies are
transferred. A page may contain fewer than `limit` documents because of this byte
budget; only `next_cursor=null` means the end. A non-null cursor is the last
returned ID. A single oversized document fails explicitly with 503 and is never
truncated or silently omitted. Transport consumers allow up to 16 MiB for the
complete response envelope, independent of the ordinary API response budget.

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

## Current visibility

`POST /api/public/documents/validate` checks candidate article identities against
the current public corpus before the Agent presents retrieval results. The body
is `{documents:[{type:"note",id,revision}]}`; revision is the canonical content
hash. At most 256 request rows and 64 unique IDs are accepted.

Data has `schemaVersion:1` and exactly one entry per requested ID, in any order:
`{type:"note",id,visible,contentRevision}`. Missing, deleted and non-public
articles all return `visible:false,contentRevision:null`, without titles, bodies
or hidden metadata. Visible entries return the current canonical content hash;
the consumer requires an exact candidate revision match. Database failure,
capacity exhaustion and deadline expiry return 503, never a successful zero-hit
result. Malformed identities return 400 before database access.
