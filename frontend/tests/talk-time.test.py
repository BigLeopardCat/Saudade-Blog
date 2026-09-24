# -*- coding: utf-8 -*-
"""说说页（/talk）时间显示的无头验收（20260924）。

锁两件事（用户本轮的两条要求）：
  ① 日期链条上带**年份**——原来是只有 `MM.DD` 的单行，跨年的说说在列表里长得一模一样；
  ② 卡片**左下角**带精确 `HH:mm:ss`。

为什么值得单独一个沙箱：这两处都是"看着像对了、其实拿的是错值"的地方——
年份若是从 `new Date()` 取（而不是从每条数据的 createTime），页面看起来完全正常，
只有跨年那条会错。所以样本里刻意放一条**去年**的说说。

本机不能 vite build（3.7GB 内存会 OOM，见 CLAUDE.md §2），沿用既定替代手段：
  · sass 用 programmatic API 编译（`node_modules/.bin/sass` 在 Node 18 上会因 chokidar
    的 ERR_REQUIRE_ESM 直接崩，别用 CLI）；
  · esbuild 把**真组件**打成一个 bundle，只桩边界（axios / react-redux / SEO 组件），
    **不桩 antd**——卡片几何要靠真 antd 的卡片内边距；
  · 真 react-dom 渲染 → Playwright 断言。

用法（仓库任意位置）：python3 frontend/tests/talk-time.test.py
依赖：frontend/node_modules（esbuild + react + react-dom）、playwright（python）。
"""
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]          # 仓库根
FE = ROOT / "frontend"
TALK_SASS = "src/frontHome/Content/Talk/index.sass"

# `import.meta.env` 的替身（与其余沙箱同一个串）：esbuild 的 iife 输出里 `import.meta`
# 是空对象，组件链上任何 `import.meta.env.X` 都会当场抛 TypeError 白屏。
DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# 样本：第 2 条刻意是**去年**的（跨年）。若年份取的是"当前年"，这条会当场露馅。
TALKS = [
    {"talkKey": 1, "talkTitle": "今天的说说", "content": "第一条正文",
     "createTime": "2026-09-24 12:34:56", "updateTime": "2026-09-24 12:34:56"},
    {"talkKey": 2, "talkTitle": "去年的说说", "content": "第二条正文",
     "createTime": "2025-12-31 23:59:59", "updateTime": "2025-12-31 23:59:59"},
]


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="talk-time-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    stubs = sb / "stubs"
    stubs.mkdir()

    # 边界①：假后端。只回说说列表，形状 = 真接口的 ApiResponse。
    (sb / "src/apis/axios.tsx").write_text(
        "const http: any = () => Promise.resolve({ status: 200, data: { code: 200, data: %s } });\n"
        "export default http;\n" % __import__("json").dumps(TALKS, ensure_ascii=False),
        encoding="utf-8")

    # 边界②：redux——只桩"读"。状态对象保持同一个实例（每次返回新对象会让 useSelector
    # 判定"变了"而无限重渲染）。
    (stubs / "redux.tsx").write_text('''\
const state: any = { user: { avatar: '', name: 'Sora' } };
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({ children }: any) => children;
''', encoding="utf-8")

    (sb / "src/components/SeoHelmet.tsx").write_text(
        "const SeoHelmet = (_p: any) => null;\nexport default SeoHelmet;\n", encoding="utf-8")

    (sb / "entry.tsx").write_text('''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import TalkList from './src/frontHome/Content/Talk/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<TalkList />);
''', encoding="utf-8")

    # ② sass 真编译（programmatic API）
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / TALK_SASS), str(sb / "talk.css")],
                   cwd=str(FE), check=True)

    # ③ esbuild 打包（.sass 的裸 import 被 text loader 吞掉，样式由页面单独引入）
    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic", f"--define:{DEFINE}",
                    "--loader:.png=dataurl", "--loader:.svg=dataurl",
                    f"--alias:react-redux={stubs}/redux.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    # 主题变量：真页面由全局样式给（浅色/夜间两套）。沙箱里给浅色那一套——
    # 不就是 `var(--font-p-color)` 解析不出来、颜色断言无从谈起。
    (sb / "theme.css").write_text(
        ":root{--container-background-color:#fff;--font-p-color:#333;"
        "--font-title-color:#111;--pic-background-cover:#f7f7f7;}\n", encoding="utf-8")

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="theme.css">'
        '<link rel="stylesheet" href="talk.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script><script>window.__mount && window.__mount();</script>'
        '</body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    # framer-motion 入场：第 n 条 delay = n*0.2s + 0.5s 动画。几何要在动画**结束**后量
    # （初始 y:-20 会把卡片和日期先挪上去 20px）。
    pg.wait_for_timeout(1800)

    print("① 结构")
    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    check("两条说说都渲染", pg.locator(".talk").count() == 2,
          str(pg.locator(".talk").count()))
    check("日期链条上每条都有年份与月日两个元素",
          pg.locator(".talkTime .talkTime-year").count() == 2
          and pg.locator(".talkTime .talkTime-day").count() == 2)

    print("② 年份与月日（跨年那条证明年份取自数据，不是当前年）")
    years = pg.eval_on_selector_all(".talkTime-year", "els => els.map(e => e.textContent.trim())")
    days = pg.eval_on_selector_all(".talkTime-day", "els => els.map(e => e.textContent.trim())")
    check("第一条 = 2026 / 09.24", years[0] == "2026" and days[0] == "09.24", f"{years[0]} {days[0]}")
    check("跨年那条 = 2025 / 12.31（不是当前年）", years[1] == "2025" and days[1] == "12.31",
          f"{years[1]} {days[1]}")
    check("年份在月日**前面**、同一行（20260924 三轮：原来是年份一行压在月日上面）",
          pg.evaluate("""() => {
            const t = document.querySelector('.talkTime');
            const y = t.querySelector('.talkTime-year').getBoundingClientRect();
            const d = t.querySelector('.talkTime-day').getBoundingClientRect();
            // 前面 = 年份右缘在月日左缘之前；同一行 = 两者的竖直区间有重叠
            return y.right <= d.left + 1 && y.top < d.bottom && d.top < y.bottom;
          }"""))

    print("③ 卡片左下角的精确时刻")
    clocks = pg.eval_on_selector_all(".talk-clock", "els => els.map(e => e.textContent.trim())")
    check("两个时刻都在（H:M:S 各两位）", clocks == ["12:34:56", "23:59:59"], str(clocks))
    check("等宽数字（tabular-nums：列表里各条时刻上下对齐）",
          "tabular-nums" in pg.evaluate(
              "() => getComputedStyle(document.querySelector('.talk-clock')).fontVariantNumeric"))
    check("时刻不透明（浅色主题下是实色字，不是继承来的空心）",
          pg.evaluate(
              "() => { const c = getComputedStyle(document.querySelector('.talk-clock')).color;"
              " const m = c.match(/[\\d.]+/g); return m.length < 4 || +m[3] > 0.9; }"))

    print("④ 几何（日期在卡片左侧、时刻在卡片右下角）")
    geo = pg.evaluate("""() => {
      const r = (el) => { const b = el.getBoundingClientRect();
        return {l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width}; };
      const rows = [...document.querySelectorAll('.article')].map(a => {
        const time = r(a.querySelector('.talkTime'));
        const year = r(a.querySelector('.talkTime-year'));
        const day  = r(a.querySelector('.talkTime-day'));
        const card = r(a.querySelector('.talk'));
        const body = r(a.querySelector('.ant-card-body'));
        const meta = r(a.querySelector('.ant-card-meta'));
        const clock = r(a.querySelector('.talk-clock'));
        const foot = a.querySelector('.talk-foot');
        const fs = getComputedStyle(foot);
        // 竖线上的圆点 = `.talk:after`（伪元素，只能用 computed style 反推几何）
        const csDot = getComputedStyle(a.querySelector('.talk'), ':after');
        const dotL = card.l + parseFloat(csDot.left);
        const dotR = dotL + parseFloat(csDot.width);
        return {time, year, day, card, body, meta, clock, dotL, dotR,
                footBorders: [fs.borderTopWidth, fs.borderTopStyle]};
      });
      return rows;
    }""")
    g0, g1 = geo[0], geo[1]
    check("日期块整体在卡片左侧（right ≤ 卡片 left）",
          g0["time"]["r"] <= g0["card"]["l"] + 1,
          f"日期右缘 {g0['time']['r']:.0f} / 卡片左缘 {g0['card']['l']:.0f}")
    check("日期块与卡片之间留了缝（≥ 20px），不是贴着",
          g0["card"]["l"] - g0["time"]["r"] >= 20,
          f"{g0['card']['l'] - g0['time']['r']:.0f}px")
    # 一轮修完当时的实测缺陷：日期块原来钉左缘（left:-120px），内容变宽后向右长、
    # 月日压到了竖线和圆点上（右缘 423 vs 竖线 391）。改成钉右缘后必须留在这条线**左边**。
    check("日期块没压到竖线与圆点上（右缘 ≤ 圆点左缘）",
          g0["time"]["r"] <= g0["dotL"] + 1,
          f"日期右缘 {g0['time']['r']:.0f} / 圆点左缘 {g0['dotL']:.0f}")
    # 竖直对齐是**已知旧偏差**（日期块比圆点低 ~8px：它的包含块是 .article 而不是卡片，
    # `top:50%` 落在卡片中线上方，h3 自带的 1em 默认外边距又压回来一部分）。本轮不动它，
    # 但要锁住"没变得更糟"：偏差仍在 12px 以内、且是往下偏（不是翻到上面去）。
    check("日期块与圆点的竖直偏差沿用旧值（≤12px、偏下，本轮未改动这一项）",
          0 <= (g0["time"]["t"] + g0["time"]["b"]) / 2
          - (g0["card"]["t"] + g0["card"]["b"]) / 2 <= 12,
          f"日期中心 {(g0['time']['t'] + g0['time']['b']) / 2:.0f} / "
          f"卡片中线 {(g0['card']['t'] + g0['card']['b']) / 2:.0f}")
    check("年份字号比月日小（12 < 20）",
          g0["year"]["b"] - g0["year"]["t"] < g0["day"]["b"] - g0["day"]["t"],
          f"{g0['year']['b'] - g0['year']['t']:.0f} vs {g0['day']['b'] - g0['day']['t']:.0f}")
    check("时刻在卡片内、且在正文（Meta）下方",
          g0["clock"]["t"] >= g0["meta"]["b"] - 1
          and g0["clock"]["l"] >= g0["card"]["l"]
          and g0["clock"]["r"] <= g0["card"]["r"],
          f"时刻顶 {g0['clock']['t']:.0f} / 正文底 {g0['meta']['b']:.0f}")
    # 20260924 三轮：时刻从左下角挪到右下角，它上面那条虚线也撤了
    check("时刻靠右（距卡片右缘 < 半宽，即右下角而非居中/左下）",
          0 <= g0["card"]["r"] - g0["clock"]["r"] < g0["card"]["w"] / 2,
          f"距右缘 {g0['card']['r'] - g0['clock']['r']:.0f}px / 半宽 {g0['card']['w'] / 2:.0f}px")
    check("时刻贴着卡片的右下角（右缘与卡片内边距对齐，不是浮在中间）",
          abs((g0["body"]["r"] - g0["clock"]["r"]) - (g0["body"]["r"] - g0["meta"]["r"])) <= 1,
          f"时刻右缘 {g0['clock']['r']:.0f} / 正文右缘 {g0['meta']['r']:.0f}")
    check("那条虚线分割线撤了（不再占高度、也不再横贯整张卡）",
          g0["footBorders"][1] == "none" and g0["footBorders"][0] == "0px",
          str(g0["footBorders"]))
    check("两条说说的日期块水平位置一致（链条是直的）",
          abs(g0["time"]["r"] - g1["time"]["r"]) <= 1,
          f"{g0['time']['r']:.0f} vs {g1['time']['r']:.0f}")

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 条未通过：" + "；".join(FAILS))
    raise SystemExit(1)
print("全部通过")
