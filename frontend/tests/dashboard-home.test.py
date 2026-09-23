# -*- coding: utf-8 -*-
"""后台首页右栏（日历 + 待办）的无头验收。

后台首页是**唯一一个没有沙箱的常驻页面**，而它恰好是最难用眼睛看出问题的那类：
右栏三段（原「每日箴言」卡 / 日历 / 待办卡）靠百分比高度 + `space-between` 撑着，
撤掉任何一段都不会报错，只是剩下的两段悄悄散开或压扁；日历往上挪还是往下挪，
也只有在几何断言里才说得清。

沿用既定装配手段（见 talk-time.test.py 头注）：sass 用 programmatic API 编译
（CLI 在 Node 18 上会因 chokidar 的 ERR_REQUIRE_ESM 崩）、esbuild 打真组件、
只桩边界（react-redux / 两个重量级兄弟组件 / 主题变量）。

两个兄弟组件（左栏统计卡、中栏文章记录）用空 div 顶替：它们各自要拉接口、开图，
而本沙箱只关心**右栏**——被断言的就是右栏自己。
注意视口必须 > 1530px：`.right` 在 1530px 以下整块 `display:none`（媒体查询）。

用法：python3 frontend/tests/dashboard-home.test.py
"""
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
HOME_SASS = "src/pages/Dashboard/Home/index.sass"

DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="dashboard-home-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    stubs = sb / "stubs"
    stubs.mkdir()

    # 边界①：react-redux。状态对象保持同一实例（每次返回新对象会让 useSelector
    # 判定"变了"而无限重渲染）。
    (stubs / "redux.tsx").write_text('''\
const state: any = {
  user: { avatar: '', name: 'Sora' },
  notes: { noteCount: 0, noteList: [], loading: false },
  tags: { tagCount: 0, tagList: [] },
  categories: { categoryList: [] },
};
export const useSelector = (fn: any) => { try { return fn(state); } catch { return undefined; } };
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({ children }: any) => children;
''', encoding="utf-8")

    # 边界②：redux thunk 工厂（首页挂载时会 dispatch 三个拉取动作）
    for name in ("note", "categories", "tags"):
        (sb / f"src/store/components/{name}.tsx").write_text(
            "export const fetch%s = () => ({ type: 'noop' });\n"
            "export default {};\n" % {"note": "NoteList", "categories": "Categories",
                                      "tags": "Tags"}[name], encoding="utf-8")

    # 边界③：两个重量级兄弟组件（左栏/中栏）——本沙箱只验右栏
    (sb / "src/components/articleAnalytics/index.tsx").write_text(
        "const ArticleAnalytics = () => <div className='stub-analytics'/>;\n"
        "export default ArticleAnalytics;\n", encoding="utf-8")
    (sb / "src/components/articleRecord/index.tsx").write_text(
        "const ArticleRecord = (_p: {isDark?: boolean}) => <div className='stub-record'/>;\n"
        "export default ArticleRecord;\n", encoding="utf-8")

    (sb / "entry.tsx").write_text('''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Home from './src/pages/Dashboard/Home/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Home />);
''', encoding="utf-8")

    # 年度条是**真**组件，它的样式就必须一起编译进来——漏掉它会得到一个和线上
    # 不一样的右栏（`.process_container` 的 15% 高度解析不出来时，那一条会撑成
    # 四行文字的高度，量出来的"日历顶"也就不是线上那个数）。
    subprocess.run(["node", "-e",
                    "const s=require('sass'),fs=require('fs');"
                    "const out=process.argv.slice(1,-1).map(p => s.compile(p,{style:'expanded'}).css).join('\\n');"
                    "fs.writeFileSync(process.argv[process.argv.length-1], out);",
                    str(FE / HOME_SASS), str(FE / "src/components/theYearPass/index.sass"),
                    str(sb / "home.css")],
                   cwd=str(FE), check=True)

    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic", f"--define:{DEFINE}",
                    "--loader:.png=dataurl", "--loader:.svg=dataurl",
                    "--loader:.css=text",
                    f"--alias:react-redux={stubs}/redux.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    # 主题变量 + 高度链：#root 必须有确定高度，`.right` 的 100% 才有参照物
    # （真站里这个高度由后台 Layout 给）。
    (sb / "theme.css").write_text(
        "html,body,#root{height:100%;margin:0}"
        ":root{--container-background-color:#fff;--font-p-color:#333;"
        "--font-title-color:#111;--pic-background-cover:#f7f7f7;--phoneBar-bg:#333;"
        "--phoneBar-font-color:#eee;}\n", encoding="utf-8")

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="theme.css">'
        '<link rel="stylesheet" href="home.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script><script>window.__mount && window.__mount();</script>'
        '</body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    br = p.chromium.launch()
    # 必须 > 1530px：`.right` 在更窄的视口下整块 display:none
    pg = br.new_page(viewport={"width": 1600, "height": 1000})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(600)   # Typed.js 打字机 + antd 日历挂载

    print("① 页面活着")
    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    check("右栏存在（视口宽度够）", pg.locator(".home .right").count() == 1)

    print("② 每日箴言卡已撤（20260924）")
    check("页面上不再有「每日箴言」", "每日箴言" not in pg.locator("body").inner_text())
    check("不再有箴言卡的 .oneSay / .custom-card-header",
          pg.locator(".oneSay, .custom-card-header").count() == 0)

    print("③ 日历与待办都在右栏里")
    check("右栏里有一个日历", pg.locator(".right .ant-picker-calendar").count() == 1)
    check("右栏里有待办卡", pg.locator(".right .cardInfo").count() == 1)
    check("待办卡标题仍是本地存的那份（默认「开发进度」）",
          pg.input_value(".right .cardInfo input") == "开发进度")

    print("④ 日历上移、待办吃掉余量（不再是 space-between 撑开）")
    geo = pg.evaluate("""() => {
      const b = (sel) => { const el = document.querySelector(sel);
        if (!el) return null; const r = el.getBoundingClientRect();
        return {t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width, h: r.height}; };
      return { cal: b('.right .ant-picker-calendar'), todo: b('.right .cardInfo'),
               year: b('.right .process_container'), right: b('.right') };
    }""")
    gap = geo["todo"]["t"] - geo["cal"]["b"]
    check("日历在待办卡上方", gap >= 0,
          f"日历底 {geo['cal']['b']:.0f} / 待办顶 {geo['todo']['t']:.0f}")
    # 旧布局（space-between）下这个缝实测近 300px：日历被顶到最上、待办被压到最下。
    check("两段之间只隔一个 gap（≤ 40px），不再是撑出来的空档", gap <= 40, f"{gap:.0f}px")
    # 注意：年度条（.process_container）眼下量出来是 **0 高度**——它的 `height: 15%`
    # 挂在一个由内容决定高度的 `.calWrap` 上，百分比解析不出参照物就退化成 auto，
    # 里面唯一的孩子又是绝对定位 ⇒ 整条被 overflow:hidden 裁没。这是**既有**形态
    # （撤箴言之前就是这样），不是本批引入的；此处只锁"日历紧接其后"。
    check("日历紧接年度条下方（中间没有空档）",
          geo["cal"]["t"] - geo["year"]["b"] <= 20,
          f"年度条底 {geo['year']['b']:.0f} / 日历顶 {geo['cal']['t']:.0f}")
    check("日历落在右栏上半段（撤掉箴言后确实上移了）",
          geo["cal"]["t"] < geo["right"]["t"] + geo["right"]["h"] / 2,
          f"日历顶 {geo['cal']['t']:.0f} / 右栏半高 "
          f"{geo['right']['t'] + geo['right']['h'] / 2:.0f}")
    check("待办卡吃掉余量（底边贴近右栏底）",
          geo["right"]["b"] - geo["todo"]["b"] <= 60,
          f"余 {geo['right']['b'] - geo['todo']['b']:.0f}px")
    check("两者都在右栏内（左右不越界）",
          geo["cal"]["l"] >= geo["right"]["l"] - 1
          and geo["todo"]["r"] <= geo["right"]["r"] + 1)
    check("日历有实际高度（不是被压成 0）", geo["cal"]["h"] > 200,
          f"{geo['cal']['h']:.0f}px")

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 条未通过：" + "；".join(FAILS))
    raise SystemExit(1)
print("全部通过")
