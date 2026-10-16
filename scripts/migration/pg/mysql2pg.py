#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MySQL 的 `saudade_blog` 结构 → PostgreSQL 建表脚本（`0000_schema.sql`）。

**真相源是活库目录，不是 `scripts/migration/*.sql` 的文本。** 理由是同目录 `fresh_install.sh`
头注里那条已经付过学费的教训：`0000_base_schema.sql` 是一份生产库快照，而快照**不保证完整**
（`password_reset_token` 就漏跑了 13 天，代码一直在引用一张不存在的表）。读
`information_schema` 拿到的就是"线上现在真是这样"，不会再被快照漏跑骗第二次。

读的是 `information_schema`（COLUMNS / STATISTICS / TABLE_CONSTRAINTS / KEY_COLUMN_USAGE /
REFERENTIAL_CONSTRAINTS / TABLES），**只读，一条写语句都没有**。

── 两条不由 MySQL 决定、必须另外找依据的规则 ────────────────────────────────
① **`tinyint` 到底是 boolean 还是 smallint**：MySQL 的 `tinyint(1)` 只是**显示宽度**，
   8.0.19 起连存储都不影响它，而本库 11 个 `tinyint(1)` 里既有布尔（`conversation.pinned`）
   也有三值枚举（`quota_request.status` 0/1/2）——**照 `(1)` 判会当场把三值列压成布尔**。
   真依据是 sea-orm 实体（`src/entity/*.rs`）：实体写 `bool` 的才是布尔。本脚本直接读那些
   文件，实体缺席的表（`migration_flags`）一律按 smallint（保值，不丢信息）。
② **`datetime` 用 `timestamp` 还是 `timestamptz`**：本库的约定是「DB 里的值**就是**
   +08:00 本地钟面」（CLAUDE.md《时区约定》），而 `timestamptz` 存的是瞬时、按会话 TimeZone
   来回换算——在 UTC 会话下同一串字面量读出来差 8 小时。选 `timestamp`（无时区）逐字保住
   那个约定，并把库级 TimeZone 钉成 Asia/Shanghai，好让 `DEFAULT CURRENT_TIMESTAMP` 落出来的
   也是本地钟面（否则它按 UTC 落，全库默认值一起偏 8 小时）。

用法：
    python3 scripts/migration/pg/mysql2pg.py > scripts/migration/pg/0000_schema.sql
    MYSQL_BIN="docker exec -i <cid> mysql" python3 …/mysql2pg.py      # 同 fresh_install.sh

连库命令默认 `sudo -n mysql`（本机 root 走 unix socket，无口令）；`MYSQL_BIN` 允许带前缀、
按空格拆词——与 `fresh_install.sh` 同一套约定。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))   # 父仓根（Rust + frontend + scripts）
ENTITY_DIR = os.path.join(REPO, "src", "entity")
SCHEMA = "saudade_blog"
DB_NAME = "saudade_blog"
OWNER = "saudade_app"
MYSQL_BIN = os.environ.get("MYSQL_BIN", "sudo -n mysql")
NO_DEFAULT = "@@NO_DEFAULT@@"


# ── 读 MySQL ────────────────────────────────────────────────────────────────
def _unescape(s: str) -> str:
    """MySQL `--batch` 把 tab/换行/反斜杠转义成 `\\t` `\\n` `\\\\`；这里还原。"""
    if "\\" not in s:
        return s
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            out.append({"n": "\n", "t": "\t", "r": "\r", "0": "\0"}.get(s[i + 1], s[i + 1]))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def query(sql: str) -> list[list[str]]:
    argv = MYSQL_BIN.split() + ["-N", "-B", "-e", sql]
    r = subprocess.run(argv, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("mysql 查询失败（%s）：%s" % (" ".join(argv[:2]), r.stderr.strip()))
    rows = []
    for line in r.stdout.split("\n"):
        if line == "":
            continue
        rows.append([_unescape(f) for f in line.split("\t")])
    return rows


def load_catalog() -> dict:
    """一次把结构读干净。所有 NULL 都用一个显式标记列带出来，**不用哨兵串猜**——
    字符串默认值本身可能就是 `NULL` 四个字母。"""
    cols = {}
    for r in query(f"""
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE,
               IF(COLUMN_DEFAULT IS NULL, '{NO_DEFAULT}', COLUMN_DEFAULT),
               EXTRA, IFNULL(COLUMN_COMMENT,''), ORDINAL_POSITION
          FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA='{SCHEMA}' ORDER BY TABLE_NAME, ORDINAL_POSITION"""):
        cols.setdefault(r[0], []).append({
            "name": r[1], "ctype": r[2], "dtype": r[3], "nullable": r[4] == "YES",
            "default": None if r[5] == NO_DEFAULT else r[5],
            "extra": r[6], "comment": r[7],
        })

    idx = {}
    for r in query(f"""
        SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX,
               IFNULL(COLUMN_NAME,''), IFNULL(EXPRESSION,''), INDEX_TYPE
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA='{SCHEMA}' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"""):
        key = (r[0], r[1])
        e = idx.setdefault(key, {"unique": r[2] == "0", "kind": r[6], "cols": [],
                                 "expr": None, "seq": []})
        e["seq"].append((int(r[3]), r[4], r[5]))
        if r[5]:
            e["expr"] = r[5]

    cons = {}
    for r in query(f"""
        SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, IFNULL(kcu.COLUMN_NAME,''),
               IFNULL(kcu.REFERENCED_TABLE_NAME,''), IFNULL(kcu.REFERENCED_COLUMN_NAME,''),
               kcu.ORDINAL_POSITION
          FROM information_schema.TABLE_CONSTRAINTS tc
          LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
                 ON kcu.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
                AND kcu.CONSTRAINT_NAME=tc.CONSTRAINT_NAME AND kcu.TABLE_NAME=tc.TABLE_NAME
         WHERE tc.CONSTRAINT_SCHEMA='{SCHEMA}'
         ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION"""):
        e = cons.setdefault((r[0], r[1]), {"type": r[2], "cols": [], "ref": None, "refcols": []})
        if r[3]:
            e["cols"].append(r[3])
        if r[4]:
            e["ref"] = r[4]
            e["refcols"].append(r[5])

    rules = {(r[0], r[1]): (r[2], r[3]) for r in query(f"""
        SELECT TABLE_NAME, CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE
          FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA='{SCHEMA}'""")}

    tables = {}
    for r in query(f"""
        SELECT TABLE_NAME, IFNULL(TABLE_COMMENT,''), TABLE_ROWS
          FROM information_schema.TABLES WHERE TABLE_SCHEMA='{SCHEMA}'"""):
        tables[r[0]] = {"comment": r[1], "rows": int(r[2] or 0)}

    return {"cols": cols, "idx": idx, "cons": cons, "rules": rules, "tables": tables}


def entity_bools() -> dict:
    """`src/entity/*.rs` 里声明成 `bool` 的列 —— 见模块头注 ①。"""
    out = {}
    if not os.path.isdir(ENTITY_DIR):
        sys.exit("找不到实体目录 %s（本脚本要在父仓里跑）" % ENTITY_DIR)
    for fn in sorted(os.listdir(ENTITY_DIR)):
        if not fn.endswith(".rs") or fn == "mod.rs":
            continue
        src = open(os.path.join(ENTITY_DIR, fn), encoding="utf-8").read()
        m = re.search(r'#\[sea_orm\(table_name = "([a-z_]+)"\)\]', src)
        if not m:
            continue
        for f in re.finditer(r"^\s*pub (\w+): ([^,]+),", src, re.M):
            if f.group(2).strip() == "bool":
                out[(m.group(1), f.group(1))] = fn
    return out


# ── 翻译 ────────────────────────────────────────────────────────────────────
def q_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def q_lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def pg_type(c: dict, is_bool: bool) -> str:
    t = c["dtype"]
    if t == "int":
        return "integer"
    if t == "tinyint":
        return "boolean" if is_bool else "smallint"
    if t in ("varchar", "char"):
        return c["ctype"]                    # varchar(N) / char(N) 逐字保留
    if t in ("text", "longtext"):
        return "text"
    if t == "datetime":
        return "timestamp"                   # 见模块头注 ②：无时区，保住 +08:00 钟面
    if t == "date":
        return "date"
    if t == "double":
        return "double precision"
    sys.exit("没见过的类型 %s（列 %s）—— 别猜，先看清它是什么" % (t, c["name"]))


def pg_default(c: dict, is_bool: bool) -> str | None:
    d = c["default"]
    if d is None:
        return None
    if d.upper() == "CURRENT_TIMESTAMP":
        return "CURRENT_TIMESTAMP"
    if is_bool:
        return "true" if d == "1" else "false"
    if c["dtype"] in ("int", "tinyint", "double"):
        return d
    return q_lit(d)


def column_line(c: dict, is_bool: bool) -> str:
    parts = [q_ident(c["name"]), pg_type(c, is_bool)]
    if c["extra"] == "auto_increment":
        # BY DEFAULT（不是 ALWAYS）：MySQL 的 AUTO_INCREMENT 允许显式插 id，语义要一致
        parts.append("GENERATED BY DEFAULT AS IDENTITY")
    if not c["nullable"]:
        parts.append("NOT NULL")
    d = pg_default(c, is_bool)
    if d is not None:
        parts.append("DEFAULT " + d)
    return "  " + " ".join(parts)


def index_stmt(table: str, name: str, e: dict) -> str:
    """非主键索引一律出成独立 `CREATE INDEX`：名字集中在一处，且建表语句读得动。
    `INDEX_TYPE='FULLTEXT'` 的不在这里——PG 没有这一档，见头注的《对不上的》。"""
    cols = ", ".join(x[1] for x in sorted(e["seq"]))
    uniq = "UNIQUE " if e["unique"] else ""
    return ("CREATE %sINDEX IF NOT EXISTS %s ON %s (%s);"
            % (uniq, q_ident(name), q_ident(table), cols))


def colliding_indexes(cat: dict) -> dict:
    """**MySQL 的索引名是表级的，PG 的是 schema 级的。** 同名两条在不同表上，PG 第二条会
    静默落进 `IF NOT EXISTS` 分支 —— 那张表就少一个索引，而 psql 只印一行 NOTICE。
    本库现有一对：`chat_history.idx_conv_id` 与 `execution_log.idx_conv_id`。
    撞名的**双方**都改成 `<表>_<原名>`（只改后到的那条会让命名取决于表的字母序，读不出意图）。"""
    seen: dict[str, list[str]] = {}
    for (t, n) in cat["idx"]:
        if n == "PRIMARY":
            continue
        seen.setdefault(n, []).append(t)
    return {n: sorted(ts) for n, ts in seen.items() if len(ts) > 1}


def index_name(table: str, name: str, clash: dict) -> str:
    return "%s_%s" % (table, name) if name in clash else name


def emit(cat: dict, bools: dict) -> str:
    L: list[str] = []
    add = L.append
    onupdate: list[str] = []
    fulltext: list[str] = []
    clash = colliding_indexes(cat)

    add("-- ⚠️ 本文件由 `scripts/migration/pg/mysql2pg.py` 生成，别手改。")
    add("--    改结构 = 先改 MySQL 那边（`scripts/migration/` 的增量迁移），再重跑生成器。")
    add("")
    add("-- 重跑生成：")
    add("--   python3 scripts/migration/pg/mysql2pg.py > scripts/migration/pg/0000_schema.sql")
    add("-- 从零建库（库是全新的，所以直接 DROP 重来比「补跑」干净）：")
    add("--   psql -c \"DROP DATABASE IF EXISTS %s\"" % DB_NAME)
    add("--   psql -c \"CREATE ROLE %s LOGIN\"            # 一次性；口令**不在这里设**" % OWNER)
    add("--   psql -c \"CREATE DATABASE %s OWNER %s ENCODING 'UTF8' \\" % (DB_NAME, OWNER))
    add("--             LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0\"")
    add("--   psql -d %s -v ON_ERROR_STOP=1 -f scripts/migration/pg/0000_schema.sql" % DB_NAME)
    add("-- 判据（把 PG 目录读回来跟 MySQL 目录逐列对账；改坏任何一项都会红）：")
    add("--   python3 scripts/migration/pg/verify_parity.py")
    add("")
    add("-- 只建**结构**，一行数据都不搬 —— 搬数据是下一步的事，且那一步要先 `setval` 自增序列。")
    add("")
    add("-- 幂等性（20261017 实测，不是推测）：在已建好的库上重跑一遍 ⇒ **74 条 NOTICE + 12 条 ERROR**。")
    add("--   · NOTICE 全来自 `IF NOT EXISTS`（29 张表 + 45 个索引），是设计如此；")
    add("--   · 12 条 ERROR 全是 `ALTER TABLE … ADD CONSTRAINT … already exists`（外键那一节），")
    add("--     那是**唯一**不幂等的一节；触发器走 `CREATE OR REPLACE`、索引与表走 `IF NOT EXISTS`。")
    add("--   结构不受影响（重跑后判据照绿）。要干净就 DROP 重建 —— 与 MySQL 那边的")
    add("--   `fresh_install.sh` 同一立场（它也是显式不幂等、要求先 DROP）。")
    add("")
    add("-- 时区：库级钉成 Asia/Shanghai。`timestamp` 无时区，`DEFAULT CURRENT_TIMESTAMP`")
    add("-- 按**会话** TimeZone 折算 —— 不钉的话这台机器的 UTC 缺省会把每个默认值偏 8 小时。")
    add('ALTER DATABASE %s SET timezone TO %s;' % (q_ident(DB_NAME), q_lit("Asia/Shanghai")))
    add("")

    for table in sorted(cat["cols"]):
        cols = cat["cols"][table]
        pk = cat["cons"].get((table, "PRIMARY"))
        add("-- ── %s（%d 列）" % (table, len(cols)))
        add("CREATE TABLE IF NOT EXISTS %s (" % q_ident(table))
        body = [column_line(c, (table, c["name"]) in bools) for c in cols]
        if pk:
            body.append("  CONSTRAINT %s PRIMARY KEY (%s)"
                        % (q_ident(table + "_pkey"), ", ".join(q_ident(c) for c in pk["cols"])))
        add(",\n".join(body))
        add(");")
        if cat["tables"][table]["comment"]:
            add("COMMENT ON TABLE %s IS %s;" % (q_ident(table), q_lit(cat["tables"][table]["comment"])))
        for c in cols:
            if c["comment"]:
                add("COMMENT ON COLUMN %s.%s IS %s;"
                    % (q_ident(table), q_ident(c["name"]), q_lit(c["comment"])))
        add("")

        for (t, name), e in sorted(cat["idx"].items()):
            if t != table or name == "PRIMARY":
                continue
            if e["kind"] == "FULLTEXT":
                fulltext.append("%s.%s (%s)" % (table, name, ", ".join(x[1] for x in e["seq"])))
                continue
            expr = e["expr"]
            if expr:
                # 表达式唯一索引（`user.uk_user_nickname`）。MySQL 印出来的表达式里
                # 有反引号与 `_utf8mb4\'\\'` 这类字符集引子，PG 两个都不认 ⇒ 按语义重写。
                if "nullif(trim" in expr.lower():
                    add("CREATE UNIQUE INDEX IF NOT EXISTS %s ON %s ((NULLIF(TRIM(%s), '')));"
                        % (q_ident(index_name(table, name, clash)), q_ident(table),
                           q_ident("nickname")))
                    continue
                sys.exit("没见过的表达式索引 %s.%s：%s —— 别猜" % (table, name, expr))
            add(index_stmt(table, index_name(table, name, clash), e))
        add("")

        for c in cols:
            if "on update CURRENT_TIMESTAMP" in c["extra"]:
                onupdate.append(table)
                break

    add("-- ── 外键：一律出成独立的 ALTER，建表顺序就无所谓了")
    for (table, name), e in sorted(cat["cons"].items()):
        if e["type"] != "FOREIGN KEY":
            continue
        upd, dele = cat["rules"].get((table, name), ("NO ACTION", "NO ACTION"))
        add('ALTER TABLE %s ADD CONSTRAINT %s FOREIGN KEY (%s) REFERENCES %s (%s)'
            % (q_ident(table), q_ident(name),
               ", ".join(q_ident(c) for c in e["cols"]),
               q_ident(e["ref"]), ", ".join(q_ident(c) for c in e["refcols"]))
            + " ON UPDATE %s ON DELETE %s;" % (upd, dele))
    add("")

    add("-- ── `ON UPDATE CURRENT_TIMESTAMP` 的替身（PG 没有这一档）")
    add("-- MySQL 的规则是「**别的列**变了才自动刷新；updated_at 被显式赋值时不刷新；")
    add("-- 整行没变也不刷新」。下面这两件合起来复刻它：")
    add("--   · `WHEN (OLD.* IS DISTINCT FROM NEW.*)` —— 整行没变就不进函数；")
    add("--   · 函数里 `IS NOT DISTINCT FROM` 那一格 —— 显式赋了新值的照用新值。")
    add("-- ⚠️ 复刻不到的一格（如实记）：显式把 updated_at 赋成**原来的值**、同时改了别的列。")
    add("--    MySQL 认「显式赋值」⇒ 不动；本实现看不出「没赋值」与「赋了个同值」的差别 ⇒ 会刷成 now()。")
    add("--    本库现有代码里这么写的只有 conversation / note 两张表，而它们**没有** ON UPDATE")
    add("--    （见 routes/conversation.rs:408、routes/tags.rs:572）⇒ 今天踩不到；")
    add("--    将来谁在这 %d 张表上这么写，就是这一格。" % len(onupdate))
    add("CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$")
    add("BEGIN")
    add("  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN")
    add("    NEW.updated_at := now();")
    add("  END IF;")
    add("  RETURN NEW;")
    add("END $$;")
    add("")
    for table in onupdate:
        add("CREATE OR REPLACE TRIGGER %s BEFORE UPDATE ON %s"
            % (q_ident("trg_" + table + "_updated_at"), q_ident(table)))
        add("  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();")
    add("")
    add("-- 注：`set_updated_at` 是**不带 schema 前缀的**函数名，与 checkpoint 那套（`agent_checkpoint` 库）")
    add("--     各自在自己的库里，互不可见。")
    add("")

    add("-- ═══ 对不上的（生成时登记，逐条要有人拍板）═══════════════════════════════")
    add("-- ① FULLTEXT 索引没有对应物：%s。" % (", ".join(fulltext) or "无"))
    add("--    消费方核查：`src/routes/knowledge.rs` 只有 find/insert/delete_by_id，")
    add("--    **没有 MATCH … AGAINST** ⇒ 线上没人读它，本脚本直接不生成，不假装能等价。")
    add("--    真要全文检索，正解是 `to_tsvector` + GIN 或 pg_trgm，那是另立一件事。")
    add("-- ② **排序规则语义**：MySQL 这边 74 列 `utf8mb4_0900_ai_ci`、12 列 `utf8mb4_unicode_ci`，")
    add("--    两套都是**大小写不敏感 + 重音不敏感**；PG 这个簇是 `en_US.UTF-8`（libc），")
    add("--    `=` 与 UNIQUE **都大小写敏感**。⇒ `user.username` 的唯一键在 MySQL 上把 `Alice`")
    add("--    与 `alice` 当同一个，在 PG 上会放行两条。")
    add("--    **20261017 已拍板：登录按大小写** ⇒ PG 的出厂行为**就是**目标行为，")
    add("--    本文件因此一个字都不用改（这也是当初把它登记成「待拍板」而不是「待修」的原因）。")
    add("--    连带的三条后果都核过，不是推测：")
    add("--      a) 应用层查重与索引口径**仍然一致**。`routes/auth.rs:79`（登录）与")
    add("--         `routes/temp_user.rs:897`（管理员建号查重）都是 `Username.eq(...)`，")
    add("--         它们在 PG 上跟着一起变成大小写敏感 ⇒ 不会出现「索引放行、应用拦下」的半截状态。")
    add("--      b) 存量 16 个用户里 `PengMX` / `Lingyuemiao` 这类混写名，**登录时必须敲对大小写**")
    add("--         （MySQL 上敲错大小写照样进得来）。这是这次决定真正会被用户感知到的唯一一格。")
    add("--      c) 重音不敏感那一半**没跟着回来**：`café` 与 `cafe` 在 PG 上仍是两个人。")
    add("--         本库用户名全是 ASCII、今天零实例；登记它是为了将来有人加非 ASCII 用户名时能想起来。")
    add("--    同一件事也在 `uk_user_nickname` 上（昵称唯一键同样从「不敏感」变「敏感」）——")
    add("--    昵称没有登录语义，只在展示与回执里出现（`routes/notes.rs:943`），故不单列一条后果。")
    add("--    被否掉的另外三条（citext / `lower()` 函数索引 / ICU 排序规则）**不再需要**：")
    add("--    它们存在的唯一理由是「让 PG 装成 MySQL 那样不敏感」，前提反过来之后就没有议题了。")
    add("-- ③ `PRIMARY` 约束名在 PG 里一律叫 `<表>_pkey`（MySQL 恒为 `PRIMARY`）。")
    add("--    没有消费方按这个名字引用（sea-orm 不看约束名），登记是为了让 diff 有解释。")
    add("-- ④ 自增序列：`GENERATED BY DEFAULT AS IDENTITY` 从 1 起。**倒数据时要 `setval`**，")
    add("--    否则第一批 INSERT 会撞主键 —— 那是搬数据那一步的事，本文件只管结构。")
    add("-- ⑤ **索引名改了**（MySQL 的索引名是表级的，PG 的是 schema 级的）：")
    for n, ts in sorted(clash.items()):
        add("--      `%s` 在 %s 上重名 ⇒ 都改成 `<表>_%s`。"
            % (n, " 与 ".join(ts), n))
    add("--    不改的话 PG 第二条会静默落进 `IF NOT EXISTS`，那张表**少一个索引**而 psql 只印一行 NOTICE")
    add("--    （首跑实测：`execution_log` 的 `idx_conv_id` 就是这么丢的）。改名的代价是")
    add("--    「按名字引索引」的地方要跟着改 —— 本仓没有这样的地方（全是 sea-orm，不看索引名）。")
    add("")
    add("-- 生成时读数：%d 张表 / %d 列 / %d 个索引 / %d 条外键 / %d 张带 ON UPDATE 触发器。"
        % (len(cat["cols"]), sum(len(v) for v in cat["cols"].values()),
           len(cat["idx"]), sum(1 for e in cat["cons"].values() if e["type"] == "FOREIGN KEY"),
           len(onupdate)))
    return "\n".join(L) + "\n"


def main() -> None:
    cat = load_catalog()
    bools = entity_bools()
    for (t, c), fn in bools.items():
        got = cat["cols"].get(t, [])
        if not any(x["name"] == c for x in got):
            sys.exit("实体 %s 说 %s.%s 是 bool，MySQL 里没这一列 —— 两边已经漂了" % (fn, t, c))
        col = next(x for x in got if x["name"] == c)
        if col["dtype"] != "tinyint":
            sys.exit("实体 %s 说 %s.%s 是 bool，MySQL 类型却是 %s —— 两边已经漂了"
                     % (fn, t, c, col["ctype"]))
    sys.stdout.write(emit(cat, bools))


if __name__ == "__main__":
    main()
