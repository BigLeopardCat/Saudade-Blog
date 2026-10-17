#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据：PG 的 `saudade_blog` 与 MySQL 的 `saudade_blog` **数据上是不是同一份**。

搬完读回来逐行对。**结构**另有判据（`verify_parity.py`，比表/列/索引/外键/触发器/时区），
本文件只管内容。

为什么不是「数一下行数就完事」：行数相同而内容错位是搬数据最典型的坏法 —— 列错位、
转义把 `\\t` 吃进值里、NULL 被当成空串、布尔翻面。所以这里比的是**每一行的每一个字段**：
两边各自归一成同一形状、按行排序、整体比。

退出码：0 = 一致；1 = 有差异（逐条打印）；2 = 连不上/环境不对。

── **判据红不等于搬错了：MySQL 是活的** ─────────────────────────────────────
本机 MySQL 同时是产线库，一直在收写。所以这份对账的**有效窗口 = 从搬完那一刻到下一次
有人写库**。实测（20261017）：早上搬完是绿的，当天上午再看，`chat_history` MySQL 1180
行 vs PG 1172 行、`conversation.updated_at` 有一行往前走了 —— 那 8 行是**这中间新产生的
对话**，不是搬丢的。判读方法：**红的方向**。PG 少行 / MySQL 的值更新 ⇒ 是漂移；两边行数
一样而内容不同、或 PG 多行 ⇒ 才要查搬运。

由此还有一条要记住的：**切流量那天必须重新搬一次**（在停止写之后、翻转之前），
不能拿今天这份快照去翻。

── 本判据还管一件事：外键孤儿 ──────────────────────────────────────────────
装载时 `SET session_replication_role = replica` 把外键**关掉**了，所以载进去的数据
**没有被 PG 独立验证过外键完整性**。本文的逐行对账比的是**内容**，不比"这行指向的父行在不在"。
补上的那一节两侧都扫、看方向（PG 比 MySQL 多才算搬运的错）。详见那节的注释。

用法：
    python3 scripts/migration/pg/verify_data_parity.py
    PG_DB=… PG_BIN="psql -U …" python3 …/verify_data_parity.py
"""
from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mysql2pg import SCHEMA, entity_bools, load_catalog, q_ident  # noqa: E402
from mysql2pg_data import (PG_BIN, PG_DB, identity_col,  # noqa: E402
                           is_str, pg_scalar, query_raw, read_rows)


# ── 读 PG ───────────────────────────────────────────────────────────────────
def pg_run(sql: str) -> bytes:
    argv = PG_BIN.split() + ["-d", PG_DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql]
    r = subprocess.run(argv, capture_output=True)
    if r.returncode != 0:
        sys.exit("psql 失败：%s" % r.stderr.decode("utf-8", "replace").strip())
    return r.stdout


def unescape_copy(s: str) -> str | None:
    """`mysql2pg_data.copy_field()` 的逆。PG 的 COPY text 格式（含 `\\xHH` 与八进制那两档）。"""
    if s == "\\N":
        return None
    out, i, n = [], 0, len(s)
    esc = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v"}
    while i < n:
        if s[i] != "\\":
            out.append(s[i])
            i += 1
            continue
        i += 1
        if i >= n:
            out.append("\\")
            break
        e = s[i]
        if e in esc:
            out.append(esc[e])
            i += 1
        elif e == "x":
            j = i + 1
            while j < n and j < i + 3 and s[j] in "0123456789abcdefABCDEF":
                j += 1
            out.append(chr(int(s[i + 1:j], 16)))
            i = j
        elif e in "01234567":
            j = i
            while j < n and j < i + 3 and s[j] in "01234567":
                j += 1
            out.append(chr(int(s[i:j], 8)))
            i = j
        else:
            out.append(e)
            i += 1
    return "".join(out)


def read_pg(cat: dict, table: str) -> list[list[str | None]]:
    cols = cat["cols"][table]
    sql = "COPY %s (%s) TO STDOUT" % (q_ident(table),
                                      ", ".join(q_ident(c["name"]) for c in cols))
    lines = pg_run(sql).decode("utf-8").split("\n")
    # COPY TO 每行都以 \n 收尾 ⇒ 末位那个空串是尾巴，不是一行。
    # （**不能**把中间的空行也当分隔符跳过：单列全空串的表，那一行本身就是空行。）
    if lines and lines[-1] == "":
        lines.pop()
    rows = [[unescape_copy(f) for f in ln.split("\t")] for ln in lines]
    for r in rows:
        if len(r) != len(cols):
            sys.exit("%s：PG 回来 %d 列，目录里是 %d 列 —— 解析器坏了" % (table, len(r), len(cols)))
    return rows


# ── 归一 ────────────────────────────────────────────────────────────────────
def canon(v: str | None, c: dict, is_bool: bool, side: str):
    """把一个字段归到「两边都该长成同一个样子」的形状。**两侧共用这一个函数** ——
    各写一份的话，两份口径一漂，对账就变成自己骗自己。"""
    if v is None:
        return None
    if is_bool:
        return (v == "1") if side == "mysql" else (v == "t")
    if c["dtype"] == "double":
        return repr(float(v))       # 两边印法可能不同（`1` vs `1.0`），取同一个 double 的规范形
    if c["dtype"] == "char":
        return v.rstrip(" ")        # MySQL 取 CHAR 时去尾空格，PG 是补齐的 —— 语义上都无意义
    return v


def canon_rows(rows, cat, table, side, bools):
    cols = cat["cols"][table]
    return [tuple(canon(v, c, (table, c["name"]) in bools, side) for v, c in zip(r, cols))
            for r in rows]


def sort_key(r):
    return tuple("\x00N\x00" if x is None else x for x in r)


# ── 外键孤儿扫描 ────────────────────────────────────────────────────────────
# **为什么非有不可**：装载时 `SET session_replication_role = replica` 把外键**关掉**了
# （否则没法按任意顺序 COPY）。于是载进去的数据**从来没有被 PG 独立验证过外键完整性** ——
# 上面那轮"逐行对账"比的是**内容**，不比"这行指向的父行在不在"。源数据来自带 FK 的 InnoDB，
# 所以今天大概率是干净的；但那是**靠前提对**，不是靠判据对。这一节把它补成判据。
#
# **两侧都扫、看方向**（与本文开头那条同一口径）：PG 孤儿数 == MySQL 孤儿数 ⇒ 是**源数据里
# 本来就有**的事实（MySQL 那边也可能是 FK 事后才加的、或 `foreign_key_checks=0` 写进去的），
# 只告警不判红；**PG 比 MySQL 多** ⇒ 才要查搬运。


def fk_list(cat: dict) -> list[dict]:
    return sorted(
        ({"child": t, "parent": e["ref"], "cols": e["cols"],
          "refcols": e["refcols"], "name": n}
         for (t, n), e in cat["cons"].items() if e["type"] == "FOREIGN KEY"),
        key=lambda x: (x["child"], x["name"]))


def orphan_sql(fk: dict, side: str) -> str:
    """数孤儿。**MATCH SIMPLE 的语义别写错**：PG 与 InnoDB 的默认都是「子列里**任一**为 NULL
    ⇒ 这条约束就不适用」，所以孤儿 = 子列**全非空** 且找不到父行。
    照 `=` 拼而不是 `IS NOT DISTINCT FROM`：NULL 已经被前一个条件排掉了。"""
    def q(s: str) -> str:
        return ("`%s`" % s) if side == "mysql" else q_ident(s)

    def tbl(s: str) -> str:
        return ("`%s`.`%s`" % (SCHEMA, s)) if side == "mysql" else q_ident(s)

    notnull = " AND ".join("%s IS NOT NULL" % q(c) for c in fk["cols"])
    match = " AND ".join("p.%s = ch.%s" % (q(a), q(b))
                         for a, b in zip(fk["refcols"], fk["cols"]))
    return ("SELECT COUNT(*) FROM %s ch WHERE %s AND NOT EXISTS "
            "(SELECT 1 FROM %s p WHERE %s)"
            % (tbl(fk["child"]), notnull, tbl(fk["parent"]), match))


# ── 主 ──────────────────────────────────────────────────────────────────────
def main() -> int:
    cat = load_catalog()
    bools = entity_bools()
    tables = sorted(cat["cols"])
    bad: list[str] = []
    total = 0

    for t in tables:
        my = canon_rows(read_rows(cat, t), cat, t, "mysql", bools)
        pg = canon_rows(read_pg(cat, t), cat, t, "pg", bools)
        total += len(my)
        mark = "✓"
        if len(my) != len(pg):
            mark = "✗"
            bad.append("%s：行数 %d(MySQL) vs %d(PG)" % (t, len(my), len(pg)))
        else:
            a, b = sorted(my, key=sort_key), sorted(pg, key=sort_key)
            if a != b:
                mark = "✗"
                first = next(i for i in range(len(a)) if a[i] != b[i])
                bad.append("%s：行数都是 %d，但有 %d 行内容不同\n      MySQL: %r\n      PG   : %r"
                           % (t, len(a), sum(1 for x, y in zip(a, b) if x != y),
                              a[first], b[first]))
        print("   %-24s %6d 行  %s" % (t, len(my), mark))

    # 外键孤儿（见上面那段"为什么非有不可"）
    print("── 外键孤儿扫描（装载时外键是关着的，这一节是它的事后核对）────")
    fks = fk_list(cat)
    fk_bad = 0
    for fk in fks:
        my = int(query_raw(orphan_sql(fk, "mysql"))[0][0])
        pg = int(pg_scalar(orphan_sql(fk, "pg"))[0][0])
        if pg > my:
            mark, fk_bad = "✗ PG 多 %d 行" % (pg - my), fk_bad + 1
            bad.append("%s → %s：孤儿 MySQL %d 行 vs PG %d 行（搬运搬坏了，不是源数据的事）"
                       % (fk["child"], fk["parent"], my, pg))
        elif pg:
            mark = "⚠ %d 行（两侧一样 ⇒ 源数据本来就有，不是搬运）" % pg
        else:
            mark = "✓"
        print("   %-20s → %-18s MySQL %-4d PG %-4d %s"
              % (fk["child"], fk["parent"], my, pg, mark))
    if not fks:
        print("   （目录里没有外键 —— 这不正常，先查 `mysql2pg.py` 的外键读取）")

    # 自增序列：搬完 setval 没归位的话，下一批 INSERT 会撞主键（本判据不看「有没有归位」，
    # 只看「下一个值会不会撞」）
    print("── 自增序列 ───────────────────────────────────────────────────")
    seq_bad = 0
    for t in tables:
        idc = identity_col(cat, t)
        if not idc:
            continue
        col = idc["name"]
        mx = int(pg_scalar('SELECT COALESCE(MAX("%s"), 0) FROM %s' % (col, q_ident(t)))[0][0])
        seq = pg_scalar("SELECT pg_get_serial_sequence('%s', '%s')" % (t, col))[0][0]
        last, called = pg_scalar("SELECT last_value, is_called FROM %s" % seq)[0]
        nxt = int(last) + (1 if called == "t" else 0)
        ok = nxt > mx
        if not ok:
            seq_bad += 1
        print("   %-24s max=%-7d 下一个=%-7d %s" % ("%s.%s" % (t, col), mx, nxt, "✓" if ok else "✗ 会撞"))
    if seq_bad:
        bad.append("有 %d 个自增序列的下一个值会撞已有主键" % seq_bad)

    print()
    if bad:
        print("✗ %d 处对不上：" % len(bad))
        for x in bad:
            print("  - " + x)
        return 1
    print("✓ 数据逐行一致：%d 张表 / %d 行，每一行的每一个字段都对过" % (len(tables), total))
    print("  （另：%d 个外键扫过孤儿，PG 一个都没多）" % len(fks))
    print("  （结构另判：`python3 scripts/migration/pg/verify_parity.py`）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
