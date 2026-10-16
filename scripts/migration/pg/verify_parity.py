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

    # ① 表
    diff("表集合", sorted(my["cols"]), sorted(pg["cols"]))

    # ② 列 / 类型 / 可空 / 默认 / 自增 / 注释
    for t in sorted(my["cols"]):
        want = [{"name": c["name"], "type": pg_type(c, (t, c["name"]) in bools),
                 "nullable": c["nullable"], "default": pg_default(c, (t, c["name"]) in bools),
                 "identity": c["extra"] == "auto_increment", "comment": c["comment"]}
                for c in my["cols"][t]]
        got = pg["cols"].get(t, [])
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
    diff("索引集合", sorted(want_idx), sorted(pg["idx"]))
    for k in sorted(set(want_idx) & set(pg["idx"])):
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
    got_fk = {k: v for k, v in pg["cons"].items() if v["type"] == "FOREIGN KEY"}
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

    print("MySQL %d 张表 / %d 列    PG %d 张表 / %d 列   索引 %d   外键 %d   触发器 %d"
          % (len(my["cols"]), sum(len(v) for v in my["cols"].values()),
             len(pg["cols"]), sum(len(v) for v in pg["cols"].values()),
             len(pg["idx"]), len(got_fk), len(pg["trig"])))
    if bad:
        print("\n✗ %d 处对不上：" % len(bad))
        for b in bad:
            print("  - " + b)
        return 1
    print("✓ 结构逐项一致（表 / 列 / 类型 / 可空 / 默认 / 自增 / 索引 / 主键 / 外键 / 注释 / 触发器 / 时区）")
    print("  ⚠️ 有两件事**本判据结构上验不了**，别读成「已验证」：")
    print("     ① 排序规则的大小写敏感性 —— 行为差异，不是结构差异。20261017 已拍板「登录按大小写」")
    print("        ⇒ PG 这边（敏感）就是目标行为，MySQL 那边（不敏感）才是**要离开**的那一侧。")
    print("     ② ON UPDATE 触发器复刻不到的那一格（显式赋同值 + 改了别的列）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
