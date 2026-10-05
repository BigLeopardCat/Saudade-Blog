# -*- coding: utf-8 -*-
"""后台侧栏三处修复（20260923）的无头验收：真组件 + 真 CSS + 真几何。

为什么值得单起一个脚本：这三处**都只有真跑一遍才看得见**——
  · 悬停配色是 CSS 层叠的结果：`Dashboard/index.css` 里 V13/V14/V16 三批 `!important`
    互相打架（其中 V14/V16 那几条 `html[data-theme='dark']` 是**死规则**，全站没有
    任何地方设过 data-theme），谁赢光读代码看不出来，得问浏览器要 computedStyle；
  · 开关被裁是盒模型的差几个像素（`.toggle-switch` 的 translateX(8%) 顶出
    `.menu-bar` 的 overflow-x:hidden）；
  · 那颗按钮是"点下去到底删没删 token"——删了就是会把管理员踢出去。

沿用 user-center.test.py 那套既定手段（本机不能 vite build，见 CLAUDE.md §2）：
esbuild 把**真组件**打成一个 bundle、只桩边界（axios / react-redux / react-router-dom），
antd 与 react-dom 用真的；CSS 用**仓库里那份真文件**（link 进去，不复制样式）。

用法：python3 frontend/tests/dashboard-sidebar.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)。
"""
import functools
import http.server
import pathlib
import shutil
import subprocess
import sys
import re
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


def rgb_mean(css_color):
    """取 `rgb()/rgba()` 的三个通道均值（忽略 alpha）——只回答"白基还是黑基"。

    比"亮度大小"更适合这个判据：antd 的半透明占位色在浅色下是 `rgba(0,0,0,.25)`、
    夜间是 `rgba(255,255,255,.25)`，**极性翻转**而不是同一个色变深变浅。
    """
    nums = [float(x) for x in re.findall(r"[\d.]+", css_color or "")][:3]
    return sum(nums) / 3 if len(nums) == 3 else -1.0


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# 边界①：假后端。侧栏这条链上真正会发请求的是 store 里那几个 thunk（fetchUserInfo 等），
# 而本脚本把 react-redux 的 useDispatch 桩成了 no-op ⇒ 它们根本不会被派发。留一个
# 不会失败的同形状对象，纯粹是"别让 import 期就把真 axios 建起来"。
FAKE_AXIOS = """\
const http: any = () => Promise.resolve({ status: 200, data: { code: 200, data: null } });
export default http;
"""

# 边界②：路由。只记 navigate 的入参；Outlet 渲染空（后台各页不在本脚本关注面内）。
#
# ⚠️ 20261006：这个桩**必须是个会响应的迷你路由**，不能再返回写死的 pathname。
# 侧栏高亮原来是「点一下才 setState」，那版桩能跑；改成**按 pathname 派生**之后，
# 写死的桩会让所有"点击后高亮"停在原地——测试会以「假绿」的形式通过（永远停在主页）。
# 于是这里维护一份真实 path + 订阅集合：navigate 与 window.__setPath 都改它并通知订阅者。
# 初值取 URL 上的 `#/...`（本套件用 `URL + "#/dashboard/albums"` 模拟深链），
# 这样"带路径打开就该亮对"也能测（老代码这里恒回落「主页」）。
STUB_ROUTER = """\
import * as React from 'react';

let path: string = (window.location.hash || '').startsWith('#/')
  ? window.location.hash.slice(1) : '/dashboard';
const subs = new Set<(p: string) => void>();
const setPath = (p: string) => {
  path = p;
  subs.forEach((fn) => fn(p));
};
// 供测试模拟"不经侧栏的那次跳转"（图库页那颗「R2 配置」按钮就是这种）。
(window as any).__setPath = setPath;

export const useNavigate = () => (to: string, opts?: any) => {
  const w = window as any;
  w.__nav = (w.__nav || []).concat([{ to, opts }]);
  if (typeof to === 'string') setPath(to);
};
export const Outlet = () => null;
export const Link = ({ children }: any) => children;
export const useLocation = () => {
  const [p, setP] = React.useState(path);
  React.useEffect(() => {
    subs.add(setP);
    setP(path);
    return () => { subs.delete(setP); };
  }, []);
  return { pathname: p, search: '', hash: '', state: null };
};
"""

# 边界③：redux。**只桩"读"**——状态对象每次返回同一个实例（返回新对象会让 useSelector
# 判定"变了"而无限重渲染）。useDispatch 返回 no-op ⇒ 页面挂载时那几个 thunk 不发请求。
STUB_REDUX = """\
const state: any = {
  categories: { categories: [] },
  tags: { tags: [] },
  note: { noteList: [] },
  user: { avatar: '', name: '管理员', blogTitle: 'Saudade' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => undefined;
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from './src/pages/Dashboard/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Dashboard />);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="dash-verify-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "stub-router.tsx").write_text(STUB_ROUTER, encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(STUB_REDUX, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # CSS 用仓库里那两份真文件（都是纯 .css，不需要 sass 那一步）
    for rel, out in (("src/pages/Dashboard/index.css", "dash.css"),
                     ("src/components/Switch/index.css", "switch.css")):
        shutil.copyfile(FE / rel, sb / out)

    # 20261001：公告卡那轮起，后台壳的依赖图里出现了 `import './index.sass'`
    # （components/AnnouncementModal）——本套件只验侧栏 DOM，不看那份样式，
    # 所以照全仓惯例收成 text 即可；缺这个 loader 是**打包直接失败**，不是样式缺失。
    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.css=text", "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}",
                        f"--alias:react-router-dom={sb}/stub-router.tsx",
                        f"--alias:react-redux={sb}/stub-redux.tsx"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        # 宽容解码：esbuild 会在中文那行按字节截断，严格 utf-8 解会先炸在解码上、
        # 把真正的报错盖掉（20260922 在 user-center.test.py 上实测）。
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="switch.css">'
        '<link rel="stylesheet" href="dash.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script>'
        '<script>window.__mount();</script>'
        '</body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静音：访问日志会落进 ~/sandbox_regression.log（那是给人看断言的地方）。
    必须子类覆写——`partial` 的实例属性不影响它转发的那个类，写成
    `_handler.log_message = lambda …` 等于没写。"""

    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

# 侧栏里的项（`.menu-links` 下按渲染顺序）：0 主页 / 1 笔记 / 2 说说 / …
# 夹具不导航 ⇒ 路径就是 /dashboard ⇒ 选中的是 0（高亮按 pathname 派生，见第六节）。
UNSELECTED = 2   # 说说
SELECTED = 0     # 主页


def probe_hover(page, idx):
    """把鼠标停在第 idx 个侧栏项上，等过渡（`transition: all .3s`）走完再读计算值。"""
    page.locator(".menu-links .nav-links").nth(idx).hover()
    page.wait_for_timeout(420)
    return page.evaluate("""(i) => {
        const li = document.querySelectorAll('.menu-links .nav-links')[i];
        const ic = li.querySelector('.icon');
        const tx = li.querySelector('.text');
        const s = getComputedStyle(ic);
        return {
            icon: s.color,
            shadow: s.textShadow,
            text: getComputedStyle(tx).color,
            selected: li.classList.contains('nav_select'),
        };
    }""", idx)


def switch_geometry(page):
    """主题开关与它所在滚动容器（`.menu-bar`，overflow-x:hidden = 裁切边界）的几何。"""
    return page.evaluate("""() => {
        const mb = document.querySelector('.menu-bar');
        const box = document.querySelector('.toggle-switch');
        const sw = document.querySelector('.toggle-switch .theme-switch__container');
        const r = (el) => { const b = el.getBoundingClientRect();
                            return { left: b.left, right: b.right, width: b.width }; };
        return { bar: r(mb), box: r(box), sw: r(sw), barScroll: mb.scrollWidth };
    }""")


with sync_playwright() as p:
    br = p.chromium.launch()

    def fresh_page(dark: bool):
        page = br.new_page(viewport={"width": 1280, "height": 900})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        init = ("window.__nav = []; window.__auth = 0;"
                "window.addEventListener('auth-change', () => { window.__auth++; });"
                "localStorage.setItem('tokenKey', 'x.y.z');")
        if dark:
            # 主题源就是 localStorage.isDarkMode（theme.ts 两种历史格式都认）
            init += "localStorage.setItem('isDarkMode', 'true');"
        page.add_init_script(init)
        page.goto(URL)
        page.wait_for_selector(".menu-bar .nav-links", timeout=10000)
        page.wait_for_timeout(400)
        page.errs = errs
        return page

    # ── 一、夜间悬停：从"变黑隐身"改成登录页那支河灯金 ──────────────────────────
    print("\n【一】夜间侧栏悬停配色")
    dk = fresh_page(dark=True)
    check("夜间模式真的生效（.shell 带上 dark 类）",
          dk.evaluate("() => !!document.querySelector('.shell.dark')"))
    got = probe_hover(dk, UNSELECTED)
    check("悬停未选中项：图标变河灯金 #e8b866",
          got["icon"] == "rgb(232, 184, 102)", got["icon"])
    check("悬停未选中项：文字同色", got["text"] == "rgb(232, 184, 102)", got["text"])
    check("带光晕（text-shadow 不再是 none）", got["shadow"] != "none", got["shadow"])
    got_sel = probe_hover(dk, SELECTED)
    check("悬停**选中项**保持黑（选中项自带浅蓝底，金压浅蓝看不清）",
          got_sel["selected"] and got_sel["icon"] == "rgb(0, 0, 0)", got_sel["icon"])
    dk.close()

    # ── 二、浅色悬停：维持原样（黑，与选中态同色）─────────────────────────────
    print("\n【二】浅色侧栏悬停配色（回归）")
    lt = fresh_page(dark=False)
    got = probe_hover(lt, UNSELECTED)
    check("浅色下悬停仍是黑", got["icon"] == "rgb(0, 0, 0)", got["icon"])
    check("浅色下没有光晕", got["shadow"] == "none", got["shadow"])
    lt.close()

    # ── 三、主题开关右侧不再被裁 ──────────────────────────────────────────────
    print("\n【三】侧栏主题开关几何")
    geo_page = fresh_page(dark=True)

    def clip_report(tag):
        g = switch_geometry(geo_page)
        over = g["sw"]["right"] - g["bar"]["right"]
        check(f"{tag}：开关右缘没越过 .menu-bar 的裁切边界（超出 {over:.1f}px）", over <= 0.5,
              f'switch.right={g["sw"]["right"]:.1f} bar.right={g["bar"]["right"]:.1f}')
        check(f"{tag}：开关真渲染出来了（宽 {g['sw']['width']:.1f}px）", g["sw"]["width"] > 40)
        return g

    clip_report("收起态（默认 88px 侧栏）")
    # 展开：点侧栏头部那枚 toggle（∨），宽度 88 → 250，`.menu-bar` 跟着变宽
    geo_page.click(".toggle")
    geo_page.wait_for_timeout(600)
    # 量 `.menu-bar` 而不是 `nav.shell`：后者是 content-box（`width:250` + 左右 padding 28
    # ⇒ 量到 278），而裁切边界就是 `.menu-bar` 的右缘 —— 直接量它最不容易写错。
    bar_w = switch_geometry(geo_page)["bar"]["width"]
    check("点 toggle 后侧栏确实展开了（.menu-bar 88 → 250）", abs(bar_w - 250) < 1, f"bar width={bar_w:.1f}")
    clip_report("展开态（250px 侧栏）")

    # 判据的**对照**：把当年那行 translateX(8%) 加回去，必须立刻测出"越界"——
    # 否则上面两条"没越界"可能只是判据本身不敏感。
    geo_page.evaluate("() => { document.querySelector('.toggle-switch').style.transform = 'translateX(8%)'; }")
    geo_page.wait_for_timeout(60)
    g = switch_geometry(geo_page)
    check("对照：把 translateX(8%) 加回去就会越界（说明判据有效）",
          g["sw"]["right"] - g["bar"]["right"] > 0.5,
          f'超出 {g["sw"]["right"] - g["bar"]["right"]:.1f}px')
    geo_page.evaluate("() => { document.querySelector('.toggle-switch').style.transform = ''; }")

    # ── 三b、第三档「极简」（20261006 用户第 3 条）───────────────────────────────
    #
    # 三档 = 0 / 88 / 250，类名互斥（`.mini` / `.close` / 无）。判据全部只有真跑一遍才看得见：
    #   · 收到 0 宽时**底色带留不留**取决于要不要连 padding 一起收（`.shell` 是 content-box）；
    #   · 两颗圆钮是 `position:absolute; right:-25px`，只要有人顺手给 `.shell` 加一句
    #     `overflow:hidden`，它们会当场消失 —— 而"钮不见了"光看代码是想不到的。
    # 此刻 geo_page 停在**展开态（250）**（上一节刚点过 `.toggle`）。
    print("\n【三b】侧栏第三档（极简）")
    ROT = """() => {
        const rot = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return 'missing';
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return 'hidden';
            const m = new DOMMatrix(cs.transform);
            return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI);
        };
        const shell = document.querySelector('div.shell');
        const bar = document.querySelector('.menu-bar');
        const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, width: b.width }; };
        return { tier: shell.className, toggle: rot('.toggle'), collapse: rot('.toggle-collapse'),
                 shellW: r(shell).width, barW: r(bar).width,
                 shellLeft: r(shell).left, toggleBox: r(document.querySelector('.toggle')),
                 collapseBox: document.querySelector('.toggle-collapse')
                     ? r(document.querySelector('.toggle-collapse')) : null };
    }"""
    g = geo_page.evaluate(ROT)
    check("展开档（250）：那颗钮朝左（rotate 180 = 往下一档）",
          g["toggle"] == 180 or g["toggle"] == -180, str(g["toggle"]))
    check("展开档（250）：没有第二颗钮（左向钮只在收起档出现）",
          g["collapse"] == "hidden", str(g["collapse"]))

    geo_page.click(".toggle")                       # 250 → 88
    geo_page.wait_for_timeout(600)
    g = geo_page.evaluate(ROT)
    check("收起档（88）：两颗钮都在（▶ 展开 / ◀ 再收一档）",
          g["toggle"] == 0 and g["collapse"] == 180, f'toggle={g["toggle"]} collapse={g["collapse"]}')
    check("收起档（88）：两颗钮不重叠（下面的那颗在下面）",
          g["collapseBox"]["left"] == g["toggleBox"]["left"]
          and g["collapseBox"]["width"] == g["toggleBox"]["width"],
          str(g["toggleBox"]) + " / " + str(g["collapseBox"]))

    geo_page.click(".toggle-collapse")              # 88 → 0
    geo_page.wait_for_timeout(600)
    g = geo_page.evaluate(ROT)
    check("极简档：shell 带上 mini 类", "mini" in g["tier"], g["tier"])
    check(f"极简档：宽度真的收到 0（实测 {g['shellW']:.1f}px，含 padding）",
          g["shellW"] <= 0.5, f'shellW={g["shellW"]:.1f}')
    check(f"极简档：内容区没有残留的底色带（.menu-bar 宽 {g['barW']:.1f}px）",
          g["barW"] <= 0.5, f'barW={g["barW"]:.1f}')
    check("极简档：只剩那一颗钮（第二颗收起来了）", g["collapse"] == "hidden", str(g["collapse"]))
    check("极简档：那颗钮朝右（▶ = 往上一档）", g["toggle"] == 0, str(g["toggle"]))
    check("极简档：钮**没被裁掉**（`.shell` 不能有 overflow:hidden）",
          g["toggleBox"]["width"] > 20 and g["shellLeft"] <= 0, str(g["toggleBox"]))

    geo_page.click(".toggle")                       # 0 → 88
    geo_page.wait_for_timeout(600)
    g = geo_page.evaluate(ROT)
    check("从极简档点那颗钮：回到收起档（88）而不是展开档",
          "close" in g["tier"] and abs(g["barW"] - 88) < 1, f'{g["tier"]} barW={g["barW"]:.1f}')

    # ── 四、那颗按钮：返回外部首页，不再退出登录 ────────────────────────────────
    print("\n【四】侧栏「返回首页」按钮（原「退出登录」）")
    btn = geo_page.locator(".bottom-content .nav-links").filter(has_text="返回首页")
    check("侧栏里有一颗「返回首页」", btn.count() == 1, f"count={btn.count()}")
    check("侧栏里不再有「退出登录」",
          geo_page.locator(".bottom-content").get_by_text("退出登录").count() == 0)
    before = geo_page.evaluate("() => localStorage.getItem('tokenKey')")
    btn.first.click()
    geo_page.wait_for_timeout(200)
    navs = geo_page.evaluate("() => window.__nav.map((n) => n.to)")
    check("点它导航到外部首页 /", navs == ["/"], str(navs))
    check("点它**不**退出登录（tokenKey 还在）",
          geo_page.evaluate("() => localStorage.getItem('tokenKey')") == before)
    check("点它不派发 auth-change（头部不会切成未登录态）",
          geo_page.evaluate("() => window.__auth") == 0)
    check("全程无页面异常", not geo_page.errs, "; ".join(geo_page.errs[:3]))
    geo_page.close()

    # ── 五、两枚填充型 SVG 图标（公告 / 用户管理）──────────────────────────────
    # 换图标这件事的坑全在"看不到的那一半"：path 上留着原设计稿的 `fill="#77808F"` 时，
    # 平时看着一切正常，只有夜间悬停**染色只变一半**——所以判据必须是 computedStyle 的
    # svg.fill（继承自 .icon 的 color），外加"path 上没有写死 fill"。
    print("\n【五】公告与用户管理的填充型 SVG")
    svg_dk = fresh_page(dark=True)

    def probe_svg(page, idx):
        page.locator(".menu-links .nav-links").nth(idx).hover()
        page.wait_for_timeout(420)
        return page.evaluate("""(i) => {
            const li = document.querySelectorAll('.menu-links .nav-links')[i];
            const svg = li.querySelector('svg');
            const paths = li.querySelectorAll('svg path');
            const s = svg ? getComputedStyle(svg) : null;
            const b = svg ? svg.getBoundingClientRect() : null;
            return {
                has: !!svg,
                cls: svg ? svg.getAttribute('class') : '',
                fill: s ? s.fill : '',
                stroke: s ? s.stroke : '',
                paths: paths.length,
                pathFills: Array.from(paths).map((p) => p.getAttribute('fill')),
                fontIcon: !!li.querySelector('.icon .iconfont, .icon .fa'),
                w: b ? b.width : 0, h: b ? b.height : 0,
            };
        }""", idx)

    for idx, label in ((4, '公告（喇叭）'), (5, '用户管理（人+列表）')):
        g = probe_svg(svg_dk, idx)
        check(f"{label}：是内联 SVG（不再是字体图标）", g["has"] and not g["fontIcon"], str(g))
        check(f"{label}：由 .nav-svg 定尺寸、没撑成 300px",
              g["cls"] == "nav-svg" and 15 < g["w"] <= 22.5, f'{g["w"]:.1f}×{g["h"]:.1f}')
        check(f"{label}：填充型（stroke 为 none，不是线框）", g["stroke"] == "none", g["stroke"])
        check(f"{label}：夜间悬停填色 = 河灯金", g["fill"] == "rgb(232, 184, 102)", g["fill"])
        check(f"{label}：path 上没写死 fill（否则 currentColor 只染一半）",
              all(f is None for f in g["pathFills"]), str(g["pathFills"]))
    svg_dk.close()

    # ── 六、高亮**按路径派生**（点一下才亮那套是死的）────────────────────────────
    #
    # 20261006 改。老实现的病根：路由早就是 `createBrowserRouter`（真实 path），全仓没有
    # 任何地方写 hash，而侧栏高亮读的是 `location.hash` ⇒ 那份 HASH_INDEX **在线上恒不
    # 命中**，任何一次刷新/程序化跳转都回落成「主页」。
    # ⚠️ 本节里**真正区分新旧实现的只有第 ① 条**（下面那条 `__setPath`）：本夹具的桩是
    # 从 URL 上的 `#/...` 播种 path 的，而老实现恰好也认得那个 hash ⇒ 第 ② 条在老代码上
    # 也能过，它是「路径没变时不回归」的锁，不是对照。②③ 的价值在于：改成按 pathname 派生
    # 之后，"点一下才亮"这条老路被彻底删掉了，得有人钉住它别又退回去。
    print("\n【六】侧栏高亮跟随路径（含不经侧栏的跳转）")
    HIGH = """() => ({
        menu: [...document.querySelectorAll('.menu-links .nav-links.nav_select')]
                .map((el) => el.textContent.trim()),
        bottom: [...document.querySelectorAll('.bottom-content .nav-links.nav_select')]
                .map((el) => el.textContent.trim()),
        total: document.querySelectorAll('.nav-links.nav_select').length,
    })"""
    sc = br.new_page(viewport={"width": 1280, "height": 900})
    sc_errs = []
    sc.on("pageerror", lambda e: sc_errs.append(str(e)))
    sc.add_init_script("window.__nav = []; localStorage.setItem('tokenKey', 'x.y.z');")
    # ② 深链：带路径打开就该亮对
    sc.goto(URL + "#/dashboard/albums")
    sc.wait_for_selector(".menu-links .nav-links", timeout=10000)
    sc.wait_for_timeout(400)
    got = sc.evaluate(HIGH)
    check("带 #/dashboard/albums 打开：高亮落在「图库」", got["menu"] == ["图库"], str(got))
    check("反面：没有回落点亮「主页」（老实现脱掉 hash 后就是这个症状）", "主页" not in got["menu"], str(got))

    # ③ 旧用例（原来在新夹具下会假绿——它只是永远停在主页）：点一下就跟着走
    sc.locator(".menu-links .nav-links").first.click()
    sc.wait_for_timeout(200)
    check("点「主页」后唯一高亮就是主页",
          sc.evaluate(HIGH)["menu"] == ["主页"], str(sc.evaluate(HIGH)))

    # ① 不经侧栏的跳转：图库页那颗「R2 配置」`navigate('/dashboard/usercontrol')`，
    #    点完高亮原来仍停在图库图标上（用户报的那条）。**本节的对照就是它**：
    #    老实现（点一下才 setState）走这条路径时高亮不会动 ⇒ 这条必然红。
    sc.evaluate("() => window.__setPath('/dashboard/usercontrol')")
    sc.wait_for_timeout(200)
    got = sc.evaluate(HIGH)
    check("从图库跳设置：蓝容器跟着过来，且全场只有它一个高亮",
          got["bottom"] == ["站点设置"] and got["menu"] == [] and got["total"] == 1, str(got))

    # ③ 旧用例：点站点设置本身
    sc.locator(".bottom-content .nav-links").filter(has_text="站点设置").first.click()
    sc.wait_for_timeout(200)
    got = sc.evaluate(HIGH)
    check("点站点设置：仍在它身上，且只有它一个",
          got["bottom"] == ["站点设置"] and got["menu"] == [] and got["total"] == 1, str(got))
    # 只认最后一条：上面那记对照点击已经往 __nav 里放过一条 /dashboard（探针自己的足迹）
    check("点站点设置：导航到 /dashboard/usercontrol",
          sc.evaluate("() => window.__nav[window.__nav.length - 1].to") == "/dashboard/usercontrol",
          str(sc.evaluate("() => window.__nav.map((n) => n.to)")))
    check("第六节全程无页面异常", not sc_errs, "; ".join(sc_errs[:3]))
    sc.close()

    # ── 七、后台夜间最小闭环：壳上那层 ConfigProvider(darkAlgorithm) 真的落地了 ─────
    #
    # 锁的是 20260923 那条根因：`/dashboard` 与 `/` 是**兄弟顶层路由**，命中后台时 <App/>
    # 不在树上 ⇒ App.tsx 的 frontDark 永远落不到后台，而 isDarkMode 只长在这个壳里。
    # 不在壳上挂 ConfigProvider，antd 就恒为 defaultAlgorithm —— 面板、表格、日历全是浅色，
    # 用户看到的就是"后台夜间一点不夜间"。判据只能问浏览器要 computedStyle：这个文件之外
    # 还有一批 `html[data-theme='dark']` 死规则和几条互相打架的 !important，读代码看不出谁赢。
    print("\n【七】后台夜间：antd 组件在深色壳里真的变深")
    PROBE_ANTD = ("() => { const el = document.querySelector('.image .ant-avatar');"
                  " if (!el) return null; const cs = getComputedStyle(el);"
                  " return {bg: cs.backgroundColor, color: cs.color}; }")
    lt = fresh_page(dark=False)
    lt_av = lt.evaluate(PROBE_ANTD)
    lt.close()
    dk7 = fresh_page(dark=True)
    dk_av = dk7.evaluate(PROBE_ANTD)
    check("壳内的 antd 组件（头像）两种主题下底色不同 —— 说明 token 真被换过",
          bool(lt_av) and bool(dk_av) and lt_av["bg"] != dk_av["bg"],
          f'浅 {lt_av and lt_av["bg"]} / 深 {dk_av and dk_av["bg"]}')
    check("极性真翻转了：浅色是黑基、夜间是白基（darkAlgorithm 生效，没被写死的浅色压住）",
          bool(lt_av) and bool(dk_av)
          and rgb_mean(lt_av["bg"]) < 32 and rgb_mean(dk_av["bg"]) > 223,
          f'通道均值 {rgb_mean(lt_av["bg"]) if lt_av else "-":.0f} → '
          f'{rgb_mean(dk_av["bg"]) if dk_av else "-":.0f}')
    check("夜间：壳与外层容器都带 dark 类（.dark 才是被 CSS 认的那一支）",
          dk7.evaluate("() => !!document.querySelector('.contain.dark')"
                       " && !!document.querySelector('nav.shell.dark')"))
    check("第七节全程无页面异常", not dk7.errs, "; ".join(dk7.errs[:3]))
    dk7.close()

    # ── 八、两枚 SVG 的**墨迹尺寸**与相邻字体图标对齐 ──────────────────────────────
    #
    # 为什么单起一节：`.nav-svg` 定的是**画布** 22×22，不是**画出来的那一块**。path 在
    # 自己 viewBox 里画多大，光读代码看不出来 —— 旧稿的用户管理图标 viewBox 是
    # `0 0 1097 1024`（横着多出 73 个单位），默认 preserveAspectRatio 居中后**纵向只有
    # 20.5px**；换成 1024² 的新稿后纵横都吃满 22px。用户这次点名"大小要和侧边栏其他
    # 图标保持一致"，而这一条只有量 getBBox 才知道有没有做到。
    #
    # 参照系是**同一侧栏里那七枚字体图标**在同一字号下的墨迹高度（本机实测，20261001）：
    #   主页 20 / 笔记 22 / 说说 25 / 图库 23 / 数据板 20 / 站点设置 20 / 返回首页 22
    # 即 20~25、主体落在 20~22。判据取这个带 —— 本脚本**不链 iconfont 的 CDN**
    # （离线也要能跑），所以只能把实测值钉在这里当下界/上界，而不是当场量。
    print("\n【八】两枚 SVG 的墨迹尺寸与相邻字体图标对齐")
    ink_page = fresh_page(dark=False)
    ink = ink_page.evaluate("""() => {
        return [4, 5].map((i) => {
            const li = document.querySelectorAll('.menu-links .nav-links')[i];
            const svg = li.querySelector('svg');
            const vb = svg.getAttribute('viewBox').split(/\\s+/).map(Number);
            const b = svg.querySelector('path').getBBox();
            const s = 22 / Math.max(vb[2], vb[3]);
            return { name: li.textContent.trim(), w: b.width * s, h: b.height * s };
        });
    }""")
    for g in ink:
        check(f'{g["name"]}：墨迹落在字体图标那条带里（19.5~23.5px，实测 {g["h"]:.2f}）',
              19.5 <= g["h"] <= 23.5, f'{g["w"]:.2f}×{g["h"]:.2f}')
    check("两枚之间也差不多大（高度差 ≤ 2.5px）",
          abs(ink[0]["h"] - ink[1]["h"]) <= 2.5,
          f'{ink[0]["h"]:.2f} vs {ink[1]["h"]:.2f}')
    # 对照：把旧稿那个 1097 宽的 viewBox 假回去，必须当场测出"偏小"——否则上面那条
    # "落在带里"可能只是判据本身不敏感（旧稿实测 20.5，落在带内，所以要挑更窄的带验证）。
    stale = ink_page.evaluate("""() => {
        const li = document.querySelectorAll('.menu-links .nav-links')[5];
        const svg = li.querySelector('svg');
        const b = svg.querySelector('path').getBBox();
        // 复现旧稿：同一个 path，viewBox 横着撑到 1097
        const s = 22 / 1097;
        return { h: b.height * s, w: b.width * s };
    }""")
    check("对照：viewBox 横撑到 1097（旧稿形态）会量出偏小 ⇒ 判据对尺寸敏感",
          stale["h"] < ink[1]["h"] - 0.5, f'旧稿 {stale["h"]:.2f} vs 新稿 {ink[1]["h"]:.2f}')
    check("第八节全程无页面异常", not ink_page.errs, "; ".join(ink_page.errs[:3]))
    ink_page.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 后台侧栏三处修复：全部通过")
