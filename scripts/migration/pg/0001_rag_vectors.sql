-- RAG chunk 向量：从文件（`saudade-blog-agent/data/rag_vectors/` 那三个）搬进 PG。
-- 装载 = `load_vectors.py`；位级对账 = `verify_vectors.py`。
--
-- ⚠️ **本文件是手写的**，与 `0000_schema.sql` 不同源：那份由 `mysql2pg.py` 从 MySQL
--    的 `information_schema` 生成，而这一份在 MySQL 那边**没有对应物**（向量从来没进过
--    MySQL）。所以「改结构 = 先改 MySQL 再重跑生成器」那条纪律在这里不适用，改这里就是
--    改这里。
--
-- ── 为什么值得搬（不是"统一一下"这种理由）─────────────────────────────────
-- 盘上那套是「三个文件 + 一把 flock + (gen, fingerprint) 换视图」。20260916g 真出过
-- 一次事故：对照实验漏了 `--out-*` ⇒ 实验产物写进了**生产**目录。搬进库以后，
-- "一份真值源"由**主键 + 事务**保证，不再依赖"每个写者都记得先加锁"。
-- 另外 `cache.f32` 是**行主序的裸二进制**：截断一半、或 cache.json 与它不同步，
-- 读侧只能靠长度校验事后发现；换成行以后，每一行要么在要么不在。
--
-- ── 为什么不写死维度（`vector(1024)`）────────────────────────────────────
-- `Space.dim` 是**请求**维度（0 = 不传，以返回长度为准），`cache_dim` 才是实际维度；
-- 换 embedding 模型会换维度（`docs/word-graph.md` 那条「换模型必重建」同源）。
-- `vector(N)` 装不下另一种 N ⇒ 用**不定长** `vector` + `dim` 列 + CHECK 钉住二者一致。
-- 代价说清楚：pgvector 的 ANN 索引（ivfflat / hnsw）要求定长列 ⇒ **这张表建不了索引**。
-- 本量级不需要（265 行 × 1024 维；`docs/word-graph.md` 实测纯 Python 点积 15–17ms）。
-- 哪天要 ANN，那一天的改法是把 `vec` 换成 `vector(N)` 并重建——那正是"换模型"那一天，
-- 两件事本来就该一起做。
--
-- ── 与盘上那套的对应关系 ────────────────────────────────────────────────
--   manifest.json  → `rag_vector_space` 的**唯一一行**（`keys` 顺序敏感，是 text[]）
--   cache.json     → `rag_vector` 的 `key` / `gen`（`schema` 与 `dim` 进 space 行）
--   cache.f32      → `rag_vector.vec`（每行一条，不再有"第 i 行"这种位置语义）

-- 单行配置表：盘上那份 manifest 的全部字段。
CREATE TABLE IF NOT EXISTS rag_vector_space (
  id          smallint  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  schema      integer   NOT NULL,
  model       text      NOT NULL,
  base_url    text      NOT NULL,
  space_dim   integer   NOT NULL,          -- 请求维度（0 = 不传 dimensions）
  cache_dim   integer   NOT NULL,          -- 实际向量维度（= manifest.cache_dim）
  fingerprint text      NOT NULL,
  gen         integer   NOT NULL,
  count       integer   NOT NULL,          -- 活跃槽位数 = 下面 keys 的长度
  keys        text[]    NOT NULL,          -- **顺序敏感**：视图按 chunk 下标对齐
  missing     text[]    NOT NULL DEFAULT '{}',
  built_at    timestamp,                   -- 库约定：值就是 +08:00 钟面（同 0000_schema.sql）
  stats       jsonb
);

COMMENT ON TABLE rag_vector_space IS
  'RAG 向量索引的 manifest（盘上 data/rag_vectors/manifest.json 的库内形态）。恒一行。';

-- 向量本体。键是内容寻址的（md5(模型+端点+请求维度+文本)），所以同一份文本在同一空间里
-- 恒得同一个键、换空间必得不同键 —— `ON CONFLICT DO NOTHING` 就是天然的"已嵌过"判据。
CREATE TABLE IF NOT EXISTS rag_vector (
  key   text    PRIMARY KEY,
  gen   integer NOT NULL,
  dim   integer NOT NULL,
  vec   vector  NOT NULL,
  CONSTRAINT rag_vector_dim_matches CHECK (vector_dims(vec) = dim)
);

COMMENT ON TABLE rag_vector IS
  'RAG chunk 向量（内容寻址，key=md5）。`gen` 是单调代数，保留期策略见 PRUNE_KEEP_GENS。';

-- ── 保留期 ──────────────────────────────────────────────────────────────
-- 盘上那套的 `PRUNE_KEEP_GENS = 2`（孤儿向量留两代，给"误删后马上改回来 / 分页抖动"
-- 留缓冲）。库内形态用同一口径，就是删 `gen < (SELECT gen FROM rag_vector_space) - 2`
-- 的行 —— 但**本文件不建这个清理**：什么时候清、谁来清，是"采纳"那一步与 checkpoint
-- 保留期一起裁的事（与 `docs/adr/adr-0012` 里 PG 表保留期那条同一笔账）。
