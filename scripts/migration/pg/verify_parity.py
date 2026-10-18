#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据：PG 里的 `saudade_blog` 与 MySQL 里的 `saudade_blog` **结构上是不是同一套**。

读 MySQL 的 `information_schema`、读 PG 的 `pg_catalog`，各自归一成同一形状再逐项比。
比的是结构（表/列/类型/可空/默认/自增/索引/主键/外键/注释/触发器/库级时区），
**不比数据** —— 数据是下一步的事。

为什么值得有这一份：`0000_schema.sql` 是**生成**出来的，生成器的规则（tinyint 是不是布尔、
datetime 用哪个时区类型、ON UPDATE 怎么替）都写在 `mysql2pg.py` 的头注里。头注说不清
"它到底翻译对了没有"，只有把两边读回来对一遍才知道。首跑就是靠它抓出 `idx_conv_id`
在 `execution_log` 上被静默吞掉的（PG 索引名是 schema 级，psql 只印一行 NOTICE）。

退出码：0 = 一致；1 = 有差异（逐条打印）；2 = 连不上/环境不对。

用法：
    python3 scripts/migration/pg/verify_parity.py
    MYSQL_BIN="docker exec -i <cid> mysql" PG_BIN="psql -U …" python3 …/verify_parity.py
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mysql2pg import (DB_NAME, NO_DEFAULT, colliding_indexes,  # noqa: E402
                      entity_bools, index_name, load_catalog, pg_default, pg_type)

PG_BIN = os.environ.get("PG_BIN", "sudo -n -u postgres psql")
PG_DB = os.environ.get("PG_DB", DB_NAME)

# **手写的、MySQL 那边没有对应物的表**（见 `0001_rag_vectors.sql` 头注：向量从来没进过
# MySQL；`chat_image` 同理，图片从来没进过任何库）。它们不进本判据的射程 ——
# 向量那边逐位对账在 `verify_vectors.py`；`chat_image` 的判据在
# `tests/pg_integration.rs`（往返逐字相等 + 级联删）。
# 不加这个豁免的话，本判据从"搬完向量"那一刻起**永久红**，而红在一个正确的事实上；
# 判据一旦有恒红的项，真红就没人看了。
#
# ⚠️ **豁免要覆盖三类对象，不只是表**（20261018 修）：`pg["idx"]`（索引）与
# `pg["cons"]`（外键）那两条 diff 拿的是**未过滤**的 PG 侧集合。今天之前一直绿，
# 只是因为 `rag_vector`/`rag_vector_space` **既没有二级索引也没有外键** ——
# 也就是说，这份豁免以前只是"碰巧够用"。`chat_image` 两样都有，第一条就能撞上。
# （触发器那条 diff 不受影响：它取的是全库触发器，而 `chat_image` 没有触发器。）
#
# ⚠️ 还有一件事要说清楚，别读成"已验"：**手写表的列没有任何东西在核对**
# （列 diff 只遍历 MySQL 那侧的表）。这是手写表的既定代价。
# 20261018 再加 `note_tag`（`0006_note_tag.sql`）：`note.tags` 那一列逗号串归一出来的
# 关联表，MySQL 侧没有对应物。它的**列同样没有东西在核对** —— 判据在
# `tests/pg_integration.rs`（回填往返逐字相等、外键级联按列生效、撞号归属、移动改指向）。
HAND_WRITTEN = {"rag_vector", "rag_vector_space", "chat_image", "note_tag"}

# 单列豁免：`(表, 列)` 点名，**不是**把整张表加进 `HAND_WRITTEN`（那会把它现有的
# 索引 / 外键一起豁免掉，见上面那条 ⚠️）。
#
# 现在只有一条：`("note", "tags")` —— `0007_drop_note_tags_column.sql` 会在 soak 之后
# 删掉它（内容已归一到 `note_tag` 关联表，`string_agg(tag_id, ',' ORDER BY seq)` 可无损重算）。
# MySQL 侧那列**永远留着**（MySQL 已冻结），所以删完必然红在这条 diff 上。
#
# ⚠️ 这条豁免是**双向**的：两侧都按它过滤 ⇒ 列还在的时候它**不生效**（两边都摘掉，
# 那一列压根不比），列没了之后它才起作用。代价说清楚：`note.tags` 这一列的
# 类型 / 可空 / 默认 / 注释**从此没有东西在核对**，只有这一列。
COLUMN_EXCEPTIONS = {("note", "tags")}


def _owned_by_hand_written(key) -> bool:
    """索引 / 外键的键是 `(表名, 对象名)` —— 表名落在豁免集里就摘出去。"""
    return key[0] in HAND_WRITTEN


def pg_query(sql: str) -> list[list[str]]:
    argv = PG_BIN.split() + ["-d", PG_DB, "-t", "-A", "-F", "\t", "-c", sql]
    r = subprocess.run(argv, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("psql 查询失败：%s" % r.stderr.strip())
    return [ln.split("\t") for ln in r.stdout.split("\n") if ln != ""]


# ── PG 侧归一 ────────────────────────────────────────────────────────────────
def pg_norm_type(r: dict) -> str:
    t = r["data_type"]
    if t == "character varying":
        return "varchar(%s)" % r["maxlen"]
    if t == "character":
        return "char(%s)" % r["maxlen"]
    if t == "timestamp without time zone":
        return "timestamp"
    return t


def pg_norm_default(d: str | None) -> str | None:
    if d is None:
        return None
    d = re.sub(r"::[a-z_ ]+(\(\d+\))?$", "", d.strip())
    if d in ("now()", "CURRENT_TIMESTAMP"):
        return "CURRENT_TIMESTAMP"
    return d


def read_pg() -> dict:
    cols: dict[str, list[dict]] = {}
    for r in pg_query("""
        SELECT c.table_name, c.column_name, c.data_type,
               COALESCE(c.character_maximum_length::text, ''),
               c.is_nullable, COALESCE(c.column_default, %s), c.is_identity,
               COALESCE(col_description(pc.oid, c.ordinal_position), '')
          FROM information_schema.columns c
          JOIN pg_class pc ON pc.relname = c.table_name
          JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = c.table_schema
         WHERE c.table_schema = 'public'
         ORDER BY c.table_name, c.ordinal_position""" % ("'" + NO_DEFAULT + "'")):
        cols.setdefault(r[0], []).append({
            "name": r[1], "type": pg_norm_type({"data_type": r[2], "maxlen": r[3]}),
            "nullable": r[4] == "YES",
            "default": pg_norm_default(None if r[5] == NO_DEFAULT else r[5]),
            "identity": r[6] == "YES", "comment": r[7],
        })

    idx: dict[tuple[str, str], dict] = {}
    for r in pg_query("""
        SELECT t.relname, c.relname, i.indisunique, pg_get_indexdef(i.indexrelid)
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND NOT i.indisprimary"""):
        # `pg_get_indexdef` 形如 `… USING btree (列, 列)`；**不能拿 rindex 找括号** ——
        # 表达式索引里有嵌套括号（`NULLIF(TRIM(…))`），rindex 会从最里层那个 `(` 切起。
        m = re.search(r"USING \w+ \((.*)\)$", r[3])
        cols_part = m.group(1) if m else r[3]
        idx[(r[0], r[1])] = {"unique": r[2] == "t", "cols": norm_cols(cols_part),
                             "raw": r[3]}

    cons: dict[tuple[str, str], dict] = {}
    for r in pg_query("""
        SELECT t.relname, c.conname, c.contype,
               (SELECT array_agg(a.attname ORDER BY k.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum),
               COALESCE((SELECT ft.relname FROM pg_class ft WHERE ft.oid = c.confrelid), ''),
               COALESCE((SELECT array_agg(a.attname ORDER BY k.ord)
                  FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum), '{}'),
               c.confdeltype, c.confupdtype
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND c.contype IN ('p', 'f')"""):
        cons[(r[0], r[1])] = {
            "type": {"p": "PRIMARY KEY", "f": "FOREIGN KEY"}[r[2]],
            "cols": pg_array(r[3]), "ref": r[4], "refcols": pg_array(r[5]),
            "del": _RULE.get(r[6], ""), "upd": _RULE.get(r[7], ""),
        }

    trig = {r[0] for r in pg_query("""
        SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal""")}

    tz = pg_query("SHOW timezone")[0][0]
    return {"cols": cols, "idx": idx, "cons": cons, "trig": trig, "tz": tz}


# `pg_constraint.confdeltype`：主键那一格是空格，没有意义 ⇒ 用 .get 兜住
_RULE = {"a": "NO ACTION", "c": "CASCADE", "n": "SET NULL", "r": "RESTRICT", "d": "SET DEFAULT"}


def pg_array(s: str) -> list[str]:
    if not s or s in ("", "{}"):
        return []
    return [x.strip('"') for x in s.strip("{}").split(",")]


def norm_cols(s: str) -> str:
    """索引列表达式归一：去引号、去 `::text`、压空白 —— 只留"指哪一列/什么表达式"。"""
    s = s.replace('"', "").replace("public.", "")
    s = re.sub(r"::[a-z_ ]+(\(\d+\))?", "", s)
    s = re.sub(r"TRIM\(BOTH FROM ", "TRIM(", s)   # PG 把 TRIM(x) 印成 TRIM(BOTH FROM x)
    s = re.sub(r"\s+", "", s)
    return s


# ── 对账 ────────────────────────────────────────────────────────────────────
def main() -> int:
    my = load_catalog()
    bools = entity_bools()
    clash = colliding_indexes(my)
    pg = read_pg()
    bad: list[str] = []

    def diff(what: str, want, got) -> None:
        if want != got:
            bad.append("%s\n      MySQL/生成器: %r\n      PG         : %r" % (what, want, got))

    # ① 表（手写的那两张先摘出去，见 HAND_WRITTEN）
    diff("表集合", sorted(my["cols"]), sorted(t for t in pg["cols"] if t not in HAND_WRITTEN))

    # ② 列 / 类型 / 可空 / 默认 / 自增 / 注释
    for t in sorted(my["cols"]):
        want = [{"name": c["name"], "type": pg_type(c, (t, c["name"]) in bools),
                 "nullable": c["nullable"], "default": pg_default(c, (t, c["name"]) in bools),
                 "identity": c["extra"] == "auto_increment", "comment": c["comment"]}
                for c in my["cols"][t]
                if (t, c["name"]) not in COLUMN_EXCEPTIONS]
        got = [c for c in pg["cols"].get(t, []) if (t, c["name"]) not in COLUMN_EXCEPTIONS]
        diff("%s：列序" % t, [c["name"] for c in want], [c["name"] for c in got])
        for a, b in zip(want, got):
            for k in ("type", "nullable", "default", "identity", "comment"):
                diff("%s.%s 的 %s" % (t, a["name"], k), a[k], b[k])

    # ③ 索引（名字按生成器的改名规则折算）
    want_idx = {}
    for (t, n), e in my["idx"].items():
        if n == "PRIMARY" or e["kind"] == "FULLTEXT":
            continue
        nm = index_name(t, n, clash)
        if e["expr"]:
            want_idx[(t, nm)] = {"unique": True, "cols": "NULLIF(TRIM(nickname),'')"}
        else:
            want_idx[(t, nm)] = {"unique": e["unique"],
                                 "cols": norm_cols(", ".join(x[1] for x in sorted(e["seq"])))}
    # 手写表的索引不在这条 diff 的射程里（见 HAND_WRITTEN 那段注释）
    got_idx = {k: v for k, v in pg["idx"].items() if not _owned_by_hand_written(k)}
    diff("索引集合", sorted(want_idx), sorted(got_idx))
    for k in sorted(set(want_idx) & set(got_idx)):
        diff("索引 %s.%s 的唯一性" % k, want_idx[k]["unique"], pg["idx"][k]["unique"])
        diff("索引 %s.%s 的列" % k, want_idx[k]["cols"], pg["idx"][k]["cols"])

    # ④ 主键 / 外键
    for t in sorted(my["cols"]):
        pk = my["cons"].get((t, "PRIMARY"))
        if pk:
            diff("%s 的主键" % t, pk["cols"], pg["cons"].get((t, t + "_pkey"), {}).get("cols"))
    want_fk = {}
    for (t, n), e in my["cons"].items():
        if e["type"] != "FOREIGN KEY":
            continue
        upd, dele = my["rules"].get((t, n), ("NO ACTION", "NO ACTION"))
        want_fk[(t, n)] = {"type": "FOREIGN KEY", "cols": e["cols"], "ref": e["ref"],
                           "refcols": e["refcols"], "del": dele, "upd": upd}
    got_fk = {k: v for k, v in pg["cons"].items()
              if v["type"] == "FOREIGN KEY" and not _owned_by_hand_written(k)}
    diff("外键集合", sorted(want_fk), sorted(got_fk))
    for k in sorted(set(want_fk) & set(got_fk)):
        diff("外键 %s.%s" % k, want_fk[k], got_fk[k])

    # ⑤ 触发器：恰好是那 9 张带 ON UPDATE 的表
    want_trig = {("trg_%s_updated_at" % t) for t in
                 sorted({t for t in my["cols"]
                         if any("on update CURRENT_TIMESTAMP" in c["extra"]
                                for c in my["cols"][t])})}
    diff("ON UPDATE 触发器", sorted(want_trig), sorted(pg["trig"]))

    # ⑥ 库级时区：`DEFAULT CURRENT_TIMESTAMP` 落在 timestamp 上要靠它才是 +08:00 钟面
    diff("库级 TimeZone", "Asia/Shanghai", pg["tz"])

    print("MySQL %d 张表 / %d 列    PG %d 张表 / %d 列（另有手写 %d 张不在射程内）"
          "    索引 %d   外键 %d   触发器 %d"
          % (len(my["cols"]), sum(len(v) for v in my["cols"].values()),
             len(pg["cols"]) - len(HAND_WRITTEN & set(pg["cols"])),
             sum(len(v) for k, v in pg["cols"].items() if k not in HAND_WRITTEN),
             len(HAND_WRITTEN & set(pg["cols"])),
             len(pg["idx"]), len(got_fk), len(pg["trig"])))
    if bad:
        print("\n✗ %d 处对不上：" % len(bad))
        for b in bad:
            print("  - " + b)
        return 1
    print("✓ 结构逐项一致（表 / 列 / 类型 / 可空 / 默认 / 自增 / 索引 / 主键 / 外键 / 注释 / 触发器 / 时区）")
    # 豁免掉的那几张**各有各的判据**，别一句话带过（以前这里写死了"由
    # verify_vectors.py 管"，加 chat_image 之后那句话就成了错的）。
    # ⚠️ 这里点的是**库里真的有的**那几张（与上面那行计数同一个口径）。写 `HAND_WRITTEN`
    # 全集的话，会印出"3 张"却列 4 个名字 —— 迁移还没跑（`note_tag` 还没建）时就是这样。
    print("  （手写的 %s 不在上面这条判据的射程内，各有各的判据："
          % "/".join(sorted(HAND_WRITTEN & set(pg["cols"]))))
    print("     · rag_vector / rag_vector_space → `verify_vectors.py`（逐**位**对账）")
    print("     · chat_image → `tests/pg_integration.rs`（往返逐字相等 + 外键级联删）")
    print("     · note_tag → `tests/pg_integration.rs`（回填往返、级联按列生效、撞号归属、移动改指向）")
    if COLUMN_EXCEPTIONS:
        print("  ⚠️ 另有单列豁免 %s：那一列**两侧都不比**（列还在的时候这条不生效）。"
              % "/".join("%s.%s" % tc for tc in sorted(COLUMN_EXCEPTIONS)))
    print("     ⚠️ 它们的**列**没有任何东西在核对——这是手写表的既定代价，别读成「已验」。）")
    print("  ⚠️ 有两件事**本判据结构上验不了**，别读成「已验证」：")
    print("     ① 排序规则的大小写敏感性 —— 行为差异，不是结构差异。20261017 已拍板「登录按大小写」")
    print("        ⇒ PG 这边（敏感）就是目标行为，MySQL 那边（不敏感）才是**要离开**的那一侧。")
    print("     ② ON UPDATE 触发器复刻不到的那一格（显式赋同值 + 改了别的列）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
