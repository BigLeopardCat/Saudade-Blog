#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""z-index 阶梯：两份值逐值相等 + 四层真实堆叠次序。"""
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


# ① 两份值逐值相等（纯文本，不需要浏览器）
LADDER_RE = re.compile(r"^\s*--z-([a-z-]+):\s*(\d+);", re.M)
TS_RE = re.compile(r"^\s*([a-z-]+):\s*(\d+),", re.M)

css_text = (FE / "src/index.css").read_text(encoding="utf-8")
ts_text = (FE / "src/zIndex.ts").read_text(encoding="utf-8")
# 只取那一张阶梯：`:root` 里还有一堆 `--washi-*`（不是数字，正则本来也捞不到），
# 但 TS 那边得先把 `export const Z = { … } as const;` 那段切出来，否则会把注释里的
# "1000" 之类也当成一项。
LADDER = {k: int(v) for k, v in LADDER_RE.findall(css_text)}
_z_block = re.search(r"export const Z = \{(.*?)\n\} as const;", ts_text, re.S)
TS_VALS = {k: int(v) for k, v in TS_RE.findall(_z_block.group(1))} if _z_block else {}

print("== ① 阶梯两份值逐值相等（index.css 的 :root vs zIndex.ts 的 Z）==")
check("两份都解析出来了、键集合相同",
      LADDER and LADDER == TS_VALS, f"css={LADDER} / ts={TS_VALS}")
# 逐键报出差异：整块比对只说"不相等"，改的人还得自己二分
for k in sorted(set(LADDER) | set(TS_VALS)):
    if k in LADDER and k in TS_VALS:
        check(f"  · --z-{k} 两边都是 {LADDER[k]}", LADDER[k] == TS_VALS[k],
              f"css {LADDER[k]} / ts {TS_VALS[k]}")
check("跨层的三档次序正确（effect < agent < exhibit < lightbox < panel < modal < toast）",
      (LADDER.get("effect", 0) < LADDER.get("agent", 0) < LADDER.get("exhibit", 0)
       < LADDER.get("lightbox", 0)
       < LADDER.get("panel", 0) < LADDER.get("modal", 0) < LADDER.get("toast", 1 << 30)),
      f'{LADDER.get("effect")} / {LADDER.get("agent")} / {LADDER.get("exhibit")} / '
      f'{LADDER.get("lightbox")} / '
      f'{LADDER.get("panel")} / {LADDER.get("modal")} / {LADDER.get("toast")}')
# 特效那一档还有个**消费面**：effects.js 里三个容器写的是 `var(--z-effect, 950)`，
# 兜底值必须与阶梯同值，否则脱离本站加载时是另一个数（"文档里 950、代码里是别的"）。
_eff = (FE / "public/effects.js").read_text(encoding="utf-8")
_eff_fb = re.findall(r"var\(--z-effect,\s*(\d+)\)", _eff)
check("effects.js 读 --z-effect 且兜底值与阶梯同值",
      _eff_fb and all(int(v) == LADDER.get("effect") for v in _eff_fb),
      f'effects.js {sorted(set(_eff_fb))} / 阶梯 {LADDER.get("effect")}')
check("effects.js 三个特效容器都不再写死 99999",
      _eff.count("z-index:99999") == 0 and _eff.count("${EFFECT_Z}") == 3,
      f'99999×{_eff.count("z-index:99999")} / EFFECT_Z×{_eff.count("${EFFECT_Z}")}')

# ②③ 真实堆叠（无头 Chrome）
# Compile the real application and shared image-viewer styles.
SB = pathlib.Path(tempfile.mkdtemp(prefix="z-index-"))
out_css = SB / "app.css"
r = subprocess.run(
    ["node", "-e",
     "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});r.css += s.compile(process.argv[3]).css;"
     "require('fs').writeFileSync(process.argv[2],r.css);",
     str(FE / "src/App.sass"), str(out_css),
     str(FE / "src/frontHome/Content/ReadArticle/zoomOverlay.sass")],
    cwd=str(FE), capture_output=True)
if r.returncode != 0:
    raise SystemExit("sass 编译失败：\n%s" % r.stderr.decode("utf-8", "replace"))
shutil.copyfile(FE / "src/index.css", SB / "index.css")
# 看板娘那份是**pin 取回来的真文件**（`npm run fetch:widget` 落位）。少了它这个套件
# 应该直接报错而不是静默降级 —— 它记的是跨仓契约，缺了就等于没验。
WIDGET_CSS = FE / "public/live2d-widgets/widget.css"
if not WIDGET_CSS.exists():
    raise SystemExit(f"缺 {WIDGET_CSS}：先跑 `npm run fetch:widget`（它不在 git 里）")
shutil.copyfile(WIDGET_CSS, SB / "widget.css")

HTML = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="index.css">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="widget.css">
<style>
 html,body{margin:0;height:100%}
 .frontRoot{min-height:100%}          /* 真规则只给背景，高度由内容撑 */
 #page{height:400px;background:#cfe8ff}
 #waifu{bottom:0 !important}          /* 夹具覆盖：见上面注释，只改位置不改层级 */
 .layer{position:fixed;inset:0;display:none}
 .layer[data-on="1"]{display:block}
</style></head><body>
<div class="frontRoot" data-layer="front"><div id="page" data-layer="page"></div></div>
<div id="waifu" data-layer="waifu"><div style="width:60px;height:47px;background:#333"></div></div>
<div class="md-zoom-overlay" data-layer="lightbox" style="display:none"></div>
<div class="layer" data-layer="panel" style="z-index:var(--z-panel)"></div>
<div class="layer" data-layer="modal" style="z-index:var(--z-modal)"></div>
<script>
 window.__set = (spec) => {
   // spec: { zoomed:bool, page:bool, waifu:bool, lightbox:bool, panel:bool, modal:bool }
   document.body.classList.toggle('exhibit-zoomed', !!spec.zoomed);
   document.getElementById('page').style.display = spec.page === false ? 'none' : '';
   document.getElementById('waifu').style.display = spec.waifu === false ? 'none' : '';
   document.querySelector('[data-layer=lightbox]').style.display = spec.lightbox ? 'block' : 'none';
   for (const k of ['panel', 'modal'])
     document.querySelector('[data-layer=' + k + ']').dataset.on = spec[k] ? '1' : '0';
 };
 window.__top = (x, y) => {
   const el = document.elementFromPoint(x, y);
   const hit = el && el.closest('[data-layer]');
   return hit ? hit.dataset.layer : (el ? el.tagName : null);
 };
 window.__root = () => {
   const cs = getComputedStyle(document.querySelector('.frontRoot'));
   return { z: cs.zIndex, pos: cs.position };
 };
</script></body></html>"""
(SB / "index.html").write_text(HTML, encoding="utf-8")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SB))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 900, "height": 400})
    pg.goto(URL)
    pg.wait_for_timeout(200)

    PX, PY = pg.evaluate("""() => {
        const r = document.getElementById('waifu').getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height - 25];
    }""")
    # 红基线：这个点必须真在 `#waifu` 盒内。少了它，"看板娘压得住页面"在探针点
    # 根本没碰到看板娘时也是绿的（本次改动就是这么把它弄红的）。
    inside = pg.evaluate("""([x, y]) => {
        const r = document.getElementById('waifu').getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }""", [PX, PY])
    check("★ 探针点落在 #waifu 盒内（否则下面那组量的是别的东西）",
          inside, f"({PX:.0f}, {PY:.0f})")

    def top(spec):
        pg.evaluate("(s) => window.__set(s)", spec)
        return pg.evaluate("([x, y]) => window.__top(x, y)", [PX, PY])

    print("\n== ② 四层堆叠：同一个点上谁在最上面（elementFromPoint 实测）==")
    base = {"page": True, "waifu": True}
    t = top(base)
    check("★ 看板娘压得住前台页面（#waifu 的 var(--z-agent,1000) 生效 —— "
          "兜底值取不到就说明这份 widget.css 的 var() 没解析出来）", t == "waifu", t)

    t = top({**base, "lightbox": True})
    check("  图片查看器（1150）压得住页面与看板娘", t == "lightbox", t)

    t = top({**base, "lightbox": True, "panel": True})
    check("★ 个人中心（1200）压得住看板娘 —— 用户原话「个人中心打开时也是在最顶层"
          "不要被 agent 对话框遮挡」", t == "panel", t)
    check("  个人中心也压得住图片查看器（1150 < 1200）", t == "panel", t)

    t = top({**base, "panel": True, "modal": True})
    check("★ 公告（1300）压得住个人中心 —— 用户原话「他们都在公告的层级下，"
          "不能遮挡公告弹窗」", t == "modal", t)

    t = top({**base, "lightbox": True, "panel": True, "modal": True})
    check("  四层同开时仍是公告在最上（不是「谁的 portal 后插入谁赢」）", t == "modal", t)

    print("\n== ③ 抬升是开关式的：类一摘就回到 static/auto ==")
    top({"page": True, "waifu": True})
    r0 = pg.evaluate("() => window.__root()")
    check("  不放大时 `.frontRoot` 仍是 static/auto（平时不给 absolute 后代换包含块）",
          r0["pos"] == "static" and r0["z"] == "auto", f'{r0["pos"]} / {r0["z"]}')

    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.wait_for_timeout(100)
    check("  全程无 pageerror", not errs, str(errs[:2]))

    browser.close()


print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：")
    for f in FAILS:
        print("  · " + f)
    sys.exit(1)
print("全部通过")
