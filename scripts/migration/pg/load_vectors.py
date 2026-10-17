#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 `saudade-blog-agent/data/rag_vectors/` 那三个文件搬进 PG（表由 `0001_rag_vectors.sql` 建）。

默认**只列计划不动库**（与 `mysql2pg_data.py` 同一立场），`--apply` 才真搬；
`--sql` 只建表。重复跑安全：开头 `TRUNCATE` 那两张表重来。

用法：
    python3 scripts/migration/pg/load_vectors.py --sql      # 只建表
    python3 scripts/migration/pg/load_vectors.py            # 干跑（读文件、校验、报计划）
    python3 scripts/migration/pg/load_vectors.py --apply    # 真搬
    python3 scripts/migration/pg/verify_vectors.py          # 判据：位级对账

── 两条只有搬向量才会踩到的 ─────────────────────────────────────────────────
① **浮点必须逐位往返，不能"看着差不多"**。`cache.f32` 是 float32 裸字节，pgvector 的
   `vector` 也是 float32 —— 所以这条路**本来就是无损的**，前提是十进制中转站写对。
   这里用 `struct.unpack('<f')` 取回 Python float（它精确等于那个 float32），再 `repr()`
   出**最短往返串**；pgvector 用 `strtof` 收（正确舍入）⇒ 回到原 float32。
   实测锚点：`0.1f` 的字节是 `3dcccccd`，`repr` 给 `0.10000000149011612`，
   `'[0.10000000149011612]'::vector` 读回来 `float4send` 仍是 `\x3dcccccd`。
   非有限值（inf/nan）**当场退**：`repr` 会给出 `inf`，而 pgvector 未必收。
② **`keys` 是顺序敏感的**。它不是"有哪些键"，而是"第 i 个 chunk 用哪个键"——视图按
   chunk 下标对齐（`VectorStore._install` 里 `row_of` 那一句）。所以存成 `text[]` 保序，
   **不许**当成集合去重或排序。
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mysql2pg import REPO  # noqa: E402
from mysql2pg_data import PG_BIN, PG_DB, apply_script, copy_field  # noqa: E402

SQL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "0001_rag_vectors.sql")
VECTOR_DIR = os.environ.get(
    "RAG_VECTOR_DIR", os.path.join(REPO, "saudade-blog-agent", "data", "rag_vectors"))
SCHEMA = 1


def read_json(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def pg_array(items) -> str:
    return "{" + ",".join('"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
                          for s in items) + "}"


def read_artifacts(root: str) -> dict:
    """读三个文件并**照 `VectorStore._install` 的口径校验**（不变式 ①②③）。"""
    m = read_json(os.path.join(root, "manifest.json"))
    cj = read_json(os.path.join(root, "cache.json"))
    raw = open(os.path.join(root, "cache.f32"), "rb").read()

    if int(m.get("schema", 0)) != SCHEMA:
        sys.exit("manifest schema=%r 不是 %d" % (m.get("schema"), SCHEMA))
    if int(cj.get("schema", 0)) != SCHEMA:
        sys.exit("cache.json schema=%r 不是 %d" % (cj.get("schema"), SCHEMA))
    dim = int(cj.get("dim", 0) or 0)
    if dim <= 0:
        sys.exit("cache.dim 非法：%r" % cj.get("dim"))
    if int(m.get("cache_dim", 0)) != dim:
        sys.exit("cache_dim 不符：manifest=%r cache=%r" % (m.get("cache_dim"), dim))
    entries = list(cj.get("entries") or [])
    if len(raw) != len(entries) * dim * 4:
        sys.exit("cache.f32 长度 %d != %d 行 × %d 维 × 4（截断/半成品，别搬）"
                 % (len(raw), len(entries), dim))
    keys = list(m.get("keys") or [])
    if len(keys) != int(m.get("count", -1)):
        sys.exit("count(%r) 与 keys 长度(%d) 不符" % (m.get("count"), len(keys)))
    have = {k for k, _g in entries}
    lack = [k for k in keys if k not in have]
    if lack:
        sys.exit("活跃键里有 %d 个不在 cache 里（首个 %s…）" % (len(lack), lack[0][:8]))

    return {"manifest": m, "cache": cj, "dim": dim, "entries": entries,
            "keys": keys, "raw": raw}


def vec_text(raw: bytes, off: int, dim: int, where: str) -> str:
    """float32 → pgvector 的文本形（见头注 ①）。"""
    vals = struct.unpack_from("<%df" % dim, raw, off)
    for i, v in enumerate(vals):
        if not math.isfinite(v):
            sys.exit("%s 第 %d 维是 %r —— 非有限值，pgvector 未必收，先弄清它怎么来的"
                     % (where, i, v))
    return "[" + ",".join(repr(v) for v in vals) + "]"


def build_script(a: dict) -> str:
    m, dim, entries = a["manifest"], a["dim"], a["entries"]
    space = m.get("space") or {}
    L: list[str] = []
    add = L.append

    add("BEGIN;")
    add("TRUNCATE TABLE rag_vector, rag_vector_space;")

    add("COPY rag_vector_space (id, schema, model, base_url, space_dim, cache_dim,"
        " fingerprint, gen, count, keys, missing, built_at, stats) FROM stdin;")
    row = [
        "1", str(int(m.get("schema", SCHEMA))),
        str(space.get("model", "")), str(space.get("base_url", "")),
        str(int(space.get("dim", 0) or 0)), str(dim),
        str(m.get("fingerprint", "")), str(int(m.get("gen", 0) or 0)),
        str(int(m.get("count", 0) or 0)),
        pg_array(a["keys"]), pg_array(list(m.get("missing") or [])),
        # 缺 built_at ⇒ **交 None**，别交字符串 "\\N"：`copy_field` 会把那个反斜杠转义成
        # `\\N`，PG 读到的就是两个字符的字面量、而不是 NULL。
        str(m.get("built_at", "")) or None,
        json.dumps(m.get("stats") or {}, ensure_ascii=False),
    ]
    add("\t".join(copy_field(x) for x in row))
    add("\\.")

    add("COPY rag_vector (key, gen, dim, vec) FROM stdin;")
    for i, (k, g) in enumerate(entries):
        add("\t".join([copy_field(str(k)), copy_field(str(g)), str(dim),
                       copy_field(vec_text(a["raw"], i * dim * 4, dim, "键 %s…" % str(k)[:8]))]))
    add("\\.")
    add("")
    add("COMMIT;")
    return "\n".join(L) + "\n"


def run_sql_file(path: str) -> None:
    """**内容走 stdin，不走 `-f`**：psql 跑在 `postgres` 身份下，而 `/home/ubuntu/**` 那条路径
    它进不去（实测 `-f` 直接 Permission denied）。整份脚本本来也是纯 DDL、没有 `\\i`。"""
    with open(path, encoding="utf-8") as fh:
        apply_script(fh.read())


def main() -> int:
    if "--sql" in sys.argv[1:]:
        print("建表：%s" % SQL_FILE)
        run_sql_file(SQL_FILE)
        print("✓ 建完（幂等：IF NOT EXISTS）")
        return 0

    if not os.path.isdir(VECTOR_DIR):
        sys.exit("找不到向量目录 %s（用 RAG_VECTOR_DIR 指别处）" % VECTOR_DIR)
    a = read_artifacts(VECTOR_DIR)
    m, dim = a["manifest"], a["dim"]
    space = m.get("space") or {}
    gens: dict[int, int] = {}
    for _k, g in a["entries"]:
        gens[int(g)] = gens.get(int(g), 0) + 1

    print("── 盘上现状 ───────────────────────────────────────────────────")
    print("   目录        %s" % VECTOR_DIR)
    print("   空间        model=%s  base_url=%s  请求维度=%s"
          % (space.get("model"), space.get("base_url"), space.get("dim")))
    print("   实际维度    %d" % dim)
    print("   缓存条目    %d 行 × %d 维（%.2f MB 裸字节）"
          % (len(a["entries"]), dim, len(a["raw"]) / 1048576))
    print("   代数分布    %s" % gens)
    print("   活跃槽位    %d 个（指纹 %s…）" % (len(a["keys"]), str(m.get("fingerprint"))[:12]))
    print("   建库时刻    %s" % m.get("built_at"))
    print()

    if "--apply" not in sys.argv[1:]:
        print("干跑结束（一个字都没写）。真搬：加 --apply（表还没建就先 --sql）")
        return 0

    print("── 装载 ───────────────────────────────────────────────────────")
    apply_script(build_script(a))
    print("   psql 退出码 0（一个事务；任何一步失败整体回滚）")
    print()
    print("对账：python3 scripts/migration/pg/verify_vectors.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
