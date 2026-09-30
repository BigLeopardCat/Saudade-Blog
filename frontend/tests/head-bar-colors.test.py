#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""顶栏「原来的显示逻辑 + 白天换字色」的两态字色锁（20261001 六轮，用户第 6 条）。

  python3 tests/head-bar-colors.test.py

用户原话：「顶部栏依旧做回原来的显示逻辑，只不过字体颜色白天模式需要换色否则看不清。」

"原来的显示逻辑" = 默认整条**透明**，只有「悬停」与「页面已滚动」（`.is-stuck`）两态
才落 `rgba(0,0,0,0.66)` 深底（`d85311e` 之前的形态）。那两态是**两档主题共用一层黑**，
所以字必须跟着换浅；而透明态压的是页底 —— 白天是淡彩首屏（白字 ≈ 1.2:1，就是主人说的
"看不清"），夜里是深色页底（浅字才对）。

**为什么只能问浏览器**：这件事全是 CSS 层叠的结果，读代码看不出谁赢 ——
  · 字色是 `var(--washi-ink)` 走**令牌分档**（白天深墨紫 / 夜间浅色），令牌本身住
    `src/index.css`，浅色档在 `:root`、深色档在选择器列表里；
  · 深底态那条覆盖 `&:hover, &.is-stuck { .webTitle, .headBar li { color: … } }` 与
    `.headBar li:hover`（和纸 chip）是**同特异性 (0,3,1)**，靠源码顺序定胜负 ——
    谁在前谁在后，只有 computedStyle 说了算；
  · `.headContainer` 是 `z-index:-1`，没有外面那层 `position:sticky; z-index:999` 的
    `<header>` 它连 hover 都收不到（本脚本第一版就栽在这上，量出一片"悬停没生效"）。

取自真文件：`src/frontHome/Head/index.sass`（现编译）+ `src/index.css`（令牌）。
DOM 结构照抄 `Head/index.tsx:262` 那层 `<header>`。
"""
import functools
import http.server
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# ── 编译真 sass ──────────────────────────────────────────────────────────────
# CLI（node_modules/.bin/sass）在本机是坏的（chokidar 的 ERR_REQUIRE_ESM），
# 走 node API —— 与 sass-media-shadow.test.mjs 同一条通路。
COMPILE = """\
import * as sass from 'sass';
import fs from 'node:fs';
const src = process.argv[1], out = process.argv[2];
fs.writeFileSync(out, sass.compile(src, {logger: sass.Logger.silent}).css.toString());
"""
r = subprocess.run(["node", "--input-type=module", "-e", COMPILE,
                    str(FE / "src/frontHome/Head/index.sass"), "/tmp/_head_colors.css"],
                   cwd=str(FE), capture_output=True)
if r.returncode != 0:
    raise SystemExit("sass 编译失败：\n%s" % r.stderr.decode("utf-8", "replace"))

SB = pathlib.Path(tempfile.mkdtemp(prefix="head-colors-"))
(SB / "head.css").write_text(pathlib.Path("/tmp/_head_colors.css").read_text(encoding="utf-8"),
                             encoding="utf-8")
shutil.copyfile(FE / "src/index.css", SB / "index.css")

HTML = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="index.css">
<link rel="stylesheet" href="head.css">
<style>
 /* 结构照抄真页面（Head/index.tsx:262）：顶栏整条住在一条 `position:sticky;
    z-index:999` 的 <header> 里，`.frontDark` 挂在它身上。`.headContainer` 自己是
    `z-index:-1` + absolute —— 少了这层 header，它就被页底整个压住、连 hover 都收不到。 */
 html,body{margin:0}
 body{min-height:220px;background:#efe7f2}
 header{display:flex;position:sticky;top:0;width:100%;z-index:999}
 header.frontDark{background:#1b1626}
</style></head><body>
<header id="hdr">
  <div class="headContainer" id="hc">
    <div class="webTitle"><h2><span class="firstTitle">林陌青川</span>Blog</h2></div>
    <div class="headBar"><ul><li>首页</li></ul></div>
  </div>
</header>
<script>
 window.__dark = (on) => {
   document.getElementById('hdr').classList.toggle('frontDark', on);
   document.body.style.background = on ? '#1b1626' : '#efe7f2';
 };
</script></body></html>"""
(SB / "index.html").write_text(HTML, encoding="utf-8")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SB))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

READ = """() => {
    const g = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).color : null; };
    return { title: g('.webTitle'), li: g('.headBar li'), chip: g('.firstTitle'),
             bg: getComputedStyle(document.getElementById('hc')).backgroundColor };
}"""


def rgb(c):
    return tuple(float(x) for x in re.findall(r"[\d.]+", c)[:3])


def lum(c):
    """相对亮度（0..1）——只用来判"这字是深的还是浅的"。"""
    def f(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = rgb(c)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(fg, bg):
    a, b = lum(fg), lum(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


DAY_BG = "rgb(239, 231, 242)"    # #efe7f2 淡彩纸（透明态压的就是它）
NIGHT_BG = "rgb(27, 22, 38)"     # #1b1626
DARK_BAR = "rgb(0, 0, 0)"        # rgba(0,0,0,.66) 的等效观感（算对比度取极值）

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    br = p.chromium.launch()
    for dark in (False, True):
        tag = "夜间" if dark else "白天"
        page_bg = NIGHT_BG if dark else DAY_BG
        print(f"\n【{tag}】")
        pg = br.new_page(viewport={"width": 1280, "height": 300})
        pg.goto(URL)
        if dark:
            pg.evaluate("() => window.__dark(true)")
        pg.wait_for_timeout(200)

        # ── ① 未滚动 = 透明态（这就是"原来的显示逻辑"）────────────────────────
        v = pg.evaluate(READ)
        check("未滚动：整条是透明的（不是常驻纸底）",
              v["bg"] in ("rgba(0, 0, 0, 0)", "transparent"), v["bg"])
        if dark:
            check(f"未滚动：字是**浅色** —— 深色页底上要亮  {v['title']}",
                  lum(v["title"]) > 0.5, f"{ratio(v['title'], page_bg):.1f}:1")
        else:
            check(f"未滚动：字是**深色**（这正是主人要换的那一笔，原为白字）  {v['title']}",
                  lum(v["title"]) < 0.15, f"{ratio(v['title'], page_bg):.1f}:1")
        check(f"未滚动：对比度 ≥ 3:1（页底 {page_bg}）",
              ratio(v["title"], page_bg) >= 3.0, f"{ratio(v['title'], page_bg):.2f}:1")
        check("未滚动：导航项与站名同色", v["li"] == v["title"], f"{v['li']} / {v['title']}")

        # ── ② 悬停整条落深底 ───────────────────────────────────────────────────
        # 过渡 0.6s：读太早会量到中间帧（本脚本第一版就吃到过 rgba(0,0,0,0.19)）。
        pg.hover("#hc")
        pg.wait_for_timeout(800)
        vh = pg.evaluate(READ)
        check("悬停：整条落深底 rgba(0,0,0,0.66)",
              vh["bg"] == "rgba(0, 0, 0, 0.66)", vh["bg"])
        check(f"悬停：站名换成浅色  {vh['title']}", lum(vh["title"]) > 0.5,
              f"{ratio(vh['title'], DARK_BAR):.1f}:1")
        check("悬停：被指到的导航项吃和纸 chip（与站名**故意**不同色 —— "
              "`.headBar li:hover` 与深底那条同特异性 (0,3,1)，靠源码顺序让 chip 赢）",
              vh["li"] == vh["chip"], f"{vh['li']} / chip {vh['chip']}")
        chip_rgb = rgb(vh["chip"])
        check("悬停：站名那颗 chip 仍吃玫红（没被深底那组一起染白）",
              chip_rgb[0] > chip_rgb[1] and chip_rgb[0] > chip_rgb[2], vh["chip"])
        pg.mouse.move(0, 0)
        pg.wait_for_timeout(800)

        # ── ③ 已滚动 = .is-stuck（贴满整幅、去圆角、深底）───────────────────────
        pg.evaluate("() => document.getElementById('hc').classList.add('is-stuck')")
        pg.wait_for_timeout(800)
        vs = pg.evaluate(READ)
        check("滚动态：整条落深底", vs["bg"] == "rgba(0, 0, 0, 0.66)", vs["bg"])
        check(f"滚动态：站名是浅色  {vs['title']}", lum(vs["title"]) > 0.5,
              f"{ratio(vs['title'], DARK_BAR):.1f}:1")
        check("滚动态：导航项同色（这时没有 chip 覆盖）", vs["li"] == vs["title"],
              f"{vs['li']} / {vs['title']}")
        geo = pg.evaluate("""() => {
            const b = document.getElementById('hc').getBoundingClientRect();
            const s = getComputedStyle(document.getElementById('hc'));
            return { w: Math.round(b.width), left: Math.round(b.left),
                     radius: s.borderTopLeftRadius, vw: window.innerWidth };
        }""")
        check("滚动态：贴满整幅、去圆角（原内联 background/width/margin 的活）",
              geo["w"] == geo["vw"] and geo["left"] == 0 and geo["radius"] == "0px", str(geo))
        pg.close()
    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 顶栏两态字色：全部通过")
