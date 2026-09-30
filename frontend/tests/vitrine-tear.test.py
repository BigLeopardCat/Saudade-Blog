# -*- coding: utf-8 -*-
"""首页展示柜「撕纸翻页」的无头验收（20261001 七轮，用户第 2 条）：真组件 + 真指针 + 真帧。

为什么必须另起一个脚本（`home-hero.test.py` 第 ⑥b 组已经锁了形状）：
  · 那一组量的是**静置的几何与源码**——折角多大、缺口几个顶点、谁 portal 到 body。
    它答不了"拖一下会怎样"：`--k` 是不是跟手、松手弹不弹得回来、
    "拖一点再撒手"到底算不算扯断、掉下去的那张纸有没有在**加速**、掉完有没有被销毁、
    掉落期间**文档高度涨没涨**。
  · 这几条全是**时序 + 事件**的真问题，只有真的按下、真的移动、真的等帧才看得见。
    其中"拖一点再撒手会不会照样扯断"是本套件第一版就抓到的一个真 bug：
    指针起落落在同一个按钮上，浏览器**一律补发 click**（不管中间拖了多远），
    而 `onCornerClick` 就是"点一下 = 扯一下"的入口 ⇒ 弹回那条路根本走不到。

沿用 announcement-popup-mount.test.py 那套既定手段（本机不能 vite build，见 CLAUDE.md §2）：
esbuild 把**真组件**打成一个 bundle，只桩 `exhibits.ts`（真那份是 `lazy(...)` 拉整个图谱，
与本套件无关且会把 bundle 撑大）。

用法：python3 frontend/tests/vitrine-tear.test.py
依赖：frontend/node_modules（esbuild/react/react-dom）、playwright(python)。
"""
import functools
import http.server
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
VIT_SASS = FE / "src/frontHome/Content/ContentHome/Vitrine/index.sass"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# 展品桩：形状与真那份一致（key/title/hint/badge/Component），组件换成一个死字符串。
# ⚠️ 只留一件，与生产一致 —— `EXHIBITS.slice(1)` 那沓垫纸因此是 0 层，正是线上形态。
STUB_EXHIBITS = """\
import * as React from 'react';
export const EXHIBITS = [{
  key: 'stub',
  title: '桩展品',
  hint: '桩',
  badge: async () => '2026年10月01日 UTC+8 00:00:00',
  // ⚠️ 这个桩文件的扩展名是 `.ts`（与真身同名），写不了 JSX —— 用 createElement。
  Component: () => React.createElement('span', { className: 'stub-exhibit' }, '桩'),
}];
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Vitrine from './src/frontHome/Content/ContentHome/Vitrine/index.tsx';
const root = createRoot(document.getElementById('root')!);
(window as any).__mount = () => root.render(<Vitrine />);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="vitrine-tear-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    (sb / "src/frontHome/Content/ContentHome/Vitrine/exhibits.ts").write_text(
        STUB_EXHIBITS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    out_css = sb / "vitrine.css"
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(VIT_SASS), str(out_css)],
                   cwd=str(FE), check=True)

    # 舞台：`#root` 给宽度（`.vitrine` 是 `width: 100%`），body 撑到 2400px 高 ——
    # 有滚动条才谈得上"掉落期间文档高度涨没涨"（第 ⑦ 条）。
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body{margin:0}body{min-height:2400px;background:#f4f0ff}'
        '#root{width:900px;margin:0 auto;padding-top:60px}'
        '.stub-exhibit{color:#fff}</style>'
        f'<style>{out_css.read_text(encoding="utf-8")}</style></head>'
        '<body><div id="root"></div><script src="bundle.js"></script>'
        '<script>window.__mount();</script></body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

# 折角当前值的来源有两处：`--k`（`.vitrine` 上的自定义属性，拖拽时是它被改写）与
# `.vit-ear` 算出来的 `transform`（静止档是 matrix(0.2, …)）。两个都读 ——
# 只读一个的话"变量没传到那片纸上"这类断链会被漏掉。
STATE = """() => {
  const vit = document.getElementById('vit') || document.querySelector('.vitrine');
  const ear = document.querySelector('.vit-ear');
  const corner = document.querySelector('.vit-corner');
  const cover = document.querySelector('.vit-cover');
  const panel = document.querySelector('.vit-panel');
  const fall = document.querySelector('body > .vit-fall');
  const cs = (el, sel) => el ? getComputedStyle(el) : null;
  const b = corner ? corner.getBoundingClientRect() : null;
  return {
    k: getComputedStyle(vit).getPropertyValue('--k').trim(),
    earTf: ear ? getComputedStyle(ear).transform : null,
    cornerCenter: b ? { x: b.left + b.width / 2, y: b.bottom - b.height / 2 } : null,
    cornerRect: b ? { left: Math.round(b.left), bottom: Math.round(b.bottom) } : null,
    vitRect: (() => { const c = vit.getBoundingClientRect();
                      return { left: Math.round(c.left), top: Math.round(c.top),
                               width: Math.round(c.width), height: Math.round(c.height),
                               bottom: Math.round(c.bottom) }; })(),
    flipped: vit.classList.contains('is-flipped'),
    zoomed: vit.classList.contains('is-zoomed'),
    peeling: vit.classList.contains('is-peeling'),
    coverVis: cs(cover).visibility,
    coverClip: cs(cover).clipPath,
    panelClip: cs(panel).clipPath,
    gripLabel: corner ? corner.getAttribute('aria-label') : null,
    fallCount: document.querySelectorAll('body > .vit-fall').length,
    fallParentIsBody: fall ? fall.parentElement === document.body : null,
    fallInline: fall ? { left: parseFloat(fall.style.left), top: parseFloat(fall.style.top),
                         width: parseFloat(fall.style.width),
                         height: parseFloat(fall.style.height) } : null,
    fallFaceClip: fall ? getComputedStyle(fall.querySelector('.vit-face')).clipPath : null,
    // 掉落中的那张纸：`matrix(a,b,c,d,tx,ty)` 的后两位就是位移（只动 transform）。
    fallTy: fall ? (() => { const m = getComputedStyle(fall).transform
                              .match(/matrix\\(([^)]+)\\)/);
                            return m ? Number(m[1].split(',')[5]) : null; })() : null,
    fallTx: fall ? (() => { const m = getComputedStyle(fall).transform
                              .match(/matrix\\(([^)]+)\\)/);
                            return m ? Number(m[1].split(',')[4]) : null; })() : null,
    now: performance.now(),
    docH: document.documentElement.scrollHeight,
  };
}"""


def state(pg):
    return pg.evaluate(STATE)


def press(pg, dx, dy, steps=6, release=True):
    """在折角中心按下，沿 45° 对角线拖 (dx, dy)（正 dx 向右、负 dy 向上 = 朝右上扯）。"""
    s = state(pg)
    x, y = s["cornerCenter"]["x"], s["cornerCenter"]["y"]
    pg.mouse.move(x, y)
    pg.mouse.down()
    for i in range(1, steps + 1):
        pg.mouse.move(x + dx * i / steps, y + dy * i / steps)
    if release:
        pg.mouse.up()
    return s


with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL + "?t=1")
    pg.wait_for_timeout(400)

    # ── 一、静止档 ───────────────────────────────────────────────────────────
    print("\n【一】静止档：折角常驻、不探出纸外")
    s = state(pg)
    check("★ `--k` 静止值是 0.2（不是 0：0 等于纸面完好无损，没地方下手）",
          s["k"] == "0.2", s["k"])
    check("★ 那片纸跟着缩到 0.2（`--k` 真的传到了 `.vit-ear` 的 transform 上）",
          (s["earTf"] or "").startswith("matrix(0.2,"), s["earTf"])
    check("★ 折角**整个落在卡片里侧**（左缘不越过卡片左缘、下缘不越过卡片下缘）——"
          "六轮那枚撇到纸外的三角就是用户说的「突兀」",
          s["cornerRect"]["left"] >= s["vitRect"]["left"] - 1
          and s["cornerRect"]["bottom"] <= s["vitRect"]["bottom"] + 1,
          f'corner {s["cornerRect"]} vs vit {s["vitRect"]["left"]}/{s["vitRect"]["bottom"]}')
    check("封面左下角缺口在（`clip-path` 5 顶点）",
          (s["coverClip"] or "").replace(" ", "").count(",") == 4, (s["coverClip"] or "")[:60])

    # ── 二、拖拽：折角跟手 ───────────────────────────────────────────────────
    print("\n【二】拖拽：折角跟手长、缺口跟着深")
    s = press(pg, 48, -48, steps=4, release=False)
    mid = state(pg)
    # 48+48 = 96px 的对角位移 ÷ 2 = 48 ⇒ k = 0.2 + 48/160 = 0.5（`EAR_MAX` 见下面的第七组）
    check("★ 拖到一半：`--k` 从 0.2 长到约 0.5（指针沿对角线走的距离 / 2 / `EAR_MAX`）",
          abs(float(mid["k"]) - 0.5) < 0.02, mid["k"])
    check("  · 那片纸跟着长（不是只有变量在变）",
          float(mid["earTf"].split(",")[0][7:]) > 0.45, mid["earTf"])
    check("  · 封面左下角的缺口**跟着深**（同一个 `--k` 驱动两处）",
          mid["coverClip"] != s["coverClip"], mid["coverClip"][:60])
    check("  · 拖拽期间挂着 `is-peeling`（过渡被关掉，折角才跟得上指针）",
          mid["peeling"] is True)
    check("  · 还没翻页（`.vit-fall` 一张都没有）", mid["fallCount"] == 0)

    # ── 三、松手弹回（这里藏着那个真 bug）───────────────────────────────────
    print("\n【三】没扯到头就松手：弹回静止档，**不许**翻页")
    s = press(pg, 24, -24, steps=3)          # 只走一小段（Δp = 24 ⇒ k ≈ 0.4）
    pg.wait_for_timeout(60)
    after = state(pg)
    check("★ 松手后 `--k` 回到 0.2（交还 sass 的静止档，不是摊平成 0）",
          after["k"] == "0.2", after["k"])
    check("★ **没有**翻页（`.vit-fall` 仍是 0、`is-flipped` 仍是 false）——"
          "浏览器对「起落同在按钮上」的手势一律补发 click，不拦的话「拖一点再松手」"
          "会照样扯断，弹回那条路根本走不到（本套件第一版就是靠这条抓出它的）",
          after["fallCount"] == 0 and after["flipped"] is False,
          f'fall {after["fallCount"]} / flipped {after["flipped"]}')
    check("  · `is-peeling` 已摘（过渡交还给 sass）", after["peeling"] is False)

    # ── 四、扯到头：这一页掉下去 ─────────────────────────────────────────────
    print("\n【四】扯到头：这一页从胶带底下抽走、掉出屏幕")
    before = state(pg)
    press(pg, 200, -200, steps=6)            # Δp = 200 ⇒ k 到顶 ⇒ 断
    pg.wait_for_timeout(40)
    torn = state(pg)
    check("★ 扯断了：body 上出现一张 `.vit-fall`（portal 到 document.body）",
          torn["fallCount"] == 1 and torn["fallParentIsBody"] is True,
          f'count {torn["fallCount"]} / parentIsBody {torn["fallParentIsBody"]}')
    check("★ 翻页照旧发生（用户原话：「虽然视觉上被扯下来，但是实际上翻页依然是页面循环」）",
          torn["flipped"] is True and before["flipped"] is False)
    check("★ 原地那一页**真的隐藏**（不隐藏就是同一页同时存在两张）",
          torn["coverVis"] == "hidden", torn["coverVis"])
    check("★ 折角跟着搬到台面上那一页（谁在上面谁才有缺口）⇒ 永远还有地方下手",
          (torn["panelClip"] or "").replace(" ", "").count(",") == 4,
          (torn["panelClip"] or "")[:60])
    check("  · 折角自己回到静止档 0.2（新露出来的那页也有它的把手）",
          torn["k"] == "0.2", torn["k"])
    check("  · 克隆纸与卡片同宽、起点比卡片顶低 11px（= 从胶带下缘之下抽出来）",
          abs(torn["fallInline"]["width"] - before["vitRect"]["width"]) <= 1
          and abs(torn["fallInline"]["top"] - (before["vitRect"]["top"] + 11)) <= 1,
          f'fall {torn["fallInline"]} / vit top {before["vitRect"]["top"]}')
    check("  · 克隆纸**不带缺口**（被扯下来的是一整张纸）",
          torn["fallFaceClip"] == "none", torn["fallFaceClip"])

    # ── 五、掉落：加速 + 不撑文档 ───────────────────────────────────────────
    print("\n【五】掉落：重力真的在起作用、且不撑文档高度")
    a = state(pg)
    pg.wait_for_timeout(220)
    b = state(pg)
    pg.wait_for_timeout(220)
    c = state(pg)
    if None in (a["fallTy"], b["fallTy"], c["fallTy"]):
        check("★ 采样点都在掉落过程中（三帧都还在）", False,
              f'{[a["fallTy"], b["fallTy"], c["fallTy"]]}')
    else:
        v1 = (b["fallTy"] - a["fallTy"]) / ((b["now"] - a["now"]) / 1000)
        v2 = (c["fallTy"] - b["fallTy"]) / ((c["now"] - b["now"]) / 1000)
        check("★ 竖直速度**在变大**（重力在起作用，不是匀速平移）",
              v2 > v1 + 100, f"{v1:.0f} → {v2:.0f} px/s")
        check("  · 横向也在走（初速取自甩手那一下，往右）", c["fallTx"] > a["fallTx"],
              f'{a["fallTx"]:.0f} → {c["fallTx"]:.0f}')
        check("★ 掉落期间**文档高度一个像素都没涨**（`position: fixed` 不参与滚动溢出；"
              "留在 `.vitrine` 里绝对定位掉，纸一边掉、页面一边长，滚动条会当众跳一下）",
              b["docH"] == before["docH"] and c["docH"] == before["docH"],
              f'before {before["docH"]} / 掉中 {b["docH"]}, {c["docH"]}')

    print("\n【六】掉出视口后销毁")
    pg.wait_for_timeout(2500)
    gone = state(pg)
    check("★ 克隆纸被销毁（DOM 里不留残骸）", gone["fallCount"] == 0, str(gone["fallCount"]))
    check("  · 卡片与折角都还在、仍是翻过去那一页（掉的只是那张纸）",
          gone["flipped"] is True and gone["cornerRect"] is not None)

    # ── 七、点一下 = **先掀起折角**、再扯（键盘同理）─────────────────────────
    # 20261001 八轮（用户第 5 条：「单击没有掀起左下角动画直接掉下去了，而且我感觉动画
    # 扯起来的角的**终点**可以更大一些」）：原来 `onCornerClick` 直接 `tear(...)`，
    # 折角一步从静止档（0.2）跨到"纸已经没了"。现在先把它掀到 1、等过渡演完再脱落。
    print("\n【七】点一下 / 回车：先把折角**掀到头**，再脱落（`<button>` ⇒ Tab 可达）")
    check("  折角仍是个有名字的按钮", (gone["gripLabel"] or "").startswith("扯下这一页"),
          gone["gripLabel"])
    pg.evaluate("() => document.querySelector('.vit-corner').focus()")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(80)
    lift = state(pg)
    # ⚠️ 判据要连着读两条：`--k` 是**未注册**的自定义属性、不参与插值 ⇒ 写下去就是 1，
    # 光看它证明不了"有动画"；而 `.vit-ear` 的 transform 走那条 0.3s 过渡 —— 80ms 时
    # 它该停在静止档与 1 之间。只读 `--k` 的话，"退化成没有过渡的瞬间跳变"照样能骗过它。
    check("★ 按下先**掀起折角**（`--k` 推到 1），这一页**还没掉**（原来这里直接就掉了 ——"
          "`flipped` 仍是掀之前那一面、body 上没有克隆纸）",
          lift["k"] == "1" and lift["fallCount"] == 0 and lift["flipped"] is gone["flipped"],
          f'k {lift["k"]} / fall {lift["fallCount"]} / flipped {lift["flipped"]}')
    check("★ 掀起是**看得见的过程**（80ms 时那片纸停在静止档与 1 之间 —— 有过渡，不是跳变）",
          0.2 < float(lift["earTf"].split(",")[0][7:]) < 0.99, lift["earTf"])
    pg.wait_for_timeout(600)                 # 掀 = 0.34s（`LIFT_MS`），再等它掉起来
    keyed = state(pg)
    check("★ 掀到头之后才脱落（回车也能扯，键盘用户不是二等公民）",
          keyed["fallCount"] == 1 and keyed["flipped"] is False,
          f'fall {keyed["fallCount"]} / flipped {keyed["flipped"]}')
    check("  · 折角交还静止档（掀的那一下不是把纸角永久改了）",
          keyed["k"] == "0.2", keyed["k"])
    pg.wait_for_timeout(2600)                # 等上一张纸掉完，两轮别混在一起
    # 真·鼠标**单击**（用户第 5 条的原话就是「**单击**没有掀起左下角动画」）。与回车走的是
    # 同一个 `onClick`，但它前面多了一对 pointerdown/pointerup —— 那一对会先按拖拽的起手/
    # 收手跑一遍（挂上又摘掉 `is-peeling`、`setEar(null)` 交还静止档）。只测回车的话，
    # "收手时把 `--k` 写死成 0.2、掀的动作再也起不来"这类断链会漏网。
    c = state(pg)["cornerCenter"]
    pg.mouse.click(c["x"], c["y"])
    pg.wait_for_timeout(80)
    clicked = state(pg)
    check("★ 鼠标单击同样**先掀起**（`--k` 推到 1、纸还没掉）——"
          "前面那对 pointerdown/up 没把掀的动作吃掉",
          clicked["k"] == "1" and clicked["fallCount"] == 0,
          f'k {clicked["k"]} / fall {clicked["fallCount"]}')
    pg.wait_for_timeout(600)
    done = state(pg)
    check("★ 掀到头之后脱落（单击翻页闭环）",
          done["fallCount"] == 1 and done["flipped"] is True,
          f'fall {done["fallCount"]} / flipped {done["flipped"]}')
    pg.wait_for_timeout(2600)

    # ── 八、减少动效：纸不掉，但**页照翻** ───────────────────────────────────
    print("\n【八】减少动效档：不做抛体，但翻页照常发生")
    pg.emulate_media(reduced_motion="reduce")
    pg.goto(URL + "?t=2")
    pg.wait_for_timeout(400)
    r0 = state(pg)
    press(pg, 200, -200, steps=6)
    pg.wait_for_timeout(120)
    r1 = state(pg)
    check("★ 减少动效档下**不生成**克隆纸（TSX 的 `prefersReducedMotion()` 直接跳过抛体）",
          r0["fallCount"] == 0 and r1["fallCount"] == 0,
          f'{r0["fallCount"]} → {r1["fallCount"]}')
    check("★ 但翻页照旧发生（用户要的是「别晃」，不是「别翻」）",
          r0["flipped"] is False and r1["flipped"] is True)
    # 「点一下」那条路在这一档里也**不掀**：要是照常掀，60ms 时 `--k` 会是 1（定时器还没
    # 到点），用户就白等 0.34 秒才看到纸掉 —— 减少动效档要的正是"别让我等"。
    pg.evaluate("() => document.querySelector('.vit-corner').focus()")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(60)
    r2 = state(pg)
    check("★ 减少动效档下点一下**不掀**（`--k` 没被推到 1、页已经翻回去、纸不掉）",
          r2["k"] == "0.2" and r2["flipped"] is False and r2["fallCount"] == 0,
          f'k {r2["k"]} / flipped {r2["flipped"]} / fall {r2["fallCount"]}')

    check("全程无页面异常", not errs, "; ".join(errs[:3]))
    pg.close()
    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 展示柜撕纸翻页：全部通过")
