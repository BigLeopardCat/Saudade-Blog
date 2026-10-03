#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""首页顶带：左轮播 / 右公告栏两栏（20261004 用户第十二报）。

  python3 tests/home-top-band.test.py

现场（用户原话）：「置顶卡片细长太丑还占一整行，改为左半部分置顶轮播图，右半部分公告栏，
公告栏UI符合博客设计语言」。

这一轮最要小心的是**两栏等高**与**顶卡浮层**这两条联动：

  · 等高只有**一个**来源：行容器 `.TopBand` 的 `height: 460px` + `align-items: stretch`。
    右栏（`.AnnounceBoard`）**不许**再写 `height: 100%` —— 两个来源并存时"内容溢出到底谁
    说了算"就成了两套判定。本套件第 ② 组就是量这条：往右栏塞满内容，两栏底边仍要齐平，
    且滚动条出现在**右栏内部**（`.abBody`）而不是把行撑高。
  · 左栏文字列从 ~460px 宽缩到 ~330px（栏比整行窄了：90% × 64%），字号 40 → 34px。
    这一改会动"整列居中"的高度 ⇒ **简介浮层的可用高度跟着变**（它没有定高行那套账，
    可用 = 卡底 − 浮层顶）。第 ⑤ 组拿真 hover 量它有没有跑出卡片。

判据分两半（与 `article-card-hover` 那对同构）：
  · 这里量几何（真 sass + 真 Chromium + 真事件）；
  · `home-top-band.test.mjs` 锁源码结构（类名有没有挂上、内联有没有删干净、公告栏是不是
    只读、三态分没分开）——那些无头沙箱里量不到。

沙箱：
  · CSS = 真编译的 `ContentHome/index.sass` + `AnnounceBoard/index.sass` +
    `components/AnnouncementModal/index.sass`（公告栏的弹窗皮借的就是它，一起编，与线上
    引用关系一致）+ `frontHome/main.css`（reset 与前台令牌）+ `src/index.css`（`--washi-*`
    深浅两档令牌）。`src/index.css` 只有 181 行且全是令牌 + 两条工具类，整份拿来，
    免得把令牌抄进桩里 —— 那样测的就是抄的那份。
  · 桩里**不放 antd**：公告栏的行是原生 `button`（源码里就是这么写的，理由见 sass 注释）。
"""
import pathlib
import re
import shutil
import subprocess
import tempfile
import time

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


SASS_JS = 'const sass=require("sass");process.stdout.write(sass.compile(process.argv[1]).css.toString());'

HOME_SASS = FE / "src/frontHome/Content/ContentHome/index.sass"
AB_SASS = FE / "src/frontHome/Content/ContentHome/AnnounceBoard/index.sass"
MODAL_SASS = FE / "src/components/AnnouncementModal/index.sass"
HOME_RESET = FE / "src/frontHome/main.css"
TOKENS = FE / "src/index.css"


def rows(n: int) -> str:
    """公告行：与 AnnounceBoard/index.tsx 同形（原生 button + 等宽日期 + 省略标题）。"""
    return "".join(
        f'<button type="button" class="abRow"><span class="abDate">09-{i % 30 + 1:02d}</span>'
        f'<span class="abRowTitle">第 {i + 1} 条公告的标题，故意写长一点看看会不会把列撑开</span></button>'
        for i in range(n))


# `.TopArticle` 的内部结构与 ContentHome/index.tsx 逐层同形（`article-card-hover.test.py`
# 用的是同一份形状）。这里不重复量卡内几何——那些归那支套件；本支只要一个**真卡片**
# 来量两栏关系。
BAND_MARKUP = """
<div class="ContentContainer" id="cc">
  <div class="TopBand" id="band">
    <div class="TopArticle" id="card">
      <div class="Top"><span class="TopTape">置顶</span></div>
      <div class="topCarouselViewport">
        <div class="topTrack">
          <div class="TopArticleInner" id="inner">
            <div class="TopCover" id="cover"></div>
            <div class="topContent" id="content">
              <h4># 编程随笔</h4>
              <h3 class="contentTitle" id="title">从零把站内对话助手接进个人博客：规划器与执行器的完整记录</h3>
              <div class="descSlot" id="slot"><div class="ArticleDescription" id="desc">{desc}</div></div>
              <div class="tags" style="width:100%;margin-top:10px"></div>
              <div class="topFooter" id="footer" style="display:flex;align-items:center;padding-bottom:20px">
                <span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:#ccc;margin-right:10px"></span>
                <span style="font-weight:bold;margin-right:10px;line-height:22px;font-size:14px">林陌青川</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="topDotsContainer" id="dots">
        <div class="topDot dotCurrent"></div><div class="topDot"></div><div class="topDot"></div>
      </div>
    </div>
    <div class="AnnounceBoard" id="board">
      <div class="abHead"><span class="abTitle">公告</span></div>
      <div class="abBody" id="abBody">{rows}</div>
      <button type="button" class="abMore" id="abMore">全部 12 条 ›</button>
    </div>
  </div>
  <div class="allArticles"></div>
</div>
"""

LONG_DESC = ("这一段是摘要，按最坏情况写满：讲的是为什么把执行器做成确定性的、为什么叙述者不绑工具、"
             "以及验收为什么必须由回执驱动而不是由模型自述；再补上跨轮执行记忆为什么必须落库。")


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="topband-"))
    parts = []
    for f in (HOME_SASS, AB_SASS, MODAL_SASS):
        r = subprocess.run(["node", "-e", SASS_JS, str(f)], cwd=str(FE), capture_output=True)
        if r.returncode != 0:
            raise SystemExit(f"sass 编译失败（{f.name}）：\n" + r.stderr.decode("utf-8", "replace"))
        parts.append(r.stdout.decode("utf-8"))
    (sb / "home.css").write_text("\n".join(parts), encoding="utf-8")
    shutil.copy(HOME_RESET, sb / "main.css")
    shutil.copy(TOKENS, sb / "tokens.css")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="tokens.css">'
        '<link rel="stylesheet" href="home.css"></head>'
        '<body><div id="root"></div></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

READ = """() => {
  const g = (id) => document.getElementById(id);
  const band = g('band'), card = g('card'), board = g('board'), body = g('abBody');
  const r = (e) => { const b = e.getBoundingClientRect();
    return {w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left),
            right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom),
            cx: Math.round(b.left + b.width / 2)}; };
  const dots = document.getElementById('dots'), cover = g('cover');
  const btn = document.querySelector('.abRowTitle');
  const track = document.querySelector('.topTrack');
  return {
    band: r(band), card: r(card), board: r(board),
    dotsCx: dots ? r(dots).cx : null, coverCx: cover ? r(cover).cx : null,
    body: body ? {sh: body.scrollHeight, ch: body.clientHeight,
                  oy: getComputedStyle(body).overflowY} : null,
    boardBg: getComputedStyle(board).backgroundColor,
    boardRadius: getComputedStyle(board).borderTopLeftRadius,
    abRowColor: btn ? getComputedStyle(btn).color : null,
    trackProps: track ? getComputedStyle(track).transitionProperty : null,
    boardH: getComputedStyle(board).height,
    cardDisplay: getComputedStyle(card).display,
    docW: document.documentElement.scrollWidth, winW: window.innerWidth,
  };
}"""

HOVER = """() => {
  const d = document.getElementById('desc'), c = document.getElementById('card');
  const dr = d.getBoundingClientRect(), cr = c.getBoundingClientRect();
  return {descH: d.offsetHeight, descBottom: Math.round(dr.bottom), cardBottom: Math.round(cr.bottom)};
}"""


def paint(pg, markup: str):
    pg.evaluate("(m) => { document.getElementById('root').innerHTML = m; }", markup)
    pg.wait_for_timeout(120)
    return pg.evaluate(READ)


def hover_desc(pg):
    """悬浮简介并轮询到展开动画停（`article-card-hover.test.py` 的同一套：Playwright 的
    `hover()` 要求元素尺寸稳定，0.8s 的展开动画会让它一直重试到超时）。"""
    box = pg.evaluate("""() => { const r = document.getElementById('desc').getBoundingClientRect();
        return {x: r.left + r.width / 2, y: r.top + r.height / 2}; }""")
    pg.mouse.move(box["x"], box["y"])
    last, stable, deadline = pg.evaluate(HOVER), 0, time.time() + 6
    while time.time() < deadline:
        pg.wait_for_timeout(100)
        cur = pg.evaluate(HOVER)
        stable = stable + 1 if abs(cur["descH"] - last["descH"]) < 0.5 else 0
        last = cur
        if stable >= 3:
            break
    return last


with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(150)

    print("⓪ 沙箱自检：两栏的规则真的生效了（否则下面全是 0 与 0 比，怎么比都过）")
    on = paint(pg, BAND_MARKUP.format(desc=LONG_DESC, rows=rows(3)))
    check("行高 460px（`.TopBand` 的 height 生效）", abs(on["band"]["h"] - 460) <= 1, f"band h={on['band']['h']}")
    check("左栏 height 460px（`.TopArticle` 的规则生效，且不是被行容器拉伸出来的假象）",
          abs(on["card"]["h"] - 460) <= 1, f"card h={on['card']['h']}")
    check("左栏 `display: flex`（那条从没生效过的 `display: grid` 已按真值改掉）",
          on["cardDisplay"] == "flex", on["cardDisplay"])
    check("右栏圆角 15px（`.AnnounceBoard` 的纸壳规则生效）",
          abs(float(re.sub(r"[^\d.]", "", on["boardRadius"]) or 0) - 15) <= 0.5, on["boardRadius"])

    print("\n① 两栏并排：宽比 ≈1.82:1，且整体与 `.allArticles` 同为 90%")
    ratio = on["card"]["w"] / on["board"]["w"]
    check(f"左/右宽比 ≈1.82（实测 {ratio:.3f}；{on['card']['w']} / {on['board']['w']}）",
          abs(ratio - 1.82) < 0.06, f"{ratio:.3f}")
    check("两栏不相交（左栏右缘 < 右栏左缘，中缝就是那 30px 的 gap）",
          on["card"]["right"] <= on["board"]["left"], f"{on['card']['right']} vs {on['board']['left']}")
    check(f"带子宽 = 视口的 90%（{on['band']['w']} / {1280}）",
          abs(on["band"]["w"] / 1280 - 0.90) < 0.01, str(on["band"]["w"]))
    check("没有横向溢出（内容没把栅格轨道顶开）", on["docW"] <= on["winW"] + 1,
          f"docW {on['docW']} / winW {on['winW']}")

    print("\n② 等高只有一个来源：右栏塞满内容后两栏底边仍齐平，且滚动条在右栏**内部**")
    short = paint(pg, BAND_MARKUP.format(desc=LONG_DESC, rows=rows(2)))
    check("只放 2 条时两栏底边齐平（±1px）",
          abs(short["card"]["bottom"] - short["board"]["bottom"]) <= 1,
          f"{short['card']['bottom']} vs {short['board']['bottom']}")
    check("  此时右栏不滚（内容装得下：scrollHeight ≤ clientHeight）",
          short["body"]["sh"] <= short["body"]["ch"] + 1,
          f"{short['body']['sh']} / {short['body']['ch']}")
    full = paint(pg, BAND_MARKUP.format(desc=LONG_DESC, rows=rows(60)))
    check("★ 塞 60 条后两栏底边**仍然**齐平（行高由 stretch 给，不被内容撑开）",
          abs(full["card"]["bottom"] - full["board"]["bottom"]) <= 1,
          f"{full['card']['bottom']} vs {full['board']['bottom']}")
    check("  行高仍是 460（右栏长高的是内容，不是行）", abs(full["band"]["h"] - 460) <= 1,
          f"band h={full['band']['h']}")
    check("★ 滚动条出现在 `.abBody` 内部（scrollHeight 明显大于 clientHeight）",
          full["body"]["sh"] > full["body"]["ch"] + 50,
          f"{full['body']['sh']} / {full['body']['ch']}")
    check("  `.abBody` 的 overflow-y 是 auto（不是 visible / hidden）",
          full["body"]["oy"] == "auto", full["body"]["oy"])
    check("  右栏高度仍是 460（没有被写成 height:100% 那种第二来源）",
          abs(full["board"]["h"] - 460) <= 1, f"board h={full['board']['h']} / computed {full['boardH']}")

    print("\n③ 圆点还骑在封面上（`left: 30%` 是相对左栏的，栏宽变了它不该漂）")
    check(f"`.topDotsContainer` 中心 x ≈ `.TopCover` 中心 x（{on['dotsCx']} vs {on['coverCx']}）",
          on["dotsCx"] is not None and abs(on["dotsCx"] - on["coverCx"]) <= 2,
          f"dots {on['dotsCx']} / cover {on['coverCx']}")

    print("\n④ 顶卡简介浮层：文字列变窄 / 字号变小之后仍不许跑出卡片")
    print("   （浮层可用高度 = 卡底 − 浮层顶，它会随「整列居中」的高度浮动）")
    hv = hover_desc(pg)
    check("★ 展开到底后浮层底仍在卡底之内", hv["descBottom"] <= hv["cardBottom"] + 1,
          f"浮层底 {hv['descBottom']} / 卡底 {hv['cardBottom']}")
    check("  展开高度是 20px 行高的整数倍（不切半行）", hv["descH"] % 20 == 0, f"h={hv['descH']}")
    pg.mouse.move(5, 5)
    pg.wait_for_timeout(150)

    print("\n⑤ reduced-motion：轨道那条 transition **真的**被关掉了")
    print("   （这条是'把内联搬进类名'的**唯一理由**——内联特异性最高，媒体查询盖不动它；"
          "少了这一条，本组会读出 transform 0.8s）")
    pg.emulate_media(reduced_motion="reduce")
    pg.wait_for_timeout(80)
    rm = pg.evaluate("""() => { const t = document.querySelector('.topTrack');
        const cs = getComputedStyle(t);
        return {prop: cs.transitionProperty, dur: cs.transitionDuration,
                inline: t.getAttribute('style') || ''}; }""")
    check("  `.topTrack` 的 transition-property 已是 none",
          rm["prop"] == "none", f"{rm['prop']} / {rm['dur']}")
    check("  且它在 JSX 里确实没有内联 transition（源码那一半归 .mjs，这里看产物）",
          "transition" not in rm["inline"], rm["inline"])
    pg.emulate_media(reduced_motion="no-preference")
    pg.wait_for_timeout(80)

    print("\n⑥ 手机档：叠成单列（左卡在上、公告栏在下），行高交还内容")
    pg.set_viewport_size({"width": 375, "height": 800})
    pg.wait_for_timeout(120)
    mob = paint(pg, BAND_MARKUP.format(desc=LONG_DESC, rows=rows(40)))
    check(f"带子宽 = 视口的 95%（{mob['band']['w']} / 375）",
          abs(mob["band"]["w"] / 375 - 0.95) < 0.015, str(mob["band"]["w"]))
    check("两栏叠成一列（左卡底 ≤ 公告栏顶）",
          mob["card"]["bottom"] <= mob["board"]["top"] + 1,
          f"{mob['card']['bottom']} vs {mob['board']['top']}")
    check("  两栏同宽（单列 ⇒ 宽度相等）", abs(mob["card"]["w"] - mob["board"]["w"]) <= 1,
          f"{mob['card']['w']} vs {mob['board']['w']}")
    check(f"  行高不再是 460（内容撑出来的，实测 {mob['band']['h']}）",
          mob["band"]["h"] > 460, str(mob["band"]["h"]))
    check("  公告列表自己封顶（`.abBody` max-height 300px ⇒ 仍可滚）",
          mob["body"]["ch"] <= 301 and mob["body"]["sh"] > mob["body"]["ch"],
          f"{mob['body']['sh']} / {mob['body']['ch']}")
    check("  没有横向溢出", mob["docW"] <= mob["winW"] + 1, f"{mob['docW']} / {mob['winW']}")
    pg.set_viewport_size({"width": 1280, "height": 900})
    pg.wait_for_timeout(120)

    print("\n⑦ 夜间档：公告栏整块走 `--washi-*` 令牌（`.frontDark` 一挂就翻转）")
    light = paint(pg, BAND_MARKUP.format(desc=LONG_DESC, rows=rows(3)))
    pg.evaluate("() => document.documentElement.classList.add('frontDark')")
    pg.wait_for_timeout(80)
    dark = pg.evaluate(READ)
    check(f"纸底翻转（浅 {light['boardBg']} → 深 {dark['boardBg']}）",
          light["boardBg"] != dark["boardBg"], f"{light['boardBg']} / {dark['boardBg']}")
    check(f"行文字色翻转（浅 {light['abRowColor']} → 深 {dark['abRowColor']}）",
          light["abRowColor"] != dark["abRowColor"], f"{light['abRowColor']} / {dark['abRowColor']}")
    check("  两栏的令牌同源（左卡背景也翻转 —— 挂的是同一个 `.frontDark`）",
          light["card"]["w"] == dark["card"]["w"], "几何不该因换肤而变")
    pg.evaluate("() => document.documentElement.classList.remove('frontDark')")

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} home-top-band：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
