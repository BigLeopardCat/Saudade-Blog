#!/usr/bin/env python3
"""列出或清理过期的前端测试临时目录，默认只列清单。

允许前缀由测试源码动态提取；仅处理达到年龄阈值的已知目录。
不处理未知前缀、非目录或仍在运行中的测试。使用 --apply 才执行清理。
"""
import argparse
import os
import pathlib
import re
import shutil
import sys
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
TESTS = REPO / "frontend" / "tests"
DEFAULT_ROOT = "/tmp"
DEFAULT_SANDBOX_TMP = "/tmp/saudade-sandboxes"
# 轮次目录的年龄闸：隔离之后一轮跑完（或被杀）留下的整格。给它一天，别跟夜跑撞车。
RUN_DIR_MAX_AGE_H = 24.0
# 前缀太短就没有分辨力（`a-` 会命中半个 /tmp），短于此的一律不采信。
MIN_PREFIX_LEN = 3

# 套件里那两种写法的**静态头**：
#   .py  : tempfile.mkdtemp(prefix="album-views-")  /  prefix=f"mmzoom-{name}-"
#   .mjs : mkdtempSync(path.join(tmpdir(), 'cmt-'))  （os.tmpdir() 也认）
# 多行调用、任意空白都容忍（套件里两种都有）。
_PY_PREFIX_RE = re.compile(r"""mkdtemp\(\s*prefix\s*=\s*f?["']([^"']*)["']""", re.S)
_MJS_PREFIX_RE = re.compile(
    r"""mkdtempSync\(\s*path\.join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*["']([^"']*)["']""", re.S)


def derive_prefixes(tests_dir: pathlib.Path) -> "list[str]":
    """从套件源码里推出所有临时目录前缀（f-string 取 `{` 之前的静态头）。"""
    heads = set()
    if not tests_dir.is_dir():
        return []
    for f in sorted(tests_dir.glob("*.py")) + sorted(tests_dir.glob("*.mjs")):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for rx in (_PY_PREFIX_RE, _MJS_PREFIX_RE):
            for m in rx.finditer(text):
                head = m.group(1).split("{")[0]        # f"mmzoom-{name}-" → "mmzoom-"
                if len(head) >= MIN_PREFIX_LEN:
                    heads.add(head)
    return sorted(heads)


def _mtime(p: pathlib.Path) -> float:
    try:
        return p.lstat().st_mtime          # lstat：符号链接不跟随（本就不收，这里只为不炸）
    except OSError:
        return time.time()                 # 读不到就当作"刚建的"，即不删


def _size(p: pathlib.Path) -> int:
    """普通文件取 st_size，目录递归求和。读不到的条目按 0 计（只影响打印的分量）。"""
    try:
        st = p.lstat()
    except OSError:
        return 0
    if not os.path.isdir(p) or os.path.islink(p):
        return st.st_size
    total = 0
    for dirpath, _dirs, filenames in os.walk(p, onerror=lambda e: None):
        for n in filenames:
            try:
                total += os.lstat(os.path.join(dirpath, n)).st_size
            except OSError:
                pass
    return total


def _children(root: pathlib.Path) -> "list[pathlib.Path]":
    """root 的**直接子项**（不是递归）。读不到就返回空表——绝不让一次权限错误升级成异常。"""
    try:
        return sorted(root.iterdir())
    except OSError:
        return []


def plan(root: pathlib.Path, sandbox_tmp: pathlib.Path, min_age_h: float) -> "list[tuple]":
    """算出要删的项。**判据只有这一处**：只列与 --apply 共用它，不会各算各的。"""
    now = time.time()
    prefixes = derive_prefixes(TESTS)
    drop = []

    # ── 规则 1：root 直接子项，名字以派生前缀开头，且够老 ────────────────────────
    sandbox_tmp_res = _resolved(sandbox_tmp)
    for p in _children(root):
        if p.is_symlink():
            continue                        # 不跟随：根下一条指向别处的链接不该被它删掉
        if _resolved(p) == sandbox_tmp_res:
            continue                        # 那是规则 2 的地盘，别在规则 1 里重复计数
        hit = next((h for h in prefixes if p.name.startswith(h)), None)
        if hit is None:
            continue                        # 未知一律不删（health_state / claude-1000 / …）
        if now - _mtime(p) < min_age_h * 3600:
            continue                        # 年龄闸：可能是正在跑的套件
        drop.append((p, _size(p), f"套件残留（前缀 {hit}）"))

    # ── 规则 2：sandbox_tmp 下够老的轮次目录（被 kill 的那一轮留下的整格）──────
    for p in _children(sandbox_tmp):
        if p.is_symlink() or not p.is_dir():
            continue
        if now - _mtime(p) < RUN_DIR_MAX_AGE_H * 3600:
            continue
        drop.append((p, _size(p), "陈旧轮次目录"))
    return drop


def _resolved(p: pathlib.Path):
    try:
        return p.resolve()
    except OSError:
        return None


def _mb(n: int) -> str:
    return f"{n / 1024 / 1024:.1f}MB"


def _gb(n: int) -> str:
    return f"{n / 1024 / 1024 / 1024:.2f}GB"


def _stamp(p: pathlib.Path) -> str:
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(_mtime(p)))
    except (OSError, ValueError):
        return "?" * 16


def main() -> int:
    ap = argparse.ArgumentParser(description="沙箱临时目录清扫（默认只列不删）")
    ap.add_argument("--root", default=DEFAULT_ROOT,
                    help=f"沙箱残留所在的根（默认 {DEFAULT_ROOT}）；测试可指向夹具目录")
    ap.add_argument("--sandbox-tmp", default=os.environ.get("SANDBOX_TMP") or DEFAULT_SANDBOX_TMP,
                    help="运行器建的轮次目录所在（默认 $SANDBOX_TMP 或 " + DEFAULT_SANDBOX_TMP + "）")
    ap.add_argument("--min-age-hours", type=float, default=6.0,
                    help="只清 mtime 早于这么多小时的项（默认 6；单套件超时上限是 480s）")
    ap.add_argument("--list-prefixes", action="store_true",
                    help="只打印从套件源码推出的前缀，什么都不删")
    ap.add_argument("--apply", action="store_true", help="真删；不加则只打印将要删的内容")
    args = ap.parse_args()

    prefixes = derive_prefixes(TESTS)
    if args.list_prefixes:
        print(f"从 {TESTS} 推出 {len(prefixes)} 个前缀：")
        for h in prefixes:
            print(f"    {h}")
        return 0

    root = pathlib.Path(args.root)
    if not root.is_dir():
        print(f"❌ 根目录不存在或不是一个目录：{root}")
        return 1

    if not prefixes:
        print(f"⚠️ 从 {TESTS} 一个前缀都没推出来（套件目录不在？）"
              f"——按「未知一律不删」处理，什么都不动")

    drop = plan(root, pathlib.Path(args.sandbox_tmp), args.min_age_hours)

    print(f"清扫根 {root}（年龄闸 {args.min_age_hours}h）；轮次目录 "
          f"{args.sandbox_tmp}（年龄闸 {RUN_DIR_MAX_AGE_H:.0f}h）")
    print(f"从套件源码推出 {len(prefixes)} 个前缀（不是手写名单）")
    total = sum(s for _, s, _ in drop)
    print(f"要删 {len(drop)} 项 / {_gb(total)}：")
    for p, s, why in drop[:20]:
        print(f"    del  {_stamp(p)}  {p}  {_mb(s)}  （{why}）")
    if len(drop) > 20:
        print(f"    …其余 {len(drop) - 20} 项（同一族）")
    if not args.apply:
        print("（只列不删；要真删加 --apply）")
        return 0

    gone = 0
    freed = 0
    errs = 0
    for p, s, _ in drop:
        try:
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink()
            gone += 1
            freed += s
        except OSError as e:
            errs += 1
            print(f"⚠️ 删不掉 {p}：{e}")
    print(f"✅ 已删 {gone} 项 / {_gb(freed)}" + (f"；{errs} 项失败" if errs else ""))
    return 0                                # 有单项失败也返回 0：清理不该把调用方标红


if __name__ == "__main__":
    raise SystemExit(main())
