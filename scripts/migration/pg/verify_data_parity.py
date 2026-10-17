#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据：PG 的 `saudade_blog` 与 MySQL 的 `saudade_blog` **数据上是不是同一份**。

搬完读回来逐行对。**结构**另有判据（`verify_parity.py`，比表/列/索引/外键/触发器/时区），
本文件只管内容。

为什么不是「数一下行数就完事」：行数相同而内容错位是搬数据最典型的坏法 —— 列错位、
转义把 `\\t` 吃进值里、NULL 被当成空串、布尔翻面。所以这里比的是**每一行的每一个字段**：
两边各自归一成同一形状、按行排序、整体比。

退出码：0 = 一致；1 = 有差异（逐条打印）；2 = 连不上/环境不对。

用法：
    python3 scripts/migration/pg/verify_data_parity.py
    PG_DB=… PG_BIN="psql -U …" python3 …/verify_data_parity.py
"""
from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mysql2pg import entity_bools, load_catalog, q_ident  # noqa: E402
from mysql2pg_data import (PG_BIN, PG_DB, identity_col,  # noqa: E402
                           is_str, read_rows)


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


def pg_scalar(sql: str) -> list[list[str]]:
    argv = PG_BIN.split() + ["-d", PG_DB, "-X", "-q", "-t", "-A", "-F", "\t",
                             "-v", "ON_ERROR_STOP=1", "-c", sql]
    r = subprocess.run(argv, capture_output=True)
    if r.returncode != 0:
        sys.exit("psql 失败：%s" % r.stderr.decode("utf-8", "replace").strip())
    return [ln.split("\t") for ln in r.stdout.decode("utf-8").split("\n") if ln != ""]


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
    print("  （结构另判：`python3 scripts/migration/pg/verify_parity.py`）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
