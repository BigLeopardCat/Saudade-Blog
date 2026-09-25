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
STUB_ROUTER = """\
export const useNavigate = () => (to: string, opts?: any) => {
  const w = window as any;
  w.__nav = (w.__nav || []).concat([{ to, opts }]);
};
export const Outlet = () => null;
export const Link = ({ children }: any) => children;
export const useLocation = () => ({ pathname: '/dashboard', hash: '#/dashboard' });
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

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.css=text", "--jsx=automatic",
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

# 侧栏里的项（`.menu-links` 下按渲染顺序）：0 主页 / 1 笔记 / 2 说说 / …；默认选中的是 0。
UNSELECTED = 2   # 说说
SELECTED = 0     # 主页（SelectCurrent 初值 1 ⇒ nav_select）


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

    # ── 六、底部「站点设置」也进高亮圈 ─────────────────────────────────────────
    print("\n【六】侧栏「站点设置」选中态（含带 hash 刷新）")
    sc = br.new_page(viewport={"width": 1280, "height": 900})
    sc_errs = []
    sc.on("pageerror", lambda e: sc_errs.append(str(e)))
    sc.add_init_script("window.__nav = []; localStorage.setItem('tokenKey', 'x.y.z');")
    sc.goto(URL + "#/dashboard/usercontrol")
    sc.wait_for_selector(".menu-links .nav-links", timeout=10000)
    sc.wait_for_timeout(400)
    check("带 #/dashboard/usercontrol 重载：站点设置拿到 nav_select",
          sc.evaluate("""() => [...document.querySelectorAll('.bottom-content .nav-links')]
              .some((el) => el.textContent.includes('站点设置') && el.classList.contains('nav_select'))"""))
    # 反面：HASH_INDEX 没这一项时会 `?? 1` 回落，把高亮错点给「主页」
    check("重载后没有回落点亮「主页」",
          sc.evaluate("() => document.querySelectorAll('.menu-links .nav_select').length") == 0)

    sc.locator(".menu-links .nav-links").first.click()   # 对照：先让高亮回到「主页」
    sc.wait_for_timeout(200)
    check("对照：点「主页」后高亮在主页上",
          sc.evaluate("() => document.querySelectorAll('.menu-links .nav_select').length") == 1)
    sc.locator(".bottom-content .nav-links").filter(has_text="站点设置").first.click()
    sc.wait_for_timeout(200)
    check("点站点设置：蓝容器跟着过来，且全场只有它一个高亮",
          sc.evaluate("""() => {
              const li = [...document.querySelectorAll('.bottom-content .nav-links')]
                  .find((el) => el.textContent.includes('站点设置'));
              return li.classList.contains('nav_select')
                  && document.querySelectorAll('.nav-links.nav_select').length === 1
                  && document.querySelectorAll('.menu-links .nav_select').length === 0;
          }"""))
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

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 后台侧栏三处修复：全部通过")
