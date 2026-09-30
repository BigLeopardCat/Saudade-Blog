# -*- coding: utf-8 -*-
"""后台首页左栏三张统计卡（文章 / 分类 / 标签）的布局验收。

用户 20260930 点名「文章总数分类总数，标签总数这三个卡片布局优化」。改之前那套是
**三处百分比高度串成一条链**：`.analyticsCard{height:75%}` + 每张 `.akCard{height:22%}`
+ `.akCard{width:75%}`（≤1530px 干脆钉成 `width:210px`），而同一个盒子的
`padding/height/display/flex` 又同时写在 TSX 的 `bodyStyle` 内联里——最终高度是谁定的，
读代码看不出来，列一变宽就宽窄对不齐、一变矮就把内容挤出去。

现在只有一条规则：这一列是竖向 flex，三张卡 `flex: 1 1 0` **等分**，宽度 100% 跟着列走。

为什么值得单起一个脚本而不是靠眼睛：这个组件的缺陷**全是几何的**（等不等高、越没越界、
内容有没有被裁），而它在页面里长什么样取决于列有多高多宽——只在"某一档视口"下看过一次，
换个高度就变了。所以这里量三档：常规 / 窄列 / 被压矮，外加一档 `.dark`，并且**带一个对照**
（把旧的那套百分比规则注入回去，验"判据真的会红"——判据没牙就等于没测）。

沿用 `dashboard-home.test.py` 那套装配手段（esbuild 打真组件 + 真 sass + 只桩边界）：
react / react-dom / antd 都是真的，react-redux 与 react-countup 是桩。

用法：python3 frontend/tests/dashboard-kpi-cards.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/sass）、playwright(python)。
"""
import functools
import http.server
import json
import pathlib
import shutil
import subprocess
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
SASS_FILES = ["src/components/articleAnalytics/index.sass"]

DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production",'
          '"DEV":false,"PROD":true,"BASE_URL":"/"}')

# 三个数**刻意取不同位数**（1 位 / 4 位带千分位 / 3 位）：CountUp 从 0 涨到真实值的
# 过程中数字宽度会跳，标签不能被挤出去——用同一个位数就测不出这条。
COUNTS = {"noteCount": 1024, "tagCount": 128, "categoryCount": 9}

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
    # 上面垫一个与 `.about_logo` 同高的空块 —— 三张卡拿到的就是真页面里那段剩余高度。
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

# 量一遍几何：容器、三张卡、标签/数字、以及"内容有没有被裁"的两个 scroll 读数。
MEASURE = """() => {
  const px = (v) => parseFloat(v) || 0;
  const rect = (el) => el ? el.getBoundingClientRect() : null;
  const box = (el) => el ? {h: rect(el).height, w: rect(el).width, top: rect(el).top,
                            bottom: rect(el).bottom, left: rect(el).left,
                            right: rect(el).right} : null;
  const c = document.querySelector('.analyticsCard');
  const cards = [...document.querySelectorAll('.akCard')];
  const cs = getComputedStyle(c);
  return {
    container: {...box(c), scrollH: c.scrollHeight, clientH: c.clientHeight,
                overflowY: cs.overflowY, justifyContent: cs.justifyContent},
    cards: cards.map((el) => {
      const body = el.querySelector('.ant-card-body');
      const label = el.querySelector('.akLabel');
      const val = el.querySelector('.ant-statistic-content-value');
      const badge = el.querySelector('.akBadge');
      const ecs = getComputedStyle(el);
      return {
        ...box(el),
        bg: ecs.backgroundColor,
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        bodyScrollH: body ? body.scrollHeight : 0,
        bodyClientH: body ? body.clientHeight : 0,
        label: label ? label.textContent.trim() : null,
        labelW: label ? rect(label).width : 0,
        labelTop: label ? rect(label).top : 0,
        labelBottom: label ? rect(label).bottom : 0,
        labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : null,
        labelColor: label ? getComputedStyle(label).color : null,
        value: val ? val.textContent.trim() : null,
        valueTop: val ? rect(val).top : 0,
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


def main():
    url = SANDBOX.as_uri() + "/index.html"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1600, "height": 900})

        print("\n① 常规档：三张卡等高等宽、撑满列宽、都在容器里")
        r = mount(pg, url)
        cards = r["cards"]
        check("三张卡都渲染出来了", len(cards) == 3, f"count={len(cards)}")
        if len(cards) == 3:
            hs = [round(c["h"], 1) for c in cards]
            ws = [round(c["w"], 1) for c in cards]
            check(f"三张卡等高（{hs}）", max(hs) - min(hs) < 1, f"max-min={max(hs) - min(hs):.1f}")
            check(f"三张卡等宽（{ws}）", max(ws) - min(ws) < 1, f"max-min={max(ws) - min(ws):.1f}")
            check(f"宽度跟着列走（列 320px ⇒ 卡 {ws[0]:.0f}px，不再是 75% / 固定 210px）",
                  abs(ws[0] - 320) < 1, f"card={ws[0]:.1f}")
            check("三张卡左边缘对齐", max(c["left"] for c in cards) - min(c["left"] for c in cards) < 1)
            cont = r["container"]
            check(f"整组没溢出容器（最低 {max(c['bottom'] for c in cards):.0f} ≤ 容器底 {cont['bottom']:.0f}）",
                  max(c["bottom"] for c in cards) <= cont["bottom"] + 1)
            check("容器没被撑出滚动条", cont["scrollH"] <= cont["clientH"] + 1,
                  f"scrollH={cont['scrollH']} clientH={cont['clientH']}")
            for i, c in enumerate(cards):
                check(f"第 {i + 1} 张：内容没被裁（body {c['bodyScrollH']} ≤ {c['bodyClientH']}）",
                      c["bodyScrollH"] <= c["bodyClientH"] + 1)
                check(f"第 {i + 1} 张：文字没被挤出卡片", c["scrollW"] <= c["clientW"] + 1)

        print("\n② 三行内容各自对得上（位数不同的三个数：1 位 / 4 位 / 3 位）")
        # 卡片顺序 = list 顺序 = 文章 / 分类 / 标签（与 index.tsx 里的 list 一致）
        want = [("文章总数", "1,024"), ("分类总数", "9"), ("标签总数", "128")]
        for i, (label, value) in enumerate(want):
            if i >= len(cards):
                break
            check(f"第 {i + 1} 张：标签「{label}」", cards[i]["label"] == label, cards[i]["label"])
            check(f"第 {i + 1} 张：数值 {value}（千分位由 CountUp 的 separator 给）",
                  cards[i]["value"] == value, cards[i]["value"])
        # 数字在标签下面（这一条是"布局优化"本身：徽章 + 标签 + 数字三段式）。
        # 判据用"数字顶 ≥ 标签底"（不是拿卡片高度折半去比：卡高随列高变），
        # 否则卡片一高这条就会把"同一行"读成"上下两行"。
        if len(cards) == 3:
            check("数字排在标签下方（不同行）",
                  cards[0]["valueTop"] >= cards[0]["labelBottom"] - 2,
                  f"valueTop={cards[0]['valueTop']:.0f} labelBottom={cards[0]['labelBottom']:.0f}")
            check("徽章是正方形（34×34）",
                  abs(cards[0]["badgeBox"]["h"] - cards[0]["badgeBox"]["w"]) < 1
                  and abs(cards[0]["badgeBox"]["h"] - 34) < 1,
                  f"{cards[0]['badgeBox']}")

        print("\n③ 窄列档：列只有 240px 宽 ⇒ 标签省略号，但谁也不许横向溢出")
        r2 = mount(pg, url, colWidth=240)
        c2 = r2["cards"]
        check("窄列下仍是三张卡", len(c2) == 3, f"count={len(c2)}")
        if len(c2) == 3:
            check("卡片宽度跟着缩（240px）", abs(c2[0]["w"] - 240) < 1, f"card={c2[0]['w']:.1f}")
            check("横向没有溢出（labelClipped 记录被省略的那个）",
                  all(c["scrollW"] <= c["clientW"] + 1 for c in c2),
                  str([round(c["scrollW"] - c["clientW"], 1) for c in c2]))

        print("\n④ 被压矮档：剩余高度不够三张卡的下限 ⇒ 容器内滚动，而不是把卡片挤出去/裁掉")
        r3 = mount(pg, url, head=660)   # 900 视口 - 660 = 剩下约 240px
        cont3 = r3["container"]
        c3 = r3["cards"]
        check("列被压矮到装不下三张卡的下限（3×76 + 2×12 = 252）",
              cont3["scrollH"] > cont3["clientH"] + 1,
              f"scrollH={cont3['scrollH']} clientH={cont3['clientH']}")
        check("容器真的是纵向滚动容器", cont3["overflowY"] == "auto", cont3["overflowY"])
        check("三张卡都还在（滚动可达，没被裁掉）", len(c3) == 3, f"count={len(c3)}")
        if len(c3) == 3:
            check("每张卡都不低于 min-height 76px",
                  all(round(c["h"], 1) >= 75 for c in c3), str([round(c["h"], 1) for c in c3]))

        print("\n⑤ 夜间档：卡面/标签换色（浅底浅字那类事故的同族）")
        r4 = mount(pg, url, dark=True)
        c4 = r4["cards"]
        check("夜间仍是三张卡", len(c4) == 3, f"count={len(c4)}")
        if len(c4) == 3 and len(cards) == 3:
            check("卡面底色与浅色档不同（.dark 分支真生效）",
                  c4[0]["bg"] != cards[0]["bg"], f"{c4[0]['bg']} vs {cards[0]['bg']}")
            check("卡面底色不是透明的（transparent 会让浅字直接消失）",
                  c4[0]["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"), c4[0]["bg"])
            check("标签字色与浅色档不同",
                  c4[0]["labelColor"] != cards[0]["labelColor"],
                  f"{c4[0]['labelColor']} vs {cards[0]['labelColor']}")
            check("夜间三张卡仍等高等宽",
                  max(round(c["h"], 1) for c in c4) - min(round(c["h"], 1) for c in c4) < 1
                  and max(round(c["w"], 1) for c in c4) - min(round(c["w"], 1) for c in c4) < 1,
                  str([round(c["h"], 1) for c in c4]))

        print("\n⑥ 对照：把旧的百分比规则注入回去，判据必须变红（判据没牙 = 没测）")
        # 旧那套：`.akCard{height:22%; width:75%; flex:0 0 auto}` + 容器 `height:75%`。
        # 注入后如果"等高等宽 / 撑满列宽"那几条还全绿，说明上面量错了地方。
        pg.goto(url)
        pg.evaluate("(o) => window.__mount(o)", {"colWidth": 320, "head": 200, "dark": False})
        pg.wait_for_timeout(200)
        pg.add_style_tag(content=(
            ".analyticsCard{height:75%!important;justify-content:space-evenly!important;"
            "overflow:visible!important}"
            ".analyticsCard .akCard{height:22%!important;width:75%!important;"
            "flex:0 0 auto!important;max-height:none!important}"
            ".analyticsCard .akCard:nth-child(2){height:34%!important}"
        ))
        pg.wait_for_timeout(200)
        legacy = pg.evaluate(MEASURE)
        lc = legacy["cards"]
        leg_h = [round(c["h"], 1) for c in lc]
        leg_w = [round(c["w"], 1) for c in lc]
        check("注入旧规则后三张卡不再等高 ⇒「等高」这条判据有牙",
              max(leg_h) - min(leg_h) >= 1, str(leg_h))
        check("注入旧规则后宽度不再是列宽 ⇒「宽度跟着列走」这条判据有牙",
              abs(leg_w[0] - 320) >= 1, str(leg_w))

        browser.close()

    print("\n%s 后台统计卡布局：%d 失败" % ("✗" if FAILS else "✓", len(FAILS)))
    for f in FAILS:
        print("   - " + f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
