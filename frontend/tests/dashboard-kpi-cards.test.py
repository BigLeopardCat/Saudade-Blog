# -*- coding: utf-8 -*-
"""后台首页左栏三张统计条（文章 / 分类 / 标签）的布局验收。

两轮用户意见叠在同一处，判据也叠在这一个脚本里：

· **20260930**「文章总数分类总数，标签总数这三个卡片布局优化」。改之前那套是
  **三处百分比高度串成一条链**：`.analyticsCard{height:75%}` + 每张 `.akCard{height:22%}`
  + `.akCard{width:75%}`（≤1530px 干脆钉成 `width:210px`），而同一个盒子的
  `padding/height/display/flex` 又同时写在 TSX 的 `bodyStyle` 内联里 —— 最终高度是谁定的，
  读代码看不出来，列一变宽就宽窄对不齐、一变矮就把内容挤出去。那一轮把它收成
  "这一列是竖向 flex，三张卡等分、宽度 100% 跟着列走"。

· **20261001**「改成书签的样式大小就是细条书签贴在边上不需要占这么大地方」。
  上一轮把"高度是谁定的"理清楚了，但**卡本身还是三张大卡**（实测吃掉左栏 ~380px）。
  这一轮换成**书签条**：每条 34px、左缘贴在列的左缘（不留圆角）、右端切一道燕尾
  （`clip-path` 挖 V 口），整组 ~122px。标签与数字也从**上下两行**并成**一条线**。

为什么值得单起一个脚本而不是靠眼睛：这个组件的缺陷**全是几何的**（等不等高、越没越界、
内容有没有被裁、燕尾是不是真切出来了），而它在页面里长什么样取决于列有多高多宽 ——
只在"某一档视口"下看过一次，换个高度就变了。所以这里量四档：常规 / 窄列 / 被压矮 /
压到极限，外加一档 `.dark`，并且**带一个对照**（把"大卡"那套规则注入回去，验"判据真的
会红"——判据没牙就等于没测）。

沿用 `dashboard-home.test.py` 那套装配手段（esbuild 打真组件 + 真 sass + 只桩边界）：
react / react-dom / antd 都是真的，react-redux 与 react-countup 是桩。

用法：python3 frontend/tests/dashboard-kpi-cards.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/sass）、playwright(python)。
"""
import functools
import http.server
import io
import pathlib
import re
import shutil
import subprocess
import tempfile
import threading

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
SASS_FILES = ["src/components/articleAnalytics/index.sass"]

DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production",'
          '"DEV":false,"PROD":true,"BASE_URL":"/"}')

# 三个数**刻意取不同位数**（1 位 / 4 位带千分位 / 3 位）：CountUp 从 0 涨到真实值的
# 过程中数字宽度会跳，标签不能被挤出去 —— 用同一个位数就测不出这条。
COUNTS = {"noteCount": 1024, "tagCount": 128, "categoryCount": 9}

# 设计量（与 index.sass 是同一个数，改一处要改两处）。
STRIP_H = 34          # 一条书签的高度
STRIP_GAP = 10        # 条间距
GROUP_H = 3 * STRIP_H + 2 * STRIP_GAP   # 122
BATCH = 22            # 徽章边长
NOTCH = 11            # 燕尾 V 口的深度

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="kpi-cards-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    stubs = sb / "stubs"
    stubs.mkdir()

    # 边界①：react-redux。状态对象**同一实例**（每次返回新对象会让 useSelector 判定
    # "变了"而无限重渲染）。
    (stubs / "redux.tsx").write_text(
        "const state: any = {notes: {noteCount: %d, noteList: [], loading: false},"
        " tags: {tagCount: %d, tagList: []},"
        " categories: {categoryCount: %d, categoryList: []}};\n"
        "export const useSelector = (fn: any) => { try { return fn(state); } catch { return undefined; } };\n"
        "export const useDispatch = () => (_a: any) => undefined;\n"
        "export const Provider = ({children}: any) => children;\n"
        % (COUNTS["noteCount"], COUNTS["tagCount"], COUNTS["categoryCount"]),
        encoding="utf-8")

    # 边界②：react-countup。真的会从 0 缓动到 end（几十帧），断言会读到中间值 ⇒
    # 桩成"直接给终值"。**千分位照真实现补上**（CountUp 的 `separator=","` 就是它干的），
    # 否则"1,024"这条断言测的是桩而不是组件。
    (stubs / "countup.tsx").write_text('''\
const CountUp = ({end}: {end: number}) =>
  <span>{Number(end).toLocaleString('en-US')}</span>;
export default CountUp;
''', encoding="utf-8")

    # 边界③：react-router-dom（组件用 useNavigate 跳转；本沙箱只量几何）
    (stubs / "router.tsx").write_text('''\
export const useNavigate = () => (to: string) => { (window as any).__nav = ((window as any).__nav || []).concat([to]); };
export const Link = ({children}: any) => children;
export const Outlet = () => null;
export const useLocation = () => ({pathname: '/dashboard', search: ''});
''', encoding="utf-8")

    # 挂载壳：**照抄** Home/index.tsx 里 `.left` 那份内联样式（竖向 flex + 定高），
    # 上面垫一个与 `.about_logo` 同高的空块 —— 三张条子拿到的就是真页面里那段剩余高度。
    (sb / "entry.tsx").write_text('''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ArticleAnalytics from './src/components/articleAnalytics/index.tsx';

(window as any).__mount = (o: any) => {
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <div className={o.dark ? 'dark' : ''} style={{height: '100%'}}>
      <div className="home" style={{height: '100%'}}>
        <div className="left" style={{height: '100%', width: o.colWidth + 'px',
                                      display: 'flex', flexDirection: 'column'}}>
          <div className="about_logo" style={{flex: '0 0 auto', height: o.head + 'px'}} />
          <ArticleAnalytics />
        </div>
      </div>
    </div>
  );
};
''', encoding="utf-8")

    subprocess.run(["node", "-e",
                    "const s=require('sass'),fs=require('fs');"
                    "const out=process.argv.slice(1,-1).map(p => s.compile(p,{style:'expanded'}).css).join('\\n');"
                    "fs.writeFileSync(process.argv[process.argv.length-1], out);",
                    *[str(FE / f) for f in SASS_FILES], str(sb / "cards.css")],
                   cwd=str(FE), check=True)

    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic", f"--define:{DEFINE}",
                    "--loader:.png=dataurl", "--loader:.svg=dataurl", "--loader:.css=text",
                    f"--alias:react-redux={stubs}/redux.tsx",
                    f"--alias:react-countup={stubs}/countup.tsx",
                    f"--alias:react-router-dom={stubs}/router.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="cards.css"></head><body>'
        '<div id="root" style="height:100vh"></div>'
        '<script src="bundle.js"></script>'
        '</body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()

from playwright.sync_api import sync_playwright  # noqa: E402

# 量一遍几何：容器、三条书签、标签/数字、以及"内容有没有被裁"的两个 scroll 读数。
MEASURE = """() => {
  const rect = (el) => el ? el.getBoundingClientRect() : null;
  const box = (el) => el ? {h: rect(el).height, w: rect(el).width, top: rect(el).top,
                            bottom: rect(el).bottom, left: rect(el).left,
                            right: rect(el).right} : null;
  const c = document.querySelector('.analyticsCard');
  const cards = [...document.querySelectorAll('.akCard')];
  const cs = getComputedStyle(c);
  return {
    container: {...box(c), scrollH: c.scrollHeight, clientH: c.clientHeight,
                overflowY: cs.overflowY, overflowX: cs.overflowX},
    col: box(document.querySelector('.left')),
    scroll: {x: window.scrollX, y: window.scrollY},
    cards: cards.map((el) => {
      const body = el.querySelector('.ant-card-body');
      const label = el.querySelector('.akLabel');
      const val = el.querySelector('.ant-statistic-content-value');
      const badge = el.querySelector('.akBadge');
      const ecs = getComputedStyle(el);
      return {
        ...box(el),
        bg: ecs.backgroundColor,
        clip: ecs.clipPath,
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        bodyScrollH: body ? body.scrollHeight : 0,
        bodyClientH: body ? body.clientHeight : 0,
        label: label ? label.textContent.trim() : null,
        labelTop: label ? rect(label).top : 0,
        labelBottom: label ? rect(label).bottom : 0,
        labelRight: label ? rect(label).right : 0,
        labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : null,
        labelColor: label ? getComputedStyle(label).color : null,
        value: val ? val.textContent.trim() : null,
        valueTop: val ? rect(val).top : 0,
        valueLeft: val ? rect(val).left : 0,
        badgeBox: box(badge),
      };
    }),
  };
}"""


def mount(pg, url, **opts):
    pg.goto(url)
    pg.evaluate("(o) => window.__mount(o)", {"colWidth": 320, "head": 200, "dark": False, **opts})
    pg.wait_for_timeout(350)
    return pg.evaluate(MEASURE)


def card_shot(pg, r, card):
    """把一条书签原样截下来（含它外面的页面底），供像素判据用。

    ⚠️ 为什么不解析 `clip-path` 的计算值：Chromium 对它**保留百分比不解析** ——
    读回来是 `polygon(0px 0px, 100% 0px, calc(100% - 11px) 50%, 100% 100%, 0px 100%)`，
    要比顶点就得自己把 `100%` / `calc()` 再算一遍，那等于把被测的几何在测试里重写一份
    （写错了两边一起错，还测不出来）。取像素是**对着渲染结果**量。
    """
    x0 = card["left"] + r["scroll"]["x"]
    y0 = card["top"] + r["scroll"]["y"]
    return Image.open(io.BytesIO(pg.screenshot(
        clip={"x": x0, "y": y0, "width": int(round(card["w"])),
              "height": int(round(card["h"]))}))).convert("RGB")


def near(a, b, tol=26):
    return max(abs(a[i] - b[i]) for i in range(3)) <= tol


def card_color(card):
    return tuple(int(v) for v in re.findall(r"\d+", card["bg"])[:3])


def notch_depth(shot, color, y=None):
    """右侧中线那条扫描线上，**条子色最后出现的位置**距右缘多少像素。

    这就是燕尾的深度：矩形是 0、V 口是设计值 11、"收成一个箭头尖"会比 11 大得多。
    比"取一个点看是不是透明"强的地方在于它给出**一个数**，深度写错了也能抓到。
    """
    w, h = shot.size
    y = h // 2 if y is None else y
    for x in range(w - 1, -1, -1):
        if near(shot.getpixel((x, y)), color):
            return w - x
    return w


def main():
    url = SANDBOX.as_uri() + "/index.html"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1600, "height": 900})

        print("\n① 常规档：三条细书签、等长等高、贴列左缘、整组不再吃掉这一列")
        r = mount(pg, url)
        cards = r["cards"]
        cont = r["container"]
        check("三条书签都渲染出来了", len(cards) == 3, f"count={len(cards)}")
        if len(cards) == 3:
            hs = [round(c["h"], 1) for c in cards]
            ws = [round(c["w"], 1) for c in cards]
            check(f"三条等高（{hs}）", max(hs) - min(hs) < 1, f"max-min={max(hs) - min(hs):.1f}")
            check(f"三条等宽（{ws}）", max(ws) - min(ws) < 1, f"max-min={max(ws) - min(ws):.1f}")
            check(f"宽度跟着列走（列 320px ⇒ 条 {ws[0]:.0f}px，不再是 75% / 固定 210px）",
                  abs(ws[0] - 320) < 1, f"card={ws[0]:.1f}")
            # 「书签大小」= 这一轮的题目本身。34px 是设计的量，不跟内容走。
            check(f"每条都是细条（高 {hs[0]:.0f}px ≤ 44）", max(hs) <= 44, str(hs))
            check(f"整组高 {GROUP_H}px（三条 + 两道 10px 缝）",
                  abs((max(c["bottom"] for c in cards) - min(c["top"] for c in cards)) - GROUP_H) < 2,
                  f"{max(c['bottom'] for c in cards) - min(c['top'] for c in cards):.1f}")
            # 用户原话是「不需要占这么大地方」。旧版三张大卡实测吃掉左栏 ~380px，
            # 这里把它钉住：整组必须**远小于**列高。
            group = max(c["bottom"] for c in cards) - min(c["top"] for c in cards)
            col_h = cont["bottom"] - cont["top"]
            check(f"整组只占列高的一小块（{group:.0f}/{col_h:.0f}px）",
                  group <= 160, f"{group:.0f}px")
            # 「贴在边上」：条子左缘与容器左缘齐平（左边缘不留圆角，是"夹进纸里"的那一头）
            check("三条左缘与容器左缘齐平（贴在边上）",
                  all(abs(c["left"] - cont["left"]) < 1 for c in cards)
                  and all(abs(c["left"] - cards[0]["left"]) < 1 for c in cards),
                  f"条[{cards[0]['left']:.0f}] 容器[{cont['left']:.0f}]")
            check(f"整组没溢出容器（最低 {max(c['bottom'] for c in cards):.0f} ≤ 容器底 {cont['bottom']:.0f}）",
                  max(c["bottom"] for c in cards) <= cont["bottom"] + 1)
            check("容器没被撑出滚动条", cont["scrollH"] <= cont["clientH"] + 1,
                  f"scrollH={cont['scrollH']} clientH={cont['clientH']}")
            for i, c in enumerate(cards):
                check(f"第 {i + 1} 条：内容没被裁（body {c['bodyScrollH']} ≤ {c['bodyClientH']}）",
                      c["bodyScrollH"] <= c["bodyClientH"] + 1)
                check(f"第 {i + 1} 条：文字没被挤出条子", c["scrollW"] <= c["clientW"] + 1)

        print("\n② 右端燕尾：`clip-path` 真的切出那个 V 口（对着像素量，不解析 clip-path）")
        # 手势读法：左缘直边（贴纸边）+ 右端挖一道 V。与置顶缎带 `.TopTape`（右端收成
        # 箭头**尖**）是同族两种收尾 —— 不许退回"两头一样圆的胶囊"。
        if len(cards) == 3:
            shot = card_shot(pg, r, cards[0])
            col = card_color(cards[0])
            w, h = shot.size
            depth = notch_depth(shot, col)
            check(f"右端中线被切掉 {NOTCH}px（V 口底的深度与设计值一致）",
                  abs(depth - NOTCH) <= 2, f"实测 {depth}px  条色{col}")
            check("左缘是直边（书签「夹进纸里」的那一头，没被切）",
                  near(shot.getpixel((2, h // 2)), col),
                  f"{shot.getpixel((2, h // 2))}")
            # 燕尾留下的上下两个尖角。**这两条把"右端收成一个箭头尖"与"斜切一刀"都
            # 排除了** —— 那两种形状在这两行上的边界都落在 x = w-7 的左边。
            # ⚠️ 取样点不能贴到右缘：V 口的两条斜边在 y=2 处已经到了 x=w-1.3、
            # 在 y=h-3 处到了 x=w-1.9（这条是斜向条子中线的），贴边的点会取到反锯齿
            # 的混合色 —— 本套件初版取 x=w-2 就是这么假红的两条。
            px_ = w - NOTCH // 2 - 2
            check("右端上尖角还在（不是收成一个箭头尖、也不是斜切）",
                  near(shot.getpixel((px_, 2)), col), f"{shot.getpixel((px_, 2))}")
            check("右端下尖角还在",
                  near(shot.getpixel((px_, h - 3)), col), f"{shot.getpixel((px_, h - 3))}")

        print("\n③ 一条线排布：标签在左、数字在右，同一行（这一轮从两行并成一行）")
        want = [("文章总数", "1,024"), ("分类总数", "9"), ("标签总数", "128")]
        for i, (label, value) in enumerate(want):
            if i >= len(cards):
                break
            check(f"第 {i + 1} 条：标签「{label}」", cards[i]["label"] == label, cards[i]["label"])
            check(f"第 {i + 1} 条：数值 {value}（千分位由 CountUp 的 separator 给）",
                  cards[i]["value"] == value, cards[i]["value"])
        if len(cards) == 3:
            c0 = cards[0]
            check("数字与标签在同一行（34px 的条子放不下两行）",
                  abs((c0["valueTop"] + 18) - c0["labelBottom"]) < 12
                  and c0["valueTop"] < c0["labelBottom"],
                  f"valueTop={c0['valueTop']:.0f} labelBottom={c0['labelBottom']:.0f}")
            check("数字排在标签右边（不是上下两行）",
                  c0["valueLeft"] >= c0["labelRight"] - 1,
                  f"valueLeft={c0['valueLeft']:.0f} labelRight={c0['labelRight']:.0f}")
            check(f"徽章是正方形（{BATCH}×{BATCH}）",
                  abs(c0["badgeBox"]["h"] - c0["badgeBox"]["w"]) < 1
                  and abs(c0["badgeBox"]["h"] - BATCH) < 1,
                  f"{c0['badgeBox']}")

        print("\n④ 窄列档：列只有 240px 宽 ⇒ 标签省略号，但谁也不许横向溢出")
        r2 = mount(pg, url, colWidth=240)
        c2 = r2["cards"]
        check("窄列下仍是三条", len(c2) == 3, f"count={len(c2)}")
        if len(c2) == 3:
            check("条子宽度跟着缩（240px）", abs(c2[0]["w"] - 240) < 1, f"card={c2[0]['w']:.1f}")
            check("横向没有溢出（labelClipped 记录被省略的那个）",
                  all(c["scrollW"] <= c["clientW"] + 1 for c in c2),
                  str([round(c["scrollW"] - c["clientW"], 1) for c in c2]))

        print("\n⑤ 被压矮档：这条子**本来就矮**，所以常规的矮列根本压不着它")
        # 900 视口 - 660 = 剩约 240px，远大于整组的 122px ⇒ 不该出现滚动条。
        # （旧版三张 76px 下限的大卡在这里刚好会溢出 —— 这条断言就是"变小了"的收益。）
        r3 = mount(pg, url, head=660)
        cont3, c3 = r3["container"], r3["cards"]
        check("列只剩 ~240px 时也不再需要滚动（整组 122px 装得下）",
              cont3["scrollH"] <= cont3["clientH"] + 1,
              f"scrollH={cont3['scrollH']} clientH={cont3['clientH']}")
        check("三条都还在", len(c3) == 3, f"count={len(c3)}")

        print("\n⑥ 压到极限：列矮到装不下三条 ⇒ 在这一组内滚动，而不是探出列外")
        r3b = mount(pg, url, head=840)   # 900 - 840 = 只剩约 60px
        cont3b, c3b = r3b["container"], r3b["cards"]
        check("整组被压到装不下（容器真出现纵向滚动）",
              cont3b["scrollH"] > cont3b["clientH"] + 1,
              f"scrollH={cont3b['scrollH']} clientH={cont3b['clientH']}")
        check("它真的是纵向滚动容器（并且横向裁掉 ⇒ 条子出不去）",
              cont3b["overflowY"] == "auto" and cont3b["overflowX"] == "hidden",
              f"{cont3b['overflowY']}/{cont3b['overflowX']}")
        # 溢出的是**滚动内容**（getBoundingClientRect 报的是未经裁剪的位置），
        # 所以判据不是"卡底 ≤ 容器底"，而是：容器自己没出列 + 三条都滚得到。
        check("这一组自己没探出左栏（容器底 ≤ 列底）",
              cont3b["bottom"] <= r3b["col"]["bottom"] + 1,
              f"容器底{cont3b['bottom']:.0f} 列底{r3b['col']['bottom']:.0f}")
        check(f"三条都滚得到（scrollHeight = 整组的 {GROUP_H}px）",
              abs(cont3b["scrollH"] - GROUP_H) < 2, f"scrollH={cont3b['scrollH']}")

        print("\n⑦ 夜间档：条面/标签换色（浅底浅字那类事故的同族）")
        r4 = mount(pg, url, dark=True)
        c4 = r4["cards"]
        check("夜间仍是三条", len(c4) == 3, f"count={len(c4)}")
        if len(c4) == 3 and len(cards) == 3:
            check("条面底色与浅色档不同（.dark 分支真生效）",
                  c4[0]["bg"] != cards[0]["bg"], f"{c4[0]['bg']} vs {cards[0]['bg']}")
            check("条面底色不是透明的（transparent 会让浅字直接消失）",
                  c4[0]["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"), c4[0]["bg"])
            check("标签字色与浅色档不同",
                  c4[0]["labelColor"] != cards[0]["labelColor"],
                  f"{c4[0]['labelColor']} vs {cards[0]['labelColor']}")
            check("夜间三条仍等长等高",
                  max(round(c["h"], 1) for c in c4) - min(round(c["h"], 1) for c in c4) < 1
                  and max(round(c["w"], 1) for c in c4) - min(round(c["w"], 1) for c in c4) < 1,
                  str([round(c["h"], 1) for c in c4]))

        print("\n⑧ 对照：把「大卡」那套规则注入回去，判据必须变红（判据没牙 = 没测）")
        # 注入：条子交回 `flex:1 1 0` 均分整列 + 去掉燕尾。若"细条""燕尾"两条还全绿，
        # 说明上面量错了地方。
        pg.goto(url)
        pg.evaluate("(o) => window.__mount(o)", {"colWidth": 320, "head": 200, "dark": False})
        pg.wait_for_timeout(200)
        pg.add_style_tag(content=(
            ".analyticsCard{flex:1 1 auto!important;overflow:visible!important}"
            ".analyticsCard .akCard{height:auto!important;flex:1 1 0!important;"
            "clip-path:none!important}"
        ))
        pg.wait_for_timeout(200)
        legacy = pg.evaluate(MEASURE)
        lc = legacy["cards"]
        leg_h = [round(c["h"], 1) for c in lc]
        check("注入旧规则后条子不再是细条 ⇒「细条」这条判据有牙",
              max(leg_h) > 44, str(leg_h))
        leg_shot = card_shot(pg, legacy, lc[0])
        leg_depth = notch_depth(leg_shot, card_color(lc[0]))
        check("注入旧规则后燕尾没了 ⇒「燕尾」这条判据有牙",
              leg_depth <= 1, f"实测 {leg_depth}px（设计值 {NOTCH}）")

        browser.close()

    print("\n%s 后台统计条布局：%d 失败" % ("✗" if FAILS else "✓", len(FAILS)))
    for f in FAILS:
        print("   - " + f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
