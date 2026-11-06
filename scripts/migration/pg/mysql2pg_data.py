#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 MySQL 的 `saudade_blog` **数据**搬进 PG 的同名库（结构由同目录 `0000_schema.sql` 建）。"""
from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mysql2pg import (DB_NAME, MYSQL_BIN, SCHEMA, _unescape,  # noqa: E402
                      entity_bools, load_catalog, q_ident, q_lit)

PG_BIN = os.environ.get("PG_BIN", "sudo -n -u postgres psql")
PG_DB = os.environ.get("PG_DB", DB_NAME)

# 字符串列的 NULL 哨兵。不含 `%` `_`（LIKE 元字符），也不含引号与反斜杠。
NULL_SENTINEL = "@@SAUDADE_NULL@@"
STR_TYPES = ("varchar", "char", "text", "longtext")


# 读 MySQL
def query_raw(sql: str) -> list[list[str]]:
    """读 MySQL。**走字节**（头注 ①）：`text=True` 的 universal-newlines 会把裸 CR 翻成 LF。

    `--default-character-set=utf8mb4` 是显式的：客户端默认字符集跟着环境（LANG）走，
    不钉住的话同一份数据在不同 shell 下读出来的字节可能不是一个东西。
    """
    argv = MYSQL_BIN.split() + ["--default-character-set=utf8mb4", "-N", "-B", "-e", sql]
    r = subprocess.run(argv, capture_output=True)
    if r.returncode != 0:
        sys.exit("mysql 查询失败：%s" % r.stderr.decode("utf-8", "replace").strip())
    text = r.stdout.decode("utf-8")
    return [[_unescape(f) for f in ln.split("\t")] for ln in text.split("\n") if ln != ""]


def is_str(c: dict) -> bool:
    return c["dtype"] in STR_TYPES


def select_sql(cat: dict, table: str) -> str:
    cols = cat["cols"][table]
    proj = []
    for c in cols:
        if is_str(c):
            proj.append("IF(`%s` IS NULL, %s, `%s`)"
                        % (c["name"], q_lit(NULL_SENTINEL), c["name"]))
        else:
            proj.append("`%s`" % c["name"])
    pk = cat["cons"].get((table, "PRIMARY"))
    order = ""
    if pk:
        order = " ORDER BY " + ", ".join("`%s`" % c for c in pk["cols"])
    return "SELECT %s FROM `%s`.`%s`%s" % (", ".join(proj), SCHEMA, table, order)


def read_rows(cat: dict, table: str) -> list[list[str | None]]:
    """MySQL 的原始文本，NULL 归一成 None。**不做类型翻译**（翻译在 to_pg 里）。

    判据 `verify_data_parity.py` 直接复用本函数 —— 两边读的是同一份投影，
    "读法本身有偏" 这种错就不会被对账掩盖过去。
    """
    cols = cat["cols"][table]
    out = []
    for r in query_raw(select_sql(cat, table)):
        if len(r) != len(cols):
            sys.exit("%s：拿到 %d 列，目录里是 %d 列 —— 字段被撕开了（先查头注 ①）"
                     % (table, len(r), len(cols)))
        row = []
        for v, c in zip(r, cols):
            if is_str(c):
                row.append(None if v == NULL_SENTINEL else v)
            else:
                row.append(None if v == "NULL" else v)
        out.append(row)
    return out


# 写 PG
_COPY_ESC = {"\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r",
             "\b": "\\b", "\f": "\\f", "\v": "\\v"}


def copy_field(v: str | None) -> str:
    """PG `COPY … FROM stdin` 的 text 格式。反斜杠**必须先转**，否则 `\\N` 会被读成 NULL。"""
    if v is None:
        return "\\N"
    return "".join(_COPY_ESC.get(ch, ch) for ch in v)


def to_pg(v: str | None, c: dict, is_bool: bool, where: str) -> str | None:
    if v is None:
        return None
    if is_bool:
        if v not in ("0", "1"):
            sys.exit("%s 是布尔列，值却是 %r —— 这列其实不是布尔，回去改结构（头注 ③）"
                     % (where, v))
        return "true" if v == "1" else "false"
    return v


def identity_col(cat: dict, table: str) -> dict | None:
    return next((c for c in cat["cols"][table] if c["extra"] == "auto_increment"), None)


def build_script(cat: dict, bools: dict) -> str:
    L: list[str] = []
    add = L.append
    tables = sorted(cat["cols"])

    add("BEGIN;")
    # 装载期间关外键与用户触发器（要 superuser）。TRUNCATE 让本脚本可重复跑。
    add("SET session_replication_role = replica;")
    add("TRUNCATE TABLE %s RESTART IDENTITY CASCADE;" % ", ".join(q_ident(t) for t in tables))
    add("")

    for t in tables:
        cols = cat["cols"][t]
        add("COPY %s (%s) FROM stdin;"
            % (q_ident(t), ", ".join(q_ident(c["name"]) for c in cols)))
        for row in read_rows(cat, t):
            add("\t".join(copy_field(to_pg(v, c, (t, c["name"]) in bools, "%s.%s" % (t, c["name"])))
                          for v, c in zip(row, cols)))
        add("\\.")
        add("")

    add("-- 自增序列归位（`0000_schema.sql` 头注 ④：显式插了 id，序列还停在 1）")
    for t in tables:
        idc = identity_col(cat, t)
        if not idc:
            continue
        n = q_ident(idc["name"])
        tn = q_ident(t)
        add("SELECT setval(pg_get_serial_sequence(%s, %s), "
            "COALESCE((SELECT MAX(%s) FROM %s), 1), "
            "(SELECT MAX(%s) FROM %s) IS NOT NULL);"
            % (q_lit(t), q_lit(idc["name"]), n, tn, n, tn))
    add("")
    add("COMMIT;")
    return "\n".join(L) + "\n"


def apply_script(script: str) -> None:
    argv = PG_BIN.split() + ["-d", PG_DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"]
    p = subprocess.Popen(argv, stdin=subprocess.PIPE)
    try:
        p.communicate(script.encode("utf-8"))       # 以 bytes 传给子进程，避免隐式文本编码转换
    except BrokenPipeError:
        pass
    if p.returncode != 0:
        sys.exit("psql 退出码 %d —— 上面那几行就是原因（本笔已整体回滚）" % p.returncode)


def pg_scalar(sql: str) -> list[list[str]]:
    """读 PG，按制表符切。**只此一份** —— `verify_data_parity.py` 也从这里 import。
    两个文件各写一份 psql 调用的话，口径一漂，对账就变成自己骗自己。"""
    argv = PG_BIN.split() + ["-d", PG_DB, "-X", "-q", "-t", "-A", "-F", "\t",
                             "-v", "ON_ERROR_STOP=1", "-c", sql]
    r = subprocess.run(argv, capture_output=True)
    if r.returncode != 0:
        sys.exit("psql 失败：%s" % r.stderr.decode("utf-8", "replace").strip())
    return [ln.split("\t") for ln in r.stdout.decode("utf-8").split("\n") if ln != ""]


# 切流之后不许误跑（`--apply` 的第二道点名）
# 本脚本开头是 `TRUNCATE TABLE 那 29 张表 RESTART IDENTITY CASCADE`。PG 今天没有任何读方
# ⇒ 误跑一次爆炸半径为零；**切流那天起，误跑一次就是把生产库清空**。
# 所以 `--apply` 不再够用，真搬要再点一次名。
#
# **为什么是 flag，而不是"探测有没有人连着"**：探测的结果**会变**（今天没人连、明天有人连），
# 而闸必须在切流前后给同一个答案 —— 否则它绿的是"今天没事"，不是"这个动作不危险"。
# 连接探测另有用处（告诉你正要抽掉谁脚下的地毯），所以两件都做：**flag 是闸，探测是信息**。
WIPE_FLAG = "--i-know-this-wipes-pg"


def refuse_wipe(tables: list[str]) -> None:
    sys.exit(
        "拒绝执行：`--apply` 开头是 `TRUNCATE TABLE %s RESTART IDENTITY CASCADE`。\n"
        "  PG 今天没有读方 ⇒ 误跑一次爆炸半径为零；**切流之后，误跑一次就是把生产库清空**。\n"
        "  真搬请再点一次名：  --apply %s\n"
        "  （这道闸与「今天有没有人连着」无关 —— 闸要在切流前后给同一个答案。）"
        % ("、".join(tables[:3]) + ("…" if len(tables) > 3 else ""), WIPE_FLAG))


def live_readers() -> list[str]:
    """谁正连着这个库。**只是信息，不是闸**（理由见上面 `WIPE_FLAG`）。"""
    return ["%s/%s ×%s" % (a or "(无名)", u or "?", n) for a, u, n in pg_scalar(
        "SELECT COALESCE(application_name,''), COALESCE(usename,''), count(*)::text"
        "  FROM pg_stat_activity"
        " WHERE datname = %s AND pid <> pg_backend_pid()"
        "   AND backend_type = 'client backend'"
        " GROUP BY 1, 2 ORDER BY 1, 2" % q_lit(PG_DB))]


# 干跑：只查不写
def dry_run(cat: dict, bools: dict) -> int:
    tables = sorted(cat["cols"])
    bad = 0

    print("── 哨兵冲突扫描（头注 ②）──────────────────────────────────────")
    hit = []
    for t in tables:
        conds = ["`%s` LIKE %s" % (c["name"], q_lit("%" + NULL_SENTINEL + "%"))
                 for c in cat["cols"][t] if is_str(c)]
        if not conds:
            continue
        n = int(query_raw("SELECT COUNT(*) FROM `%s`.`%s` WHERE %s"
                          % (SCHEMA, t, " OR ".join(conds)))[0][0])
        if n:
            hit.append("%s：%d 行" % (t, n))
    print("   " + ("；".join(hit) if hit else "干净：哨兵串在库里一个字都没出现"))
    bad += len(hit)

    print("── 布尔列取值扫描（头注 ③）────────────────────────────────────")
    bh = []
    for (t, c) in sorted(bools):
        n = int(query_raw("SELECT COUNT(*) FROM `%s`.`%s` WHERE `%s` NOT IN (0,1) "
                          "AND `%s` IS NOT NULL" % (SCHEMA, t, c, c))[0][0])
        if n:
            bh.append("%s.%s：%d 行不是 0/1" % (t, c, n))
    print("   " + ("；".join(bh) if bh else "%d 个布尔列，取值全是 0/1 或 NULL" % len(bools)))
    bad += len(bh)

    print("── 计划 ───────────────────────────────────────────────────────")
    total = 0
    for t in tables:
        n = int(query_raw("SELECT COUNT(*) FROM `%s`.`%s`" % (SCHEMA, t))[0][0])
        total += n
        mark = " (空表)" if n == 0 else ""
        idc = identity_col(cat, t)
        print("   %-24s %6d 行%s%s" % (t, n, "  setval " + idc["name"] if idc else "", mark))
    print("   " + "-" * 46)
    print("   %-24s %6d 行 / %d 张表" % ("合计", total, len(tables)))
    print()
    print("干跑结束（一个字都没写）。真搬：加 --apply")
    return 1 if bad else 0


def main() -> int:
    args = sys.argv[1:]
    apply = "--apply" in args
    cat = load_catalog()
    bools = entity_bools()

    if not apply:
        return dry_run(cat, bools)

    # 第一道：切流之后 `--apply` 就是"清空生产库"。**先拒、再干跑** ——
    # 少敲一个 flag 的人不该先看到一整份计划再被拒（那会让人以为"只差一步"）。
    if WIPE_FLAG not in args:
        refuse_wipe(sorted(cat["cols"]))

    # 真搬也先过一遍干跑的闸：哨兵冲突 / 布尔越界必须在装载之前挡住
    if dry_run(cat, bools) != 0:
        sys.exit("上面有红项 —— 先弄清是什么，别硬搬")
    print("── 装载 ───────────────────────────────────────────────────────")
    readers = live_readers()
    print("   ⚠️ 接下来会 TRUNCATE 这 %d 张表。此刻连着这个库的：%s"
          % (len(cat["cols"]), "、".join(readers) if readers else "没有别人"))
    apply_script(build_script(cat, bools))
    print("   psql 退出码 0（整笔在一个事务里，任何一步失败整体回滚）")
    print()
    print("对账：python3 scripts/migration/pg/verify_data_parity.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
