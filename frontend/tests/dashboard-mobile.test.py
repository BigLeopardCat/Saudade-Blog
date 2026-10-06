# -*- coding: utf-8 -*-
"""后台窄屏（≤1024px）适配的验收：真组件 + 真 CSS + 390×844 真几何（20261006 用户第 6 条）。

用户原话：
  "dashboard页面移动端适配简直是灾难，左侧边栏完全收起却没有腾出空间，每个选项菜单展开后，
   具体页面直接被屏幕截断，文章页面移动端尤为严重，其他各项也没好到哪去"

这三句话对应三组判据，**每一组都只有真跑一遍才看得见**：
  · "收起却不腾空间"是盒模型的差几十像素——`.Card` 原先挂着一对内联的 `width:90%` /
    `marginLeft:80px`，而侧栏是 `position:fixed` 的浮动层（从设计上就不占布局）⇒
    390px 视口下卡片外框 351+80 再被父级居中，两侧一起溢出。读代码看不出，得问浏览器要 rect。
  · "被屏幕截断"是高度链：`.Card{height:95%; overflow:hidden}` + `.content` 的 flex 居中
    ⇒ 内容高于视口时**上下同时溢出**，顶上那半截在文档流之外、滚动条也够不着
    （本仓 "flex 居中撑破视口" 那一族的老坑）。量 scrollHeight / scrollY 才判得出来。
  · "抽屉把侧栏整块搬走了"牵涉一条规范边角：**`transform` 使外层成为内层
    `position:fixed` 的包含块** ⇒ 内层那颗 fixed 的 `nav.shell-nav` 必须跟着一起位移。
    这条静态读不出来，必须量 nav 的 rect —— 只量外层 `.shell.slider` 的话，
    "nav 留在原地继续盖住内容"这个坏法会**假绿**。

沿用 dashboard-sidebar.test.py 那套既定手段（本机不能 vite build，见 CLAUDE.md §2）：
esbuild 把**真组件**打成一个 bundle、只桩边界（axios / react-router-dom / react-redux），
antd 与 react-dom 用真的。CSS 必须**显式 link 仓库里那份真文件**：`import './index.css'`
在 esbuild 里被 `--loader:.css=text` 吞成字符串，不生效。

用法：python3 frontend/tests/dashboard-mobile.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)。
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

FAILS = []

# 断点与视口：与 `Dashboard/index.css` 末尾那条媒体查询、`index.tsx` 的 matchMedia、
# 以及 antd 的 `screenLG` **三处同源**（改一处必须三处同改）。
BREAKPOINT = 1024
VW, VH = 390, 844

# 状态栏那三档的类名由 tier 决定，本套件只关心 `.shell.slider` 这一层外壳。


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

FAKE_AXIOS = """\
const http: any = () => Promise.resolve({ status: 200, data: { code: 200, data: null } });
export default http;
"""

# 路由桩。两处与本套件有关的改动（都在下面的注释里说了为什么）：
#   ① `Outlet` 渲染一个 **3000px 高**的假页面 —— "整页滚动"这条判据要求文档真的比视口高，
#      原套件的 `Outlet = () => null` 会让 scrollHeight 恒等于视口高、判据永远红；
#   ② 保留可写 pathname 的迷你路由（照抄 dashboard-sidebar.test.py，那边已解释过为什么
#      不能再写死 pathname）。
STUB_ROUTER = """\
import * as React from 'react';

let path: string = (window.location.hash || '').startsWith('#/')
  ? window.location.hash.slice(1) : '/dashboard';
const subs = new Set<(p: string) => void>();
const setPath = (p: string) => { path = p; subs.forEach((fn) => fn(p)); };
(window as any).__setPath = setPath;

export const useNavigate = () => (to: string, opts?: any) => {
  const w = window as any;
  w.__nav = (w.__nav || []).concat([{ to, opts }]);
  if (typeof to === 'string') setPath(to);
};
// 假子页面：足够高，才能验"内容比视口高时整页滚得动"。
export const Outlet = () => (
  <div id="fake-page" style={{ height: 3000 }}>窄屏假子页面</div>
);
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
    sb = pathlib.Path(tempfile.mkdtemp(prefix="dash-mobile-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "stub-router.tsx").write_text(STUB_ROUTER, encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(STUB_REDUX, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # 四份真 CSS。
    #   dash.css    后台壳本体，判据全在它身上；
    #   tokens.css  `--washi-*` 令牌住在这儿（main.tsx 的 `import './index.css'`）；
    #   switch.css  侧栏里的主题开关，缺了它那颗开关没尺寸、侧栏高度与线上不一样；
    #   reset.css   **全站 reset**（`* { margin:0; padding:0; box-sizing:border-box }`，
    #               住在 frontHome/main.css 里，由 App.tsx 副作用 import）。
    #   ⚠️ reset 那一份**不能省**：`/dashboard` 虽然不是 App 的子路由，但 App.tsx 是被
    #   router/index.tsx **静态 import** 的 ⇒ 它的样式副作用在进后台时照样执行。
    #   少了它，body 会留着浏览器默认的 8px 外边距、且所有元素退回 content-box ——
    #   本套件第一次跑就是这么翻的车：`.Card` 左缘量到 20（12+8）、宽 350（少两个 8px），
    #   内层 `nav` 还比外层壳宽出 28px。**那是沙箱缺文件，不是代码坏**，
    #   但这种"环境失真"会一路伪装成真缺陷，所以按本仓惯例：样式一律用仓库那份真文件。
    for rel, out in (("src/pages/Dashboard/index.css", "dash.css"),
                     ("src/index.css", "tokens.css"),
                     ("src/components/Switch/index.css", "switch.css"),
                     ("src/frontHome/main.css", "reset.css")):
        shutil.copyfile(FE / rel, sb / out)

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

    # link 的顺序就是层叠顺序：reset 与 tokens 在前（前者全是 `*` 通配，特异度最低；
    # 后者只有声明、没有能压人的规则），后台那份在最后 —— 与线上"组件样式后于全局样式"
    # 的相对次序一致。
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="reset.css">'
        '<link rel="stylesheet" href="tokens.css">'
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

GEO = """() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, width: b.width, height: b.height }; };
    const card = document.querySelector('.Card');
    const bk = document.querySelector('.nav-backdrop');
    const z = (el) => el ? parseInt(getComputedStyle(el).zIndex, 10) : null;
    return {
        shell: r(document.querySelector('.shell.slider')),
        nav: r(document.querySelector('nav.shell-nav')),
        card: r(card),
        btn: r(document.querySelector('.pad-menu-btn')),
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        scrollY: window.scrollY,
        cardOverflow: card ? getComputedStyle(card).overflow : null,
        contentDisplay: getComputedStyle(document.querySelector('.content')).display,
        zShell: z(document.querySelector('.shell.slider')),
        zBackdrop: z(bk),
        backdropShown: bk ? getComputedStyle(bk).display !== 'none' : false,
        // 20261006 的教训：CSS 注释里出现「星号紧跟斜杠」会把注释当场关掉，
        // 后面整块**静默消失**——浏览器不报错、`grep` 得到、`.mjs` 那两条正则也照样绿。
        // 所以这里直接问 CSSOM "那一档在不在"，让这类"写了但没接上"当场现形。
        media1024: (() => {
            const s = [...document.styleSheets].find(x => (x.href || '').endsWith('dash.css'));
            return s ? [...s.cssRules].some(r => r.media && /1024/.test(r.media.mediaText)) : null;
        })(),
    };
}"""


with sync_playwright() as p:
    br = p.chromium.launch()

    def fresh_page():
        page = br.new_page(viewport={"width": VW, "height": VH})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        # 与 dashboard-sidebar.test.py 同款：token 存在 ⇒ 壳不进登录态分支。
        page.add_init_script("localStorage.setItem('tokenKey', 'x.y.z');")
        page.goto(URL)
        page.wait_for_selector(".menu-bar .nav-links", timeout=10000)
        page.wait_for_timeout(500)
        page.errs = errs
        return page

    # ══ 一、收起态：侧栏真的把全宽还给内容，且整块（含跟随的 fixed nav）都在屏外 ══
    print("\n【一】390×844 收起态：内容占满全宽、侧栏整块在屏外")
    pg = fresh_page()
    g = pg.evaluate(GEO)
    check("窄屏那段媒体查询真的进了 CSSOM（不是「写了但没接上」）",
          g["media1024"] is True, str(g["media1024"]))
    check("窄屏外壳没把页面撑爆（无横向溢出）",
          g["scrollW"] <= g["innerW"] + 1, f"scrollW={g['scrollW']} innerW={g['innerW']}")
    check("媒体档生效（.content 从 flex 居中改成 block，否则高个子内容会上下同时溢出）",
          g["contentDisplay"] == "block", g["contentDisplay"])
    check(f"卡片左缘贴住 12px 内边距（left={g['card']['left']:.1f} ≤ 16）",
          g["card"]["left"] <= 16, f"left={g['card']['left']:.1f}")
    check(f"卡片吃满窄屏宽度（宽 {g['card']['width']:.1f} ≥ 视口−24）",
          g["card"]["width"] >= VW - 24 - 1, f"width={g['card']['width']:.1f}")
    check(f"卡片右缘不越屏（right={g['card']['right']:.1f} ≤ {VW}）",
          g["card"]["right"] <= VW + 1, f"right={g['card']['right']:.1f}")
    check(f"外层抽屉整块滑出屏外（right={g['shell']['right']:.1f} ≤ 0）",
          g["shell"]["right"] <= 0.5, f"right={g['shell']['right']:.1f}")
    check(f"抽屉仍是 250 宽（三档 tier 在窄屏整体作废）",
          abs(g["shell"]["width"] - 250) < 1, f"width={g['shell']['width']:.1f}")
    # 这一条是本套件最要紧的一条：外层位移了、内层那颗 `position:fixed` 的 nav 不跟着走的话，
    # 内容区照样被它盖住 —— 只量外层会「假绿」。
    check(f"内层 fixed nav 跟着一起滑出屏外（nav.right={g['nav']['right']:.1f} ≤ 0）",
          g["nav"]["right"] <= 0.5, f"right={g['nav']['right']:.1f}")

    # ══ 二、抽屉交互：汉堡钮开、点遮罩关 ══
    print("\n【二】抽屉交互（汉堡钮 / 遮罩）")
    check("汉堡钮渲染出来了", g["btn"] is not None)
    check("汉堡钮真的可见（display:flex 生效）",
          pg.locator(".pad-menu-btn").is_visible())
    # 沙箱不链图标字体 ⇒ 字形是空的，只能按**类名与可点性**断言，不断言可见像素。
    pg.click(".pad-menu-btn")
    pg.wait_for_timeout(450)          # transition: all .3s ease
    g = pg.evaluate(GEO)
    check(f"点汉堡后抽屉到位（外壳 left={g['shell']['left']:.1f} ≈ 0）",
          abs(g["shell"]["left"]) <= 1, f"left={g['shell']['left']:.1f}")
    check(f"内层 nav 也在位（left={g['nav']['left']:.1f} ≈ 0）",
          abs(g["nav"]["left"]) <= 1, f"left={g['nav']['left']:.1f}")
    check(f"抽屉抬到遮罩之上（{g['zShell']} > {g['zBackdrop']}，真模态；也压过看板娘的 1000）",
          g["zShell"] is not None and g["zBackdrop"] is not None and g["zShell"] > g["zBackdrop"],
          f"shell={g['zShell']} backdrop={g['zBackdrop']}")
    check("遮罩铺开了", g["backdropShown"])
    # 点遮罩时**要挑抽屉右侧那一点**（340 > 250）：点正中会被抽屉接管，
    # Playwright 的可点性检查会当场判"被别的元素挡住"，那是判据写错、不是代码坏了。
    hit = True
    try:
        pg.locator(".nav-backdrop").click(position={"x": VW - 50, "y": VH - 200}, timeout=3000)
    except Exception as e:                                  # noqa: BLE001
        hit = False
        detail = str(e).splitlines()[0]
    check("遮罩在抽屉右侧那一片确实是最上层（点得到）", hit, "" if hit else detail)
    pg.wait_for_timeout(450)
    g = pg.evaluate(GEO)
    check(f"点遮罩后抽屉复位（right={g['shell']['right']:.1f} ≤ 0）",
          g["shell"]["right"] <= 0.5, f"right={g['shell']['right']:.1f}")
    check("遮罩跟着收起", not g["backdropShown"])

    # ══ 三、整页滚得到底 ══
    print("\n【三】内容高于视口时滚得到底（「每个菜单展开后被截断」那条）")
    g = pg.evaluate(GEO)
    check(f"卡片不再裁溢出（computed overflow={g['cardOverflow']} ≠ hidden）",
          g["cardOverflow"] != "hidden", g["cardOverflow"])
    check(f"文档确实比视口高（scrollHeight={g['scrollH']} > {g['innerH']}）",
          g["scrollH"] > g["innerH"], f"{g['scrollH']} vs {g['innerH']}")
    pg.evaluate("() => window.scrollTo(0, 1e6)")
    pg.wait_for_timeout(150)
    bottom = pg.evaluate("() => ({ y: window.scrollY,"
                         " ok: Math.round(window.scrollY + window.innerHeight)"
                         "     >= document.documentElement.scrollHeight - 1 })")
    check(f"滚得动（scrollY={bottom['y']} > 0）", bottom["y"] > 0, str(bottom["y"]))
    check("滚得到底（能看满最后一屏）", bottom["ok"])
    check("全程无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ══ 四、负控：把三条判据各自的"坏形状"假回去，必须当场转红 ══
    # 照 dashboard-sidebar.test.py 的"对照"写法：判据自己得先被证明是敏感的。
    print("\n【四】负控（判据自带牙）")

    # ① 当年那个内联 marginLeft:80 加回去 ⇒ "卡片贴左" 与 "不横向溢出" 两条必须红。
    nc = fresh_page()
    nc.evaluate("() => { document.querySelector('.Card').style.marginLeft = '80px'; }")
    nc.wait_for_timeout(80)
    g = nc.evaluate(GEO)
    check("负控①：卡回内联 marginLeft:80 ⇒ left 越界、「卡片贴左」会红",
          g["card"]["left"] > 16, f"left={g['card']['left']:.1f}")
    check("负控①：同一手也把页面撑出横向溢出 ⇒「不横向溢出」会红",
          g["scrollW"] > g["innerW"] + 1, f"scrollW={g['scrollW']} innerW={g['innerW']}")
    nc.close()

    # ② 把"固定高 + 裁溢出 + flex 居中"那条老形状假回去 ⇒ "滚得到底"必须红。
    #    ⚠️ 只写 `.Card{height:95%!important}` **不够**：媒体档把 `.content` 改成了
    #    `height:auto`，百分比高度对 auto 父级会退化成 auto，卡片照样长高、照样滚得动。
    #    所以必须连 `.content` 的固定视口高一起假回去 —— 那才是线上那个坏形状。
    nc = fresh_page()
    nc.evaluate("""() => {
        const s = document.createElement('style');
        s.textContent = '.content{display:flex!important;align-items:center!important;'
                      + 'height:100vh!important;overflow:hidden!important}'
                      + '.Card{height:95%!important;overflow:hidden!important}';
        document.head.appendChild(s);
    }""")
    nc.wait_for_timeout(150)
    g = nc.evaluate(GEO)
    check("负控②：假回「固定高 + overflow:hidden」⇒ overflow 判据会红",
          g["cardOverflow"] == "hidden", g["cardOverflow"])
    check("负控②：同一手把文档锁回视口高 ⇒「滚得到底」会红",
          g["scrollH"] <= g["innerH"] + 1, f"scrollH={g['scrollH']} innerH={g['innerH']}")
    nc.close()

    # ③ 把汉堡钮从 DOM 里摘掉 ⇒ "汉堡钮可见"这条必须红（否则它可能是靠别的元素碰巧为真）。
    nc = fresh_page()
    nc.evaluate("() => document.querySelector('.pad-menu-btn').remove()")
    nc.wait_for_timeout(80)
    check("负控③：摘掉汉堡钮 ⇒「汉堡钮渲染出来了」会红",
          nc.evaluate("() => !document.querySelector('.pad-menu-btn')"))
    nc.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 后台窄屏适配：全部通过")
