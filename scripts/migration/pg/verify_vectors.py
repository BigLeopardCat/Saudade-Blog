#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据：PG 里的 RAG 向量与盘上 `data/rag_vectors/` **是不是同一份**。

搬向量和搬业务数据不一样：业务数据"看着一样"就够了，向量**必须逐位一样** —— 差一个
float32 的最后一位，余弦相似度就漂，检索排出来的名次就换人，而**没有任何一处会报错**。
所以这里不比"数值接近"，比**字节**。

── 两侧各自算出同一个十六进制串 ──────────────────────────────────────────
盘侧：`struct.pack('>f', x).hex()` —— 那个 float32 的大端十六进制。
库侧：`float4send(v)` 是 PG 的 **float4 二进制输出函数**（就是网络序的四个字节），
      `::text` 印成 `\\x3dcccccd`，`substr(…,3)` 掐掉 `\\x` 前缀 ⇒ 同样是八位十六进制。
两边**同一串**，整行拼起来取 md5 比。这样比"逐维取差"强的地方：它同时抓住了**维数变了**
（串长不同）、**顺序变了**（串不同）和**丢行**（键对不上）三种坏法。

退出码：0 = 一致；1 = 有差异（逐条打印）；2 = 连不上/文件不对。

用法：
    python3 scripts/migration/pg/verify_vectors.py
    RAG_VECTOR_DIR=… python3 scripts/migration/pg/verify_vectors.py
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_vectors import VECTOR_DIR, read_artifacts  # noqa: E402
from mysql2pg_data import PG_BIN, PG_DB  # noqa: E402


def pg_rows(sql: str) -> list[list[str]]:
    argv = PG_BIN.split() + ["-d", PG_DB, "-X", "-q", "-t", "-A", "-F", "\t",
                             "-v", "ON_ERROR_STOP=1", "-c", sql]
    r = subprocess.run(argv, capture_output=True)
    if r.returncode != 0:
        sys.exit("psql 失败：%s" % r.stderr.decode("utf-8", "replace").strip())
    return [ln.split("\t") for ln in r.stdout.decode("utf-8").split("\n") if ln != ""]


def row_md5_file(raw: bytes, off: int, dim: int) -> str:
    """**摘要的是十六进制串本身，不是那四个字节。** 库侧 `md5(string_agg(substr(…,3),''))`
    拿到的是 8 位十六进制**文本**，所以这边也必须喂 ASCII 十六进制 —— 喂 `struct.pack` 出来的
    裸字节算的是另一回事（实测：两串各 8192 字符逐字相等，而 md5 对不上，就是这个）。
    两边同一串，谁改了都得两边一起改。"""
    vals = struct.unpack_from("<%df" % dim, raw, off)
    return hashlib.md5("".join(struct.pack(">f", v).hex() for v in vals).encode("ascii")).hexdigest()


# 库侧：把 vector 拆成 float4 的二进制，拼成与上面同一个十六进制串。
PG_MD5_SQL = """
SELECT key, gen, dim,
       md5(string_agg(substr(float4send(v)::text, 3), '' ORDER BY ord))
FROM rag_vector, LATERAL unnest(vec::real[]) WITH ORDINALITY AS t(v, ord)
GROUP BY key, gen, dim
"""


def main() -> int:
    if not os.path.isdir(VECTOR_DIR):
        sys.exit("找不到向量目录 %s（用 RAG_VECTOR_DIR 指别处）" % VECTOR_DIR)
    a = read_artifacts(VECTOR_DIR)
    dim, entries = a["dim"], a["entries"]
    m = a["manifest"]
    bad: list[str] = []

    want = {str(k): (int(g), row_md5_file(a["raw"], i * dim * 4, dim))
            for i, (k, g) in enumerate(entries)}
    got = {r[0]: (int(r[1]), int(r[2]), r[3]) for r in pg_rows(PG_MD5_SQL)}

    # ── 行 ────────────────────────────────────────────────────────────────
    print("── 向量行 ─────────────────────────────────────────────────────")
    miss = [k for k in want if k not in got]
    extra = [k for k in got if k not in want]
    diff = [k for k in want if k in got and got[k][2] != want[k][1]]
    dimbad = [k for k, v in got.items() if v[1] != dim]
    print("   盘上 %d 行 / 库里 %d 行" % (len(want), len(got)))
    if miss:
        bad.append("库里缺 %d 行（首个 %s…）" % (len(miss), miss[0][:8]))
    if extra:
        bad.append("库里多 %d 行（首个 %s…）" % (len(extra), extra[0][:8]))
    if dimbad:
        bad.append("%d 行的 dim 列不是 %d（首个 %s…）" % (len(dimbad), dim, dimbad[0][:8]))
    if diff:
        k = diff[0]
        bad.append("%d 行内容不同（首个 %s…）\n      盘上 %s\n      库里 %s"
                   % (len(diff), k[:8], want[k][1], got[k][2]))
    genbad = [k for k in want if k in got and got[k][0] != want[k][0]]
    if genbad:
        bad.append("%d 行的 gen 不同（首个 %s…）" % (len(genbad), genbad[0][:8]))
    if not (miss or extra or diff or dimbad or genbad):
        print("   ✓ 逐位一致：%d 行 × %d 维，每一行都按 float4 的二进制比过" % (len(want), dim))

    # ── 空间行（manifest）────────────────────────────────────────────────
    print("── 空间行（manifest）──────────────────────────────────────────")
    rows = pg_rows(
        "SELECT schema, model, base_url, space_dim, cache_dim, fingerprint, gen, count,"
        " array_length(keys,1), array_to_string(keys, ','),"
        " array_to_string(missing, ','), to_char(built_at,'YYYY-MM-DD HH24:MI:SS'),"
        " stats::text FROM rag_vector_space")
    if len(rows) != 1:
        bad.append("rag_vector_space 有 %d 行（该恒一行）" % len(rows))
        print("   ✗ %d 行" % len(rows))
    else:
        r = rows[0]
        space = m.get("space") or {}
        want_space = [
            str(int(m.get("schema", 1))), str(space.get("model", "")),
            str(space.get("base_url", "")), str(int(space.get("dim", 0) or 0)), str(dim),
            str(m.get("fingerprint", "")), str(int(m.get("gen", 0) or 0)),
            str(int(m.get("count", 0) or 0)),
            str(len(a["keys"])), ",".join(a["keys"]),
            ",".join(m.get("missing") or []),
            str(m.get("built_at", "")),
            # `stats` 在 manifest 里是 **dict** ⇒ 要 `json.dumps`，不能 `str()`：
            # Python repr 用单引号，永远对不上 jsonb 的双引号。
            json.dumps(m.get("stats") or {}, ensure_ascii=False),
        ]
        names = ["schema", "model", "base_url", "space_dim", "cache_dim", "fingerprint",
                 "gen", "count", "keys 长度", "keys 顺序", "missing", "built_at", "stats"]
        for nm, w, g in zip(names, want_space, r):
            # stats 的 jsonb 会把键重排（还会加空格）⇒ 不逐字比，拆成项排序后比。
            # **别顺手把它改成 jsonb 就以为更严**：那一列在 load_vectors 里就是 json.dumps
            # 出来的串，键序本来就不携带信息。
            if nm == "stats":
                same = (sorted(x.strip() for x in w.strip("{}").split(",") if x.strip())
                        == sorted(x.strip() for x in g.strip("{}").split(",") if x.strip()))
            else:
                same = w == g
            if not same:
                bad.append("空间行 %s 不同：manifest=%r 库里=%r"
                           % (nm, w[:120], g[:120]))
        if not any(x.startswith("空间行") for x in bad):
            print("   ✓ manifest 十三个字段全对上（含 keys 的**顺序**——见 load_vectors 头注 ②）")

    print()
    if bad:
        print("✗ %d 处对不上：" % len(bad))
        for x in bad:
            print("  - " + x)
        return 1
    print("✓ 向量逐位一致，manifest 逐字段一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
