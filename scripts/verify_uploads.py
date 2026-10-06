#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核对"库里引用的本地图"与"盘上真实存在的文件"。

**为什么需要它**：上传件的字节是本项目**唯一一件只在盘上、不在库里**的数据
（文章正文与封面存的是指向它的 URL）。迁移或恢复时漏拷那个目录，表现不是报错，
而是"某几篇文章的图静默 404"——往往几周后才被人发现。这个脚本把那条隐性风险
变成一个数字：**有多少张正在被引用的图，在盘上找不到**。
它同时是迁移/恢复的**验收判据**：跑出「严重 0」就说明这次搬家是完整的。

**缺图分两类，严重程度不同**：
  · 严重 —— 文章封面或正文正在引用的本地图，盘上没有 ⇒ 访客看到的就是破图；
  · 提示 —— 只在图库表里挂着、没有任何文章用它，盘上也没有 ⇒ 多半是删过的
            孤儿记录，不影响站点。
R2 的图是绝对 URL（`http(s)://…`），字节不在本机盘上，**单独计数、不判缺失**。

**退出码**：有严重缺图 ⇒ 1；否则 0。（「盘上有、库里没记录」不算失败。）

**用法**：
    python3 scripts/verify_uploads.py                # 人看
    python3 scripts/verify_uploads.py --json         # 机器读
    python3 scripts/verify_uploads.py --uploads-dir /srv/uploads   # 覆盖 .env 的 UPLOAD_DIR
    python3 scripts/verify_uploads.py --self-test    # 只跑纯函数自检，不连库

**凭据**只从仓库根的 `.env`（或同名环境变量）读，**不打印**：默认交给 mysql 客户端的
是一个 0600 的临时 `--defaults-extra-file`，用完即删（`mysql -p<密码>` 在本机 `ps` 里
对同机其他用户可见，所以不用那种写法）。`MYSQL_BIN` 给了前缀时（CI 用
`docker exec -i <容器> mysql`，见 `scripts/migration/fresh_install.sh`）临时文件在容器里
不存在，只能退回 `-u/-p` 参数——那条路**只配一次性容器口令，别配生产口令**。
"""
import argparse
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]

# 本地图的 URL 前缀，与 Rust 侧 `routes/mod.rs` 的 nest_service 路径、
# 落库时拼出来的串同源（改一处就要改这里）。
LOCAL_PREFIX = "/api/protect/download/"

# 正文里抽 URL：止于引号/括号/空白，以及中文标点与右半括号（markdown 的 `![x](url)`
# 和 HTML 的 `src="url"` 都靠这个收口）。url 本身不会有这些字符。
_URL_RE = re.compile(r"/api/protect/download/[^\s\"'()<>\[\]，。；、）】》]+")


def load_env(root=ROOT):
    """读仓库根的 `.env`（只做 `KEY=VALUE`，不执行任何东西）。
    环境变量优先——CI 或 `export $(…)` 之后跑时，不必再依赖文件在不在。"""
    env = {}
    f = root / ".env"
    if f.is_file():
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    for k in ("DATABASE_URL", "UPLOAD_DIR"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def parse_mysql_url(url):
    """`mysql://user:pass@host:port/db` → (user, password, host, port, db)。
    口令按 URL 规则解码（`@` `:` 等会被百分号转义），所以先从**最后一个** `@` 切。"""
    m = re.match(r"^mysql://(.+)$", url or "")
    if not m:
        return None
    rest = m.group(1)
    if "/" not in rest:
        return None
    head, db = rest.rsplit("/", 1)
    db = db.split("?", 1)[0]
    if "@" not in head:
        return None
    cred, hostpart = head.rsplit("@", 1)
    user, _, password = cred.partition(":")
    user = urllib.parse.unquote(user)
    password = urllib.parse.unquote(password)
    if ":" in hostpart:
        host, _, port = hostpart.partition(":")
    else:
        host, port = hostpart, "3306"
    host = host or "127.0.0.1"
    return user, password, host, port or "3306", db


def url_to_relpath(url):
    """本地图 URL → UPLOAD_DIR 下的相对路径（已做百分号解码与穿越拦截）。
    不是本地图、或解出来会跑出 UPLOAD_DIR 的，返回 None。"""
    if not url.startswith(LOCAL_PREFIX):
        return None
    raw = urllib.parse.unquote(url[len(LOCAL_PREFIX):].split("?", 1)[0].split("#", 1)[0])
    rel = os.path.normpath(raw)
    if rel.startswith(("..", "/")) or os.path.isabs(rel):
        return None
    return rel


def extract_local_urls(text):
    """从正文里抽出全部本地图 URL（去重前，保持顺序）。"""
    if not text:
        return []
    return _URL_RE.findall(text)


def _self_test():
    """纯函数自检 —— URL 解析是这里最容易悄悄错掉的一段（错了就是"永远 0 缺图"
    的假绿），所以让它不连库也能验。"""
    fails = []

    def ck(desc, got, want):
        if got != want:
            fails.append(f"{desc}: 得到 {got!r}，期望 {want!r}")

    ck("连库串解析", parse_mysql_url("mysql://u:p%40w@127.0.0.1:3306/blog"),
       ("u", "p@w", "127.0.0.1", "3306", "blog"))
    ck("缺端口回落 3306", parse_mysql_url("mysql://u:p@db:3306/blog")[3], "3306")
    ck("非 mysql 串", parse_mysql_url("postgres://x"), None)

    ck("本地图取相对路径", url_to_relpath("/api/protect/download/2026_a.png"), "2026_a.png")
    ck("中文名要解码", url_to_relpath("/api/protect/download/2026_%E5%9B%BE.png"), "2026_图.png")
    ck("子目录（头像）", url_to_relpath("/api/protect/download/avatars/1_x.jpg"), "avatars/1_x.jpg")
    ck("带 query 要切掉", url_to_relpath("/api/protect/download/a.png?x=1"), "a.png")
    ck("R2 绝对地址不算本地", url_to_relpath("https://img.example.com/a.png"), None)
    ck("穿越要拦住", url_to_relpath("/api/protect/download/../../etc/passwd"), None)

    body = '前 ![图](/api/protect/download/2026_a.png) 后 <img src="/api/protect/download/2026_b.png">'
    ck("正文抽两个", extract_local_urls(body),
       ["/api/protect/download/2026_a.png", "/api/protect/download/2026_b.png"])
    ck("中文标点收口", extract_local_urls("见 /api/protect/download/x.png，如图"),
       ["/api/protect/download/x.png"])
    ck("空正文", extract_local_urls(""), [])

    for f in fails:
        print("  ❌ " + f)
    print("自检 " + ("全部通过" if not fails else f"失败 {len(fails)} 项"))
    return 1 if fails else 0


def mysql_rows(conn, sql):
    """跑一条查询，返回按 tab 切好的行。

    凭据怎么进 mysql 客户端，按有没有 `MYSQL_BIN` 分两条路（这个开关照抄
    `scripts/migration/fresh_install.sh`：`MYSQL_BIN="docker exec -i <容器> mysql"`）：

    · 默认（本机装了客户端）：一个 0600 的临时 `--defaults-extra-file`，用完即删。
      **不用 `-p<密码>`**：那串在本机 `ps` 里对同机其他用户可见。
    · 给了 `MYSQL_BIN` 前缀（CI 就是这么跑的，runner 上没有客户端）：临时文件在
      **容器里不存在**，只能走 `-u/-p` 参数。CI 用的是随 runner 消亡的一次性容器口令，
      与生产库无关，所以这个例外是可接受的——**别把生产的口令配到这条路上**。
    """
    user, password, host, port, db = conn
    prefix = shlex.split(os.environ.get("MYSQL_BIN", "mysql"))

    path = None
    if len(prefix) == 1:  # 真·本机客户端 ⇒ 走临时文件那条安全的路
        fd, path = tempfile.mkstemp(prefix="verify-uploads-")
        os.write(fd, f"[client]\nuser={user}\npassword={password}\n".encode("utf-8"))
        os.close(fd)
        os.chmod(path, 0o600)
        cred = [f"--defaults-extra-file={path}"]
    else:
        cred = [f"-u{user}", f"-p{password}"]

    try:
        out = subprocess.run(
            prefix + cred + ["-h", host, "-P", port,
                             # 显式定字符集：库里存着中文标题，客户端默认字符集不确定时会乱码
                             # （记过同类事故：LANG 空 ⇒ latin1 ⇒ 中文标识符报 1064）
                             "--default-character-set=utf8mb4", "-N", "-B", db, "-e", sql],
            capture_output=True, text=True, errors="replace")
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
    if out.returncode != 0:
        raise RuntimeError((out.stderr or "").strip()[:400] or "mysql 退出码非 0")
    return [line.split("\t") for line in out.stdout.splitlines() if line]


def collect(conn):
    """把"库里引用了哪些本地图"汇总成 url → 引用者列表。"""
    refs = {}

    def add(url, who):
        if url:
            refs.setdefault(url, []).append(who)

    for row in mysql_rows(conn, "SELECT image_url FROM images"):
        add(row[0].strip(), None)  # 图库里挂着的（不一定有人用）

    for row in mysql_rows(conn,
                          "SELECT id, title, IFNULL(cover, '') FROM note "
                          "WHERE cover IS NOT NULL AND cover <> ''"):
        add(row[2].strip(), f"文章 {row[0]}《{(row[1] or '').strip()[:24]}》封面")

    # 正文只捞**含本地图前缀的那些行**，不让整库正文过大
    for row in mysql_rows(conn,
                          "SELECT id, title, content FROM note "
                          f"WHERE content LIKE '%{LOCAL_PREFIX}%'"):
        who = f"文章 {row[0]}《{(row[1] or '').strip()[:24]}》正文"
        for u in extract_local_urls(row[2] if len(row) > 2 else ""):
            add(u, who)

    # 用户头像住在 `user.avatar`（**不进 images 表**）。漏了这一句，盘上那几张头像
    # 就会全部落进"库里没有记录"那一桶——而它们恰恰也是迁移时必须跟着走的东西。
    for row in mysql_rows(conn,
                          "SELECT id, IFNULL(avatar, '') FROM user "
                          f"WHERE avatar LIKE '%{LOCAL_PREFIX}%'"):
        add(row[1].strip(), f"用户 {row[0]} 的头像")
    return refs


def main():
    ap = argparse.ArgumentParser(description="核对库里引用的本地图与盘上文件")
    ap.add_argument("--uploads-dir", help="覆盖 .env 里的 UPLOAD_DIR")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--self-test", action="store_true", help="只跑纯函数自检")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()

    env = load_env()
    conn = parse_mysql_url(env.get("DATABASE_URL", ""))
    if not conn:
        print("✗ 读不到 DATABASE_URL（看仓库根的 .env，或用环境变量给）", file=sys.stderr)
        return 2
    udir = args.uploads_dir or env.get("UPLOAD_DIR") or str(ROOT / "uploads")
    udir = pathlib.Path(udir)

    try:
        refs = collect(conn)
    except (RuntimeError, OSError) as e:
        print(f"✗ 查库失败：{e}", file=sys.stderr)
        return 2

    local = {u: w for u, w in refs.items() if u.startswith(LOCAL_PREFIX)}
    remote = [u for u in refs if not u.startswith(LOCAL_PREFIX)]
    in_use = {u: [x for x in w if x] for u, w in local.items()}
    in_use = {u: w for u, w in in_use.items() if w}

    missing_in_use, missing_orphan, bad_url = [], [], []
    for u in sorted(local):
        rel = url_to_relpath(u)
        if rel is None:
            bad_url.append(u)
            continue
        if not (udir / rel).is_file():
            (missing_in_use if u in in_use else missing_orphan).append(u)

    # 盘上有什么（含 avatars/），用于报"孤儿文件"与迁移清点
    on_disk = set()
    if udir.is_dir():
        for p in udir.rglob("*"):
            if p.is_file():
                on_disk.add(str(p.relative_to(udir)))
    known = {url_to_relpath(u) for u in local}
    orphan_files = sorted(on_disk - {k for k in known if k})

    result = {
        "uploads_dir": str(udir),
        "db_local_urls": len(local),
        "db_remote_urls": len(remote),
        "in_use": len(in_use),
        "files_on_disk": len(on_disk),
        "missing_in_use": missing_in_use,
        "missing_orphan": missing_orphan,
        "unparsable_urls": bad_url,
        "files_not_in_db": orphan_files,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"上传件核对  UPLOAD_DIR={udir}")
        print(f"\n库里记着 {len(local) + len(remote)} 条图 URL："
              f"本地 {len(local)} / 远端(R2) {len(remote)}")
        print(f"  · 正文或封面正在用：{len(in_use)} 张")
        print(f"  · 只挂图库、没人用：{len(local) - len(in_use)} 张")
        print(f"盘上：{len(on_disk)} 个文件")

        if not udir.is_dir():
            print(f"\n❌ 目录不存在：{udir}")
            print("   （没配 UPLOAD_DIR 时默认是 <仓库>/uploads；生产应当是一条绝对路径）")
        elif missing_in_use:
            print(f"\n❌ 正在被引用、但盘上没有的图：{len(missing_in_use)} 张"
                  "（访客看到的就是破图）")
            for u in missing_in_use[:20]:
                print(f"   {u}\n     ← {in_use[u][0]}")
            if len(missing_in_use) > 20:
                print(f"   …另有 {len(missing_in_use) - 20} 张")
        else:
            print(f"\n✅ 正在被引用的本地图，盘上都有（{len(in_use)}/{len(in_use)}）")

        if missing_orphan:
            print(f"\n⚠️  只挂图库、盘上也没有的记录：{len(missing_orphan)} 条"
                  "（没有任何文章在用，不影响站点）")
            for u in missing_orphan[:10]:
                print(f"   {u}")
        if bad_url:
            print(f"\n⚠️  解析不出本地路径的 URL：{len(bad_url)} 条（前缀对但路径异常）")
            for u in bad_url[:10]:
                print(f"   {u}")
        if orphan_files:
            print(f"\nℹ️  盘上有、但库里没有任何记录的文件：{len(orphan_files)} 个（可清理）")
            for f in orphan_files[:10]:
                print(f"   {f}")
            if len(orphan_files) > 10:
                print(f"   …另有 {len(orphan_files) - 10} 个")

        print("\n提示：迁移/恢复之后跑一次，『正在被引用』那一节为零即说明这次搬家完整。")

    return 1 if missing_in_use else 0


if __name__ == "__main__":
    sys.exit(main())
