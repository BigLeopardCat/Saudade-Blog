#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""沙箱临时目录清扫脚本 `scripts/prune_sandbox_tmp.py` 的行为回归（20261006）。

  python3 tests/sandbox-tmp-prune.test.py

为什么要有它：清扫脚本的判据是"**删东西**"，而它最重要的性质是"**未知一律不删**"——
这类性质**只能靠真跑 + 诱饵**验证：盯着代码看永远说不出"`health_state` 会不会被它顺手收走"。
所以这里在**夹具目录**上跑真脚本（`tempfile.mkdtemp` 建的，**绝不指向真 /tmp**），
诱饵按真 /tmp 上实际住着的东西摆。

锁四件事：
  ① **前缀是从套件源码推出来的**（`--list-prefixes` 里必须同时出现 .py 侧与 .mjs 侧各一族）
     ——手写名单漏一族就等于那一族再也不会被扫，而**没有任何东西会变红**；
  ② 命中前缀 + 够老 ⇒ 删；命中前缀 + **太新** ⇒ 活（年龄闸，防误伤正在跑的套件）；
  ③ **诱饵全活**：`health_state` / `claude-1000` / `systemd-private-*` /
     `verify-clone-*.git` / `bundle5`，以及"名字**中间**含前缀"的（前缀必须在开头）、
     以及一条指向根外的符号链接（不跟随）；
  ④ 默认**只列不删**（不加 `--apply` 时磁盘上一个都不能少），三种跑法退出码恒 0
     （清扫失败对调用方必须非致命，否则会把一次真实的套件失败搅浑）。
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

FE = pathlib.Path(__file__).resolve().parent.parent
REPO = FE.parent
SCRIPT = REPO / "scripts" / "prune_sandbox_tmp.py"

PASS, FAIL = 0, 0


def check(desc: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {desc}")
    else:
        FAIL += 1
        print(f"  ✗ {desc}" + (f"  → {detail}" if detail else ""))


def run(*extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *extra],
        capture_output=True, text=True, timeout=120,
    )


def age(p: pathlib.Path, hours: float) -> None:
    """把 mtime 拨回 hours 小时之前（夹具里造出"够老"的项）。"""
    t = time.time() - hours * 3600
    os.utime(p, (t, t))


FIXTURE = pathlib.Path(tempfile.mkdtemp(prefix="prune-fix-"))
ROOT = FIXTURE / "root"          # 假装是 /tmp：只扫它的**直接子项**
SB = FIXTURE / "sb"              # 假装是 $SANDBOX_TMP：轮次目录住这儿

# ── 夹具：命名刻意用**真前缀**（从套件源码里推出来的那批）────────────────────────
OLD_PY = "comment-layout-v1-old"     # .py 侧前缀 comment-layout-
OLD_MJS = "cmt-oldone"               # .mjs 侧前缀 cmt-
FRESH = "comment-layout-v1-fresh"    # 命中前缀但刚建（年龄闸必须挡住）
MID = "x-album-views-decoy"          # 前缀在**中间**：不算命中
DECOYS = ["health_state", "claude-1000", "systemd-private-abc-chrony.service-XyZ",
          "verify-clone-20261001.git", "bundle5", "not-a-sandbox-at-all"]
OLD_RUN = "20200101T000000"          # 24h 以上的轮次目录
FRESH_RUN = "99990101T000000"        # 刚建的轮次目录（必须活）

ROOT.mkdir()
SB.mkdir()
for name, hours in ((OLD_PY, 18), (OLD_MJS, 18), (FRESH, 0), (MID, 18)):
    (ROOT / name).mkdir()
    (ROOT / name / "payload.bin").write_bytes(b"x" * 1024)   # 非空：删得掉才算真删
    age(ROOT / name, hours)     # ⚠️ 必须**最后**拨 mtime：往目录里写文件会把目录的 mtime 顶成现在
for name in DECOYS:
    p = ROOT / name
    if name == "health_state":
        p.write_bytes(b"1234567890")     # 它是个**文件**不是目录（真 /tmp 上就是）
    else:
        p.mkdir()
    # 诱饵一律**拨老**：否则"新 mtime"会替它挡枪，就验不出"是前缀判据放过了它"
    age(p, 18)
os.symlink("/etc", ROOT / "album-views-link")                # 前缀命中，但它指向根外
for name, hours in ((OLD_RUN, 48), (FRESH_RUN, 0)):
    (SB / name).mkdir()
    (SB / name / "leftover").write_bytes(b"y")
    age(SB / name, hours)

try:
    print("① 前缀必须是从套件源码里推出来的（.py 侧 + .mjs 侧各一族）")
    r = run("--list-prefixes")
    check("--list-prefixes 退出码 0", r.returncode == 0, r.stderr.strip()[:200])
    listed = r.stdout
    check("推得出 .py 侧的前缀（comment-layout-）", "comment-layout-" in listed, listed[:200])
    check("推得出 .mjs 侧的前缀（cmt-）", "cmt-" in listed, listed[:200])
    check("前缀条数不止三五个（真在逐个扫源文件）", len(listed.strip().splitlines()) > 20,
          str(len(listed.strip().splitlines())))
    check("★ 负空间：它不是手写名单——把某条前缀改成只有源码里才有的样子也会跟着变",
          "album-views-" in listed and "mmzoom-" in listed, listed[:200])

    print("② 默认只列不删：磁盘上一个都不能少")
    r = run("--root", str(ROOT), "--sandbox-tmp", str(SB))
    check("干跑退出码 0", r.returncode == 0, r.stderr.strip()[:200])
    check("干跑列出了够老的那两项", OLD_PY in r.stdout and OLD_MJS in r.stdout, r.stdout[:300])
    check("干跑明说「只列不删」", "--apply" in r.stdout, r.stdout[-200:])
    check("★ 干跑之后磁盘上什么都没少", (ROOT / OLD_PY).is_dir() and (ROOT / OLD_MJS).is_dir())
    check("干跑之后轮次目录也在", (SB / OLD_RUN).is_dir())

    print("③ --apply：命中且够老的删，其余全活")
    r = run("--root", str(ROOT), "--sandbox-tmp", str(SB), "--apply")
    check("--apply 退出码 0", r.returncode == 0, r.stderr.strip()[:200])
    check(".py 侧前缀命中 ⇒ 真删了", not (ROOT / OLD_PY).exists())
    check(".mjs 侧前缀命中 ⇒ 真删了", not (ROOT / OLD_MJS).exists())
    check("★ 年龄闸：太新的命中项**活着**（不误伤正在跑的套件）", (ROOT / FRESH).is_dir())
    check("★ 前缀在中间的不算命中", (ROOT / MID).is_dir())
    for name in DECOYS:
        p = ROOT / name
        alive = p.exists()
        check(f"★ 诱饵活着：{name}", alive)
    check("★ 符号链接不跟随（指向 /etc 的那条原样留着）",
          (ROOT / "album-views-link").is_symlink())
    check("★ 旧轮次目录被收掉（被 kill 那一轮的整格）", not (SB / OLD_RUN).exists())
    check("★ 新轮次目录活着", (SB / FRESH_RUN).is_dir())

    print("④ 年龄闸确实是刚才保住它的东西 + 非致命契约")
    r = run("--root", str(ROOT), "--sandbox-tmp", str(SB), "--min-age-hours", "0")
    check("★ 把年龄闸放到 0，刚才被闸住的那项就出现在清单里了", FRESH in r.stdout,
          r.stdout[:300])
    r = run("--root", str(ROOT), "--sandbox-tmp", str(SB), "--apply")
    check("清单已清空之后再跑：退出码 0 且明说要删 0 项",
          r.returncode == 0 and "要删 0 项" in r.stdout,
          f"rc={r.returncode} {r.stdout[:200]}")
    r = run("--root", str(FIXTURE / "nope"), "--apply")
    check("根目录不存在 ⇒ 退出码 1 且说人话", r.returncode == 1 and "❌" in r.stdout,
          f"rc={r.returncode} {r.stdout[:120]}")
finally:
    shutil.rmtree(FIXTURE, ignore_errors=True)

print(f"\n{'✗' if FAIL else '✓'} sandbox-tmp-prune：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
