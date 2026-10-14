# -*- coding: utf-8 -*-
"""前台三个"老页"（归档 / 说说 / 分类）的配色必须走和纸令牌，且深浅两档要真的分档。

20261014 配色专项的判据。用户原话：「归档页，说说等等风格也同步到博客主题配色风格」
—— 这三页（都是 `frontHome/Content/*` 下的列表页）一直没跟上 20261001 那批和纸改版，
色值写死在样式里，于是有两个后果：① 与站点其余部分的粉紫天青不是一套；② **深浅两档
拿到同一个值**，其中两条在白天/夜里直接是坏掉的：
  · 归档页时间轴的竖线 `rgba(255,255,255,0.3)` —— 白线压在浅色页面上 **白天等于看不见**；
  · 分类页 `.articleFooter` 的 `rgba(31,41,55,.9)` —— 夜间深灰字压在深底上，同样看不见。

## 为什么判据要真渲染（而不是读源码）
"半死最难自查"：令牌写对、选择器写错、被 antd 的运行时样式压过去 —— 这三种在源码里
**看着都是对的**。本套件因此只读 `getComputedStyle`。实测就抓到过一例：归档页
`.ant-timeline-item-head-blue` 那三条（color/border-color/background）写在那儿好几年，
**一次都没生效过**（computed 仍是 antd 的 `#1677ff` 与白点底）—— 因为 antd v5 的
cssinjs 是运行时注入的，同权重（0,1,0）时后写者赢。这一条只有渲染出来才看得见。

## 判据的形状：拿令牌当期望，不拿字面量当期望
每条断言的期望值是**同场景下现场解析出来的令牌值**（`expected = 渲染一个
`color: var(--washi-x)` 的元素再读它`），不是写死的十六进制。这样调色板整体换了颜色，
本套件仍然是绿的（它判的是"这个位置跟着令牌走"）；而有人把色值重新写死，它立刻红。
配套一条**自证**：day 与 night 两档的读值必须**不相等** —— "写死"这件事的直接症状就是
两档同值，这条比任何字面量比对都稳。反过来它也能自证套件本身没瞎：两档读数若相同，
说明令牌没被解析（环境坏了），下面那些"等于令牌"的断言全是空转。

## 手段
沿用 `notes-list-ui.test.py` 那套（本机不能 vite build，见 CLAUDE.md §2）：esbuild 打**真组件**，
只桩 axios / redux 两个边界（`react-router-dom` 用真的 MemoryRouter），sass 用 programmatic
API 单独编译后拼进沙箱的 index.html，再由 Playwright 读计算值。
与那份套件的两处必要差别，都是为了这一问：① 必须挂上**真的 iconfont 样式表**（那页的
`<i>` 才有宽度）；② 必须把 `index.css`（令牌定义）与 `frontHome/main.css`（老令牌）一起挂上
—— 不挂的话 `var()` 全部落空，量到的是浏览器默认值，还是看不出问题。

用法：python3 frontend/tests/front-theme-tokens.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/react-router-dom/react-helmet-async）、
      playwright(python)。本套件不进 CI（要无头 Chrome），由 `scripts/nightly_sandboxes.sh`
      每天 04:40 串行跑，结果在 ~/sandbox_regression.log。
"""
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


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# vite.config.ts 的 define 那五项（站名/描述/作者/关键词/URL）。少一个就是
# `__SITE_TITLE__ is not defined` 的**载入期**异常：整个 bundle 停在那一句、
# `window.__mount` 根本没挂上，而报错信息里看不出跟本套件要判的东西有任何关系。
SITE_DEFINES = [
    '--define:__SITE_URL__=\'"https://example.invalid"\'',
    '--define:__SITE_AUTHOR__=\'"探针"\'',
    '--define:__SITE_TITLE__=\'"探针"\'',
    '--define:__SITE_DESCRIPTION__=\'"探针"\'',
    '--define:__SITE_KEYWORDS__=\'"探针"\'',
]

# 假后端：三个页面各要一份列表，字段取并集（归档要 noteTitle/createTime/noteKey，
# 说说要 talkKey/talkTitle/nickname/content/createTime，分类要 noteTitle/description/
# updateTime/isTop/cover）。`isTop: 1` 是**刻意**的 —— 分类页那颗置顶图钉只在置顶行渲染，
# 不给它就等于那一处配色（原来是写死的 `red`）没有判据。
FAKE_AXIOS = r"""
localStorage.setItem('tokenKey', 'x.y.z');
const ROWS = [
  { noteKey: 11, noteTitle: '第一篇文章', createTime: '2026-08-01 10:00:00',
    updateTime: '2026-08-01 10:00:00', description: '简介', contents: '正文', cover: '',
    status: 'public', categories: '编程', tags: 'React', readCount: 3, starCount: 1, isTop: 1,
    talkKey: 21, talkTitle: '第一条说说', nickname: '阿岚', avatar: '', content: '说说正文' },
  { noteKey: 12, noteTitle: '第二篇文章', createTime: '2026-08-02 10:00:00',
    updateTime: '2026-08-02 10:00:00', description: '简介', contents: '正文', cover: '',
    status: 'public', categories: '编程', tags: 'Asyncio', readCount: 4, starCount: 2, isTop: 0,
    talkKey: 22, talkTitle: '第二条说说', nickname: '阿岚', avatar: '', content: '说说正文' },
];
const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const http = async (cfg: any) => env(ROWS);   // 三个页面的读接口一律给这一份
export default http;
"""

STUB_REDUX = """\
const state: any = {
  categories: { categories: [{ categoryKey: 2, categoryTitle: '编程', pathName: 'code', color: 'blue', icon: 'icon-bianji2' }] },
  tags: { tag: [] },
  note: { noteList: [] },
  user: { avatar: '', name: '管理员' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import Times from './src/frontHome/Content/Times/index.tsx';
import Talk from './src/frontHome/Content/Talk/index.tsx';
import Categories from './src/frontHome/Content/Categories/index.tsx';

const PAGES: any = { Times, Talk, Categories };
// 每页各自的初始地址 —— MemoryRouter 认的是**路径**，三个页面挂在同一套路由上时
// 只有第一条能匹配，另两个渲染成空（症状是 `g(...)` 读到 null 而不是判红，很难查）。
const AT: any = { Times: '/times', Talk: '/talk', Categories: '/categories/code' };
// 前台根节点的类名照抄 App.tsx：夜里是 `frontDark frontRoot`。令牌的夜间定义挂在
// `.frontDark` 上（index.css），不按这个类名挂就量不到夜间档 —— 整节会"全绿地空转"。
(window as any).__mount = (name: string, dark: boolean) => {
  const C = PAGES[name];
  createRoot(document.getElementById('root')!).render(
    <HelmetProvider>
      <div className={dark ? 'frontDark frontRoot' : 'frontRoot'}>
        <MemoryRouter initialEntries={[AT[name]]}>
          <Routes>
            <Route path="/times" element={<Times />} />
            <Route path="/talk" element={<Talk />} />
            <Route path="/categories/:id" element={<Categories />} />
          </Routes>
        </MemoryRouter>
      </div>
    </HelmetProvider>
  );
};
"""

# 量取脚本。`expected()` 是这套判据的关键：它把 `var(--token)` **在同一个级联里**渲染成
# 一个真实的计算色（挂进 `.frontRoot`，才拿得到夜间档），于是期望值与实测值同源同格式。
MEASURE = r"""([name, dark]) => {
  const host = document.querySelector('.frontRoot');
  const expected = (tok) => {
    const d = document.createElement('div');
    d.style.color = 'var(' + tok + ')';
    host.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  };
  const g = (sel, pseudo) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el, pseudo || undefined);
    return { bg: cs.backgroundColor, color: cs.color, bl: cs.borderLeftColor };
  };
  const rootCs = getComputedStyle(host);
  // 元素缺席时给 `null` 而不是抛异常：**缺席本身就是一条判据**（下面第一节会判"都在场"），
  // 让它以"取不到值"的形式走到断言里，报出来的是"这一处没渲染"，而不是一条 TypeError。
  const pick = (sel, field, pseudo) => { const x = g(sel, pseudo); return x ? x[field] : null; };
  return {
    got: {
      hrBg:              pick('.TimesContainer hr', 'bg'),
      tailBl:            pick('.TimesContainer .ant-timeline-item-tail', 'bl'),
      headColor:         pick('.TimesContainer .ant-timeline-item-head', 'color'),
      headBg:            pick('.TimesContainer .ant-timeline-item-head', 'bg'),
      talkCardBg:        pick('.TalkContainer .talk', 'bg'),
      talkLineBl:        pick('.TalkContainer .talk', 'bl', '::before'),
      talkDotBg:         pick('.TalkContainer .talk', 'bg', '::after'),
      catDateColor:      pick('.CategoriesContainer .articleFooter .post-date', 'color'),
      catMoreColor:      pick('.CategoriesContainer .articleFooter > span:last-child', 'color'),
      catTopColor:       pick('.CategoriesContainer .icon-tuding', 'color'),
    },
    want: {
      pinkDeep:  expected('--washi-pink-deep'),
      line:      expected('--washi-line'),
      paper:     expected('--washi-paper'),
      fontP:     expected('--font-p-color'),
      transparent: 'rgba(0, 0, 0, 0)',
    },
    // 撤掉的令牌不该还留在计算样式里（它是"零消费点"才被删的，回来就意味着有人在 main.css
    // 里又加了一条，而那条不会有任何消费方 ⇒ 又是一份"写了没人用"的配置）
    retired: rootCs.getPropertyValue('--category-hover-color').trim(),
    counts: {
      timeline: document.querySelectorAll('.TimesContainer .ant-timeline-item').length,
      talk: document.querySelectorAll('.TalkContainer .talk').length,
      footer: document.querySelectorAll('.CategoriesContainer .articleFooter').length,
      top: document.querySelectorAll('.CategoriesContainer .icon-tuding').length,
    },
  };
}"""

# 每一行 = 一条断言：页/档 → 取值路径、期望的令牌、人话。
# `pinkDeep` 那几处是"强调色"、`line` 是"线"、`paper` 是"面"、`fontP` 是"次要文字"。
CASES = [
    ("Times/day",   "hrBg",         "pinkDeep",    "归档页分隔线走 --washi-pink-deep"),
    ("Times/night", "hrBg",         "pinkDeep",    "归档页分隔线走 --washi-pink-deep（夜）"),
    ("Times/day",   "tailBl",       "line",        "归档页时间轴竖线走 --washi-line（白天可见）"),
    ("Times/night", "tailBl",       "line",        "归档页时间轴竖线走 --washi-line（夜）"),
    ("Times/day",   "headColor",    "pinkDeep",    "归档页时间轴圆点走 --washi-pink-deep"),
    ("Times/night", "headColor",    "pinkDeep",    "归档页时间轴圆点走 --washi-pink-deep（夜）"),
    ("Times/day",   "headBg",       "transparent", "归档页时间轴圆点是空心的（原意就是 transparent）"),
    ("Times/night", "headBg",       "transparent", "归档页时间轴圆点是空心的（夜）"),
    ("Talk/day",    "talkCardBg",   "paper",       "说说卡片走 --washi-paper"),
    ("Talk/night",  "talkCardBg",   "paper",       "说说卡片走 --washi-paper（夜）"),
    ("Talk/day",    "talkLineBl",   "line",        "说说的日期链条竖线走 --washi-line"),
    ("Talk/night",  "talkLineBl",   "line",        "说说的日期链条竖线走 --washi-line（夜）"),
    ("Talk/day",    "talkDotBg",    "pinkDeep",    "说说的日期链条圆点走 --washi-pink-deep"),
    ("Talk/night",  "talkDotBg",    "pinkDeep",    "说说的日期链条圆点走 --washi-pink-deep（夜）"),
    ("Categories/day",   "catDateColor", "fontP", "分类页「发布于」走 --font-p-color"),
    ("Categories/night", "catDateColor", "fontP", "分类页「发布于」走 --font-p-color（夜）"),
    ("Categories/day",   "catMoreColor", "pinkDeep", "分类页「阅读全文→」走 --washi-pink-deep"),
    ("Categories/night", "catMoreColor", "pinkDeep", "分类页「阅读全文→」走 --washi-pink-deep（夜）"),
    ("Categories/day",   "catTopColor",  "pinkDeep", "分类页置顶图钉走 --washi-pink-deep"),
    ("Categories/night", "catTopColor",  "pinkDeep", "分类页置顶图钉走 --washi-pink-deep（夜）"),
]


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="front-theme-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    # 真的 iconfont：分类页那三处的颜色长在 `.iconfont` 的 ::before 字形上，
    # 挂不上字体就只是一个空盒子（本套件判色，但空盒子的布局与真页面不同，别给自己留第二种差异）
    (sb / "fonts").symlink_to(FE / "public/fonts")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(STUB_REDUX, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    pages = ["Times", "Talk", "Categories"]
    css = [(FE / "src/index.css").read_text(), (FE / "src/frontHome/main.css").read_text()]
    for name in pages:
        out = sb / (name + ".css")
        subprocess.run(["node", "-e",
                        "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                        "require('fs').writeFileSync(process.argv[2],r.css);",
                        str(FE / ("src/frontHome/Content/%s/index.sass" % name)), str(out)],
                       cwd=str(FE), check=True)
        css.append(out.read_text())

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}", *SITE_DEFINES,
                        f"--alias:react-redux={sb}/stub-redux.tsx"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        # 宽容解码：esbuild 会在中文那行按字节截断，严格 utf-8 解会先炸在解码上、盖住真报错
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="/fonts/font_4335817_6gqxzh34cy.css">'
        '<link rel="stylesheet" href="/fonts/font_4466999_8sifudyyiw.css">'
        # 页面底色给个中性浅灰：判的是元素自身的色，底色只影响观感，但留白方便人肉排障
        '<style>html,body,#root{margin:0;min-height:100%}body{background:#f3f3f3}</style>'
        '<style>' + "\n".join(css) + '</style></head><body>'
        '<div id="root"></div><script src="bundle.js"></script></body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静音：访问日志会落进 ~/sandbox_regression.log（那是给人看断言的地方）。"""

    def log_message(self, *a, **k):
        return None


_server = http.server.ThreadingHTTPServer(
    ("127.0.0.1", 0), functools.partial(_Quiet, directory=str(SANDBOX)))
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"


def norm(c):
    """把 `rgb(a, b, c)` / `rgba(a, b, c, d)` 归一成 (r,g,b,a)。

    **不写字面量比对**：同一个颜色浏览器可能回 `rgba(0,0,0,0)` 也可能回 `transparent`，
    而令牌那边给的是 hex/`rgba()` 原文 —— 只在数值上调，格式差异不该判红。
    """
    if c is None:
        return None
    s = c.strip()
    if s == "transparent":
        return (0, 0, 0, 0.0)
    if s == "":
        return None
    n = [float(x) for x in re.findall(r"[\d.]+", s)]
    if len(n) < 3:
        return None
    return (n[0], n[1], n[2], n[3] if len(n) >= 4 else 1.0)


def near(a, b, tol=1.0):
    # `None`（元素缺席 / 值读不出来）**必须判红**，不能落进 norm 的空值分支变成
    # "transparent == transparent"。这条实测踩到过：路由没配好时三个页面里只有一页
    # 渲染出来，另外两页的每一条断言都在拿 None 跟自己比 —— 看着全绿，其实什么都没判。
    if a is None or b is None:
        return False, "取不到值：%r vs %r" % (a, b)
    pa, pb = norm(a), norm(b)
    if pa is None or pb is None:
        return False, "解析不出颜色：%r vs %r" % (a, b)
    return all(abs(x - y) <= tol for x, y in zip(pa, pb)), "%s vs %s" % (a, b)


with sync_playwright() as p:
    br = p.chromium.launch()
    readings = {}
    errs_by = {}

    print("\n【一】三个老页的配色走和纸令牌（day + night 各量一遍）")
    for name in ("Times", "Talk", "Categories"):
        for dark in (False, True):
            key = "%s/%s" % (name, "night" if dark else "day")
            page = br.new_page(viewport={"width": 1280, "height": 900})
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(URL)
            page.evaluate("([n, d]) => window.__mount(n, d)", [name, dark])
            try:
                page.wait_for_selector(".%sContainer" % name, timeout=10000)
            except Exception:
                pass
            page.wait_for_timeout(600)
            readings[key] = page.evaluate(MEASURE, [name, dark])
            errs_by[key] = errs
            page.close()

    # 先把"环境是活的"钉住：三个页面都真渲染出了东西、且没有页面异常。
    # 少了这一段，**空页面在"两档读数相同"这条上也是绿的**（都读到默认值），整套会静默空转。
    for key, m in readings.items():
        c = m["counts"]
        check("%s：页面真渲染出来了（时间轴/说说/列表至少有一处）" % key,
              max(c["timeline"], c["talk"], c["footer"]) > 0, str(c))
        check("%s：无页面异常" % key, not errs_by[key], "; ".join(errs_by[key][:2]))
    for key in ("Times/day", "Talk/day", "Categories/day"):
        c = readings[key]["counts"]
        check("%s：要判的那几处**都在场**（缺席的话对应断言无从谈起）" % key,
              (key != "Times/day" or c["timeline"] > 0)
              and (key != "Talk/day" or c["talk"] > 0)
              and (key != "Categories/day" or (c["footer"] > 0 and c["top"] > 0)), str(c))

    # 自证：白天与夜间的读数必须**真的不同**。这条是整份判据的地基 ——
    # 写死色值的直接症状就是两档同值；反过来，若令牌没被解析（环境坏了），两档也会同值。
    # 无论哪种情形，下面那些"等于令牌"的断言都会失去意义，所以先把它判在前面。
    for name, prop in (("Times", "hrBg"), ("Times", "tailBl"), ("Talk", "talkCardBg"),
                       ("Talk", "talkDotBg"), ("Categories", "catDateColor"),
                       ("Categories", "catMoreColor")):
        d = readings["%s/day" % name]["got"][prop]
        n = readings["%s/night" % name]["got"][prop]
        check("%s 的 %s：白天与夜间不是同一个值（写死色值的直接症状就是两档同值）" % (name, prop),
              norm(d) != norm(n), "day=%s night=%s" % (d, n))

    print("\n【二】逐处等于它该跟的那个令牌")
    for key, prop, tok, desc in CASES:
        m = readings[key]
        got, want = m["got"][prop], m["want"][tok]
        ok, detail = near(got, want)
        check(desc, ok, detail)

    print("\n【三】撤掉的令牌保持撤掉")
    check("--category-hover-color 已从计算样式里消失（它是零消费点才被撤的）",
          readings["Categories/day"]["retired"] == "",
          "读到 %r" % readings["Categories/day"]["retired"])

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 前台三个老页的和纸配色：全部通过")
