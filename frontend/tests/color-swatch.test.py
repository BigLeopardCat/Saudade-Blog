#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对话框色块装饰器 `decorateColorSwatches` 回归（真 DOM 跑，20260921）。

  python3 tests/color-swatch.test.py

为什么用无头浏览器而不是 node 桩：这个装饰器**整个逻辑都在 DOM 上**
（TreeWalker 遍历文本节点、`closest('pre, code, a, …')` 判父级、把文本节点换成
`<span>` 片段）。手搓 DOM 桩只会测到桩本身，测不出 `closest` 匹配与树遍历的真实行为
（无头验证法的既有坑之一，见 docs）。esbuild 把 `src/utils/chatMarkdown.ts` 真源码
打成一个 IIFE bundle，页面里直接调，无桩。

锁两件事：
  ① **放宽后的口径**（20260921 用户拍板）：任意 6 位色值都画色块——此前只认站内 8 色板，
     结果是 agent 答"配色建议"这类站外色值时一个色块都不渲染（用户实测反馈）；
  ② **不许越界**：`pre`/`code`/`a` 内部不画、8 位色值（带 alpha）不许被截半画、
     5 位/3 位非完整 6 位色值不画、重复调用不许叠加（幂等）。
"""
import pathlib
import shutil
import subprocess
import tempfile

FE = pathlib.Path(__file__).resolve().parent.parent

PASS, FAIL = 0, 0


def check(desc: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {desc}")
    else:
        FAIL += 1
        print(f"  ✗ {desc}" + (f"  → {detail}" if detail else ""))


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="swatch-verify-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    (sb / "entry.ts").write_text('''\
import { decorateColorSwatches, renderBlogMarkdown, chatColorPalette } from './src/utils/chatMarkdown';
(window as any).__decorate = decorateColorSwatches;
(window as any).__render = renderBlogMarkdown;
(window as any).__palette = chatColorPalette;
''', encoding="utf-8")
    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.ts",
                    "--bundle", "--format=iife", "--outfile=bundle.js"],
                   cwd=str(sb), check=True, capture_output=True)
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>'
        '<body><div id="root"></div><script src="bundle.js"></script></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

# 页面里造一坨 DOM 再调装饰器，读回"哪些色值画了色块"
PROBE = """(html) => {
  const root = document.getElementById('root');
  root.innerHTML = html;
  window.__decorate(root);
  window.__decorate(root);          // 第二次：幂等性一起验
  return {
    chips: Array.from(root.querySelectorAll('.chat-swatch'))
                .map((c) => (c.getAttribute('aria-label') || '') + '|' + c.style.background),
    text: root.textContent,
  };
}"""

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page()
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(200)

    print("① 站外色值也画（放宽口径）")
    r = pg.evaluate(PROBE, "<p>推荐 #f5e6d3 打底，配 #2b2b2b 的字</p>")
    check("自造 hex 也有色块", len(r["chips"]) == 2, str(r["chips"]))
    check("色块底色 = 正文里的色值",
          all(c.split("|")[1] in ("rgb(245, 230, 211)", "rgb(43, 43, 43)") for c in r["chips"]),
          str(r["chips"]))
    check("编码文本原样保留（色块 + 编码并列）",
          "#f5e6d3" in r["text"] and "#2b2b2b" in r["text"], r["text"])

    print("② 站内 8 色板仍全认")
    pal = pg.evaluate("() => window.__palette")
    check("色板 8 色", len(pal) == 8, str(pal))
    r = pg.evaluate(PROBE, "<p>" + " ".join(pal) + "</p>")
    check("8 色全部画出（大小写不敏感）", len(r["chips"]) == 8, str(r["chips"]))
    r = pg.evaluate(PROBE, "<p>" + " ".join(c.upper() for c in pal) + "</p>")
    check("大写写法同样画出", len(r["chips"]) == 8, str(r["chips"]))

    print("③ 不许越界")
    r = pg.evaluate(PROBE, "<pre><code>#1677ff</code></pre><p>#52c41a</p>")
    check("代码块内不画（代码块外的照画）",
          len(r["chips"]) == 1 and r["chips"][0].startswith("#52c41a"), str(r["chips"]))
    r = pg.evaluate(PROBE, '<p><a href="#">#eb2f96</a></p>')
    check("链接文本里不画", len(r["chips"]) == 0, str(r["chips"]))
    r = pg.evaluate(PROBE, "<p>#1677ff00</p>")
    check("8 位色值（带 alpha）不截半画", len(r["chips"]) == 0, str(r["chips"]))
    r = pg.evaluate(PROBE, "<p>#abc #12345 #xyzxyz</p>")
    check("3 位 / 5 位 / 非十六进制都不画", len(r["chips"]) == 0, str(r["chips"]))
    r = pg.evaluate(PROBE, "<p>#1234567890</p>")
    check("超长数字串不画（词边界挡住）", len(r["chips"]) == 0, str(r["chips"]))

    print("④ 幂等与真实渲染路径")
    r = pg.evaluate(PROBE, "<p>#eb2f96</p>")
    check("连调两次不叠色块", len(r["chips"]) == 1, str(r["chips"]))
    r = pg.evaluate("""(md) => {
      const root = document.getElementById('root');
      root.innerHTML = window.__render(md);
      if (window.__chatDecorateColors) window.__chatDecorateColors(root);
      return Array.from(root.querySelectorAll('.chat-swatch')).length;
    }""", "试试 #eb2f96 和 #f5e6d3")
    check("走真 markdown 渲染的是网页里那个全局（__chatDecorateColors）", r == 2, str(r))
    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} color-swatch：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
