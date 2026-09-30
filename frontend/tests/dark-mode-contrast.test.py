# -*- coding: utf-8 -*-
"""后台夜间模式：11 个页面逐个量"字色 vs 它真正的底色"的 WCAG 对比度。

为什么值得单起一个脚本：20260923 后台在壳上接了 antd 的 `darkAlgorithm`（页面文字由
**黑色 token 翻成白色**），而组件里那些**写死的浅色底**（内联 style / 普通类）不跟着变
——于是"白字压浅底"，实测 1.26:1，等同看不见。这类问题：

  · 读代码看不出来 —— 谁压谁取决于层叠（内联 > 类规则 > antd 的 `:where()` token），
    而 `.contentDark` 那层底又是**不透明渐变**（computed backgroundColor 恒透明），
    静态分析根本不知道它参与了合成；
  · lint / tsc / 单测全绿也照样漏；
  · 一个组件一个组件地"目视点过去"才是原来的做法，人一累就漏。

判据 = 每个文本元素与它**合成后**的底色对比度 ≥ 3:1（低于 3:1 谁都读不清）。
排除两类 antd 刻意的低对比：占位符（`ant-select-selection-placeholder`）与禁用态。

已知且**本探针不负责**的一项（会打出来，但不判失败，见 KNOWN）：
  · UserControl（站点设置）—— MUI 组件不吃 antd 深色 token。
（Analytics 曾是第二项，20260930 报表重写时清掉了，见 KNOWN 上方的说明。）

沿用 dashboard-sidebar.test.py 那套既定手段（本机不能 vite build，见 CLAUDE.md §2）：
esbuild 把**真组件**打成一个 bundle、只桩边界（axios / react-redux / react-router-dom），
antd / react / react-dom 全用真的；CSS = 仓库里那 11 份真 `.css` verbatim 拼接 + 真编译的 sass。

用法：python3 frontend/tests/dark-mode-contrast.test.py            # 全部页
      python3 frontend/tests/dark-mode-contrast.test.py Home Users # 只跑指定页
依赖：frontend/node_modules（esbuild/react/react-dom/antd/sass）、playwright(python)。
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

# 侧栏能到达的后台页面（= src/router/index.tsx 里 /dashboard 下的子路由）
PAGES = {
    "Home": "src/pages/Dashboard/Home/index.tsx",
    "AllNotes": "src/pages/Dashboard/Notes/AllNotes/index.tsx",
    "NewNotes": "src/pages/Dashboard/Notes/NewNotes/index.tsx",
    "AllCategorize": "src/pages/Dashboard/Notes/AllCategorize/index.tsx",
    "AllTag": "src/pages/Dashboard/Notes/AllTag/index.tsx",
    "Talks": "src/pages/Dashboard/Talks/index.tsx",
    "Albums": "src/pages/Dashboard/Albums/index.tsx",
    "Users": "src/pages/Dashboard/Users/index.tsx",
    "Analytics": "src/pages/Dashboard/Analytics/index.tsx",
    "UserControl": "src/pages/Dashboard/UserControl/index.tsx",
    "Announcement": "src/pages/Dashboard/Announcement/index.tsx",
}

# 建这个探针时就已经存在、本轮不修的一项。列在这里是为了"探针别哑掉"——
# 它仍然会被打印出来，但不算失败；**任何别的页面**出现不可读文字一律判失败。
#
# Analytics（文章数据报表）**已于 20260930 摘掉**，两条原因都清了：
#   · 图表主题 —— 重写时从 `useIsDarkMode()` 显式传 `theme: {type:'classicDark'}`；
#   · ExpressionError —— 那个是**假后端喂空数组**喂出来的（这一页的读数全在一个对象里，
#     空数组等于整页只剩标题），stub 现在按 URL 给一份真实形状的报表（见 FAKE_AXIOS）。
#     **前提由此变了**：这一页能进普查，靠的是 stub 里有数据，改 stub 时别把它改回去。
# ⚠️ 本探针扫的是 DOM 文本，**G2 画在 canvas 上的字它看不见**（坐标轴、图例、tooltip）。
#    也就是说"图表内部在深色底上读不读得清"仍然没有判据，那部分只能人眼看——
#    不要因为这一行是绿的，就以为整页的配色都被守住了。
KNOWN = {
    "UserControl": "站点设置页是 MUI 写的（TextField/Button/Fab），MUI 不吃 antd 的 "
                   "darkAlgorithm ⇒ 深色页上 label 是纯黑 1.64:1。修它得给 MUI 挂 "
                   "ThemeProvider(palette.mode='dark')，是独立一批。",
}

# 边界①：假后端。返回的列表必须是**空数组**而不是 null —— 后台好几个组件拿到列表直接
# `.map()`，null 会让那棵子树整个抛异常 ⇒ 少渲染一块 ⇒ 普查"没扫全"，读数不可信。
#
# 唯一的例外是文章数据报表（20260930）：它整页的读数都在一个**对象**里，喂空数组等于
# 只渲染出标题栏 ⇒ 探针扫不到"卡片上的数字、图例在深色底上读不读得清"，那是假绿。
# 给一份最小可信样本（两行排行 + 后端那样补过零的 30 天），图表也就真被渲染出来了。
FAKE_AXIOS = """\
const REPORT = {
  generatedAt: '2026-09-30 12:00:00',
  totalViews: 192,
  totalLikes: 12,
  topViewed: [
    { noteId: 1, title: '一篇标题长得足以触发截断的架构文章', views: 128, likes: 9 },
    { noteId: 2, title: '短标题', views: 64, likes: 3 },
  ],
  topLiked: [
    { noteId: 2, title: '短标题', views: 64, likes: 3 },
    { noteId: 1, title: '一篇标题长得足以触发截断的架构文章', views: 128, likes: 9 },
  ],
  daily: Array.from({ length: 30 }, (_, i) => ({
    date: '2026-09-' + String(i + 1).padStart(2, '0'), views: i * 3, likes: i,
  })),
};
const http: any = (cfg: any = {}) => {
  const url: string = (cfg && cfg.url) || '';
  if (url.indexOf('/stats/notes') >= 0) {
    return Promise.resolve({ status: 200, data: { code: 200, data: REPORT } });
  }
  return Promise.resolve({ status: 200, data: { code: 200, data: [] } });
};
export default http;
"""

# 边界②：路由。Outlet 渲染 URL 上 ?page= 指定的那一个后台页面；其余导出是给
# react-router-dom 的 import 兜底（缺一个 esbuild 就直接打包失败）。
STUB_ROUTER = """\
import * as React from 'react';
import * as REG from './page-registry.tsx';
export const useNavigate = () => (to: string, opts?: any) => {
  const w = window as any;
  w.__nav = (w.__nav || []).concat([{ to, opts }]);
};
export const Outlet = () => {
  const name = new URLSearchParams(location.search).get('page') || 'Home';
  const C = (REG as any).PAGES[name] || REG.PAGES.Home;
  return <C />;
};
export const Link = ({ children }: any) => children;
export const NavLink = ({ children }: any) => children;
export const Navigate = () => null;
export const Routes = () => null;
export const Route = () => null;
export const useOutlet = () => null;
export const useParams = () => ({ id: '1' });
export const useSearchParams = () => [new URLSearchParams(location.search), () => {}] as any;
export const useLocation = () => ({ pathname: location.pathname, hash: location.hash,
                                    search: location.search, state: null, key: 'k' });
"""

# 边界③：redux。**只桩"读"**——状态对象每次返回同一个实例（返回新对象会让 useSelector
# 判定"变了"而无限重渲染）。useDispatch 返回 no-op ⇒ 页面挂载时那几个 thunk 不发请求。
STUB_REDUX = """\
const state: any = {
  categories: { categories: [], categoryCount: 0 },
  tags: { tags: [], tag: [], tagCount: 0 },
  note: { noteList: [], noteCount: 0, tagList: [] },
  notes: { noteList: [], noteCount: 0 },
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


def page_registry() -> str:
    lines = ["import * as React from 'react';"]
    for i, rel in enumerate(PAGES.values()):
        lines.append(f"import * as P{i} from './{rel}';")
    lines.append("export const PAGES: Record<string, any> = {")
    for i, name in enumerate(PAGES):
        lines.append(f"  {name}: (P{i}.default || (P{i} as any)),")
    lines.append("};")
    return "\n".join(lines) + "\n"


SASS_JS = '''
const sass = require("sass");
let out = "";
for (const f of process.argv.slice(1)) {
  try { out += sass.compile(f).css.toString() + "\\n"; }
  catch (e) { console.error("SASS ERR " + f + ": " + e.message); process.exit(1); }
}
process.stdout.write(out);
'''


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="dash-dark-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "stub-router.tsx").write_text(STUB_ROUTER, encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(STUB_REDUX, encoding="utf-8")
    (sb / "page-registry.tsx").write_text(page_registry(), encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # esbuild 的 `--loader:.css=text` 把 CSS 吞成字符串、**不会注入页面**，所以每一份
    # "从 TSX import 进来的 .css"都得自己链进去，否则那些按钮是**裸 UA 样式**：
    # 实测后果是 `<button>` 拿到 Chrome 默认脸 rgb(239,239,239)，配白色字被算成
    # 1.40:1 的"浅底浅字"——一条彻头彻尾的假警报，差点去改一个没问题的组件。
    # 逐份 verbatim 拼接（不过 sass，避免动到语义），顺序按路径定死。
    (sb / "vendor.css").write_text(
        "\n".join(f"/* ==== {p.relative_to(FE)} ==== */\n{p.read_text(encoding='utf-8')}"
                  for p in sorted(FE.glob("src/**/*.css"))), encoding="utf-8")

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.css=text", "--loader:.sass=text", "--loader:.scss=text",
                        # 全量页面会拖进 UploadButton 之类的图片资源；esbuild 默认没有
                        # .png 的 loader，会直接判打包失败（dataurl 只为过编译，不参与判据）
                        "--loader:.png=dataurl", "--loader:.jpg=dataurl",
                        "--loader:.jpeg=dataurl", "--loader:.gif=dataurl",
                        "--loader:.webp=dataurl", "--loader:.svg=dataurl",
                        "--jsx=automatic", f"--define:{DEFINE}",
                        f"--alias:react-router-dom={sb}/stub-router.tsx",
                        f"--alias:react-redux={sb}/stub-redux.tsx"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    # sass 必须真编译（esbuild 只把它当文本吞掉）
    rels = []
    for pat in ("src/pages/Dashboard/**/*.sass", "src/components/*/*.sass",
                "src/frontHome/**/*.sass"):
        rels += [x.relative_to(sb).as_posix() for x in sorted(sb.glob(pat))]
    comp = subprocess.run(["node", "-e", SASS_JS] + rels, cwd=str(sb), capture_output=True)
    if comp.returncode != 0:
        raise SystemExit("sass 编译失败：\n%s" % comp.stderr.decode("utf-8", "replace"))
    (sb / "pages.css").write_text(comp.stdout.decode("utf-8"), encoding="utf-8")

    (sb / "index.html").write_text(
        '<!doctype html><html><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="vendor.css">'
        '<link rel="stylesheet" href="pages.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script>'
        '<script>window.__mount();</script>'
        '</body></html>', encoding="utf-8")
    return sb


CENSUS_JS = """() => {
  const P = (c) => { const m = (c||'').match(/[\\d.]+/g); if (!m) return null;
                     return {r:+m[0], g:+m[1], b:+m[2], a: m.length > 3 ? +m[3] : 1}; };
  const leaf = (el) => {
    if (!(el.textContent||'').trim()) return null;
    for (const c of el.childNodes) if (c.nodeType === 1 && (c.textContent||'').trim()) return null;
    return el.textContent.trim();
  };
  const out = [];
  for (const el of document.querySelectorAll('h1,h2,h3,h4,label,td,th,p,span,a,button,li')) {
    if (!el.offsetParent) continue;
    const t = leaf(el); if (!t) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') continue;
    const chain = [], tags = [];
    for (let n = el; n; n = n.parentElement) {
      const b = P(getComputedStyle(n).backgroundColor);
      if (b && b.a > 0.01) {
        chain.push(b);
        tags.push(n.className ? n.className.toString().slice(0,40) : n.tagName);
      }
      // 走到 `.content` 就停：它是内容区的底，再往上（body 的 --body-color #E4E9F7）在
      // 后台不参与合成 —— 后台命中的是 `.contentDark` 那条**不透明渐变**（computed 恒
      // 透明），它把 body 盖死了。继续往上走会把浅色 body 当底 ⇒ 深色页上每个元素都
      // 被算成"浅底"，读数全反。
      if (n.classList && n.classList.contains('content')) break;
      if (n.tagName === 'HTML') break;
    }
    chain.reverse(); tags.reverse();
    out.push({tag: el.tagName, cls: (el.className||'').toString().slice(0,40), txt: t.slice(0,24),
              fg: P(cs.color), chain: chain, tags: tags, size: parseFloat(cs.fontSize),
              html: el.outerHTML.slice(0, 200),
              // 这两类是 antd 刻意的低对比（占位符 / 禁用态），单独归类，不算缺陷
              ph: el.classList.contains('ant-select-selection-placeholder'),
              dis: !!el.closest('[disabled],.ant-btn-disabled,.ant-select-disabled,'
                                + '.ant-pagination-disabled')});
  }
  return out;
}"""

# 链上取不到实底时的兜底基色：深色内容区 = `.contentDark` 的
# radial-gradient(ellipse at top left, #373434 50%, #321e5d 100%)，取其中**更亮**的那端
# #373434（对浅色文字最不利）⇒ 算出来的比值偏保守，不会把真问题放过去。
BASE_DARK = {"r": 55, "g": 52, "b": 52, "a": 1}

# 只有符号/表情的文本（✨️ ❤️️ 🎯 这类装饰 span）不进统计：它们的底色是刻意的半透明色块，
# 算出来的 1.1:1 是噪声，会把真问题挤出榜单。
HAS_WORD = re.compile(r"[0-9A-Za-z一-鿿]")


def over(fg, bg):
    a = fg["a"]
    return {"r": fg["r"]*a + bg["r"]*(1-a), "g": fg["g"]*a + bg["g"]*(1-a),
            "b": fg["b"]*a + bg["b"]*(1-a)}


def lin(c):
    c = c/255.0
    return c/12.92 if c <= 0.03928 else ((c+0.055)/1.055)**2.4


def ratio(fg, bg):
    l1 = 0.2126*lin(fg["r"]) + 0.7152*lin(fg["g"]) + 0.0722*lin(fg["b"])
    l2 = 0.2126*lin(bg["r"]) + 0.7152*lin(bg["g"]) + 0.0722*lin(bg["b"])
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi+0.05)/(lo+0.05)


def mean(c):
    return (c["r"] + c["g"] + c["b"]) / 3.0


def composite(chain):
    bg = dict(BASE_DARK)
    for layer in chain:
        bg = over(layer, bg)
    return bg


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
WANT = sys.argv[1:] or list(PAGES)

print("\n【后台夜间逐页对比度（本地沙箱：真组件 + 真 antd + 真 CSS）】")
bad_pages, total_rows, total_bad = [], 0, 0

with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1440, "height": 900})
    page.add_init_script("localStorage.setItem('tokenKey','x.y.z');"
                         "localStorage.setItem('isDarkMode','true');"
                         "localStorage.setItem('announcement_seen_id','99999999');")
    for name in WANT:
        errs = []
        page.on("pageerror", lambda e: errs.append(str(getattr(e, "stack", e) or e)))
        page.goto(f"{URL}?page={name}")
        page.wait_for_timeout(1800)
        items = page.evaluate(CENSUS_JS)
        rows = []
        for it in items:
            if not it["fg"] or not HAS_WORD.search(it["txt"]):
                continue
            bg = composite(it["chain"])
            fg = over(it["fg"], bg)
            rows.append((ratio(fg, bg), it, bg, fg))
        rows.sort(key=lambda r: r[0])
        # 判据 = 对比度 < 3:1（谁都读不清了）。比起"只看浅底浅字"，这条不会漏掉"深底深字"
        # ——浅色模式下写死的深色文字到了深色页面上就是黑压黑，与浅底浅字是同一个病、
        # 相反的方向。
        bad = [r for r in rows if r[0] < 3.0 and not r[1]["ph"] and not r[1]["dis"]]
        total_rows += len(rows)
        total_bad += len(bad)
        ok = (not bad and not errs) or name in KNOWN
        if not ok:
            bad_pages.append(name)
        print(f"  {'✅' if ok else '❌'} {name:14s} 文本元素 {len(rows):3d}  低于 3:1 {len(bad)}"
              + (f"  页面异常 {len(errs)}" if errs else "")
              + (f"  （已知：{KNOWN[name][:24]}…）" if name in KNOWN and (bad or errs) else ""))
        if errs and name not in KNOWN:
            print("      " + errs[0].splitlines()[0][:150])
        for r in bad:
            tone = "浅底浅字" if mean(r[2]) > 150 and mean(r[3]) > 150 else (
                "深底深字" if mean(r[2]) < 100 and mean(r[3]) < 100 else "低对比")
            print(f"      ⚠️ {r[0]:.2f}:1 [{tone}] {r[1]['tag']}.{r[1]['cls'][:26]} "
                  f"{r[1]['txt']!r}  字色 {r[1]['fg']}")
            print("         底链：" + " → ".join("%s rgba(%.0f,%.0f,%.0f,%.2f)"
                  % (t, b["r"], b["g"], b["b"], b["a"])
                  for t, b in zip(r[1]["tags"], r[1]["chain"])))
            print("         DOM：" + r[1]["html"].replace("\n", " "))
    # ── 附加（20260924 三轮）：Users 页认 ?tab=review ──
    # 后台首页待办卡上那行"3 条评论待人工审核"点过来就落到这里；这个沙箱是**唯一**
    # 会渲染真 Users 页的地方，所以这条接线断言寄在这里（它不关心配色，关心落点）。
    def active_tab():
        return page.evaluate("""() => {
          const t = document.querySelector('.ant-tabs-tab-active');
          return t ? t.textContent.trim() : null;
        }""")

    page.goto(f"{URL}?page=Users&tab=review")
    page.wait_for_timeout(1800)
    check("Users 页认 ?tab=review（待审评论那行跳过来直接落在「评论管理」上）",
          active_tab() == "评论管理", str(active_tab()))
    page.goto(f"{URL}?page=Users")
    page.wait_for_timeout(1800)
    check("不带参数时仍落在「账号管理」（原来的默认没被动过）",
          active_tab() == "账号管理", str(active_tab()))

    br.close()

print()
print(f"  合计 {len(WANT)} 个页面 / {total_rows} 个文本元素，低于 3:1 的 {total_bad} 处")
check("除已知的 UserControl（MUI 不吃 antd 深色 token）外，没有页面出现不可读文字",
      not bad_pages, "; ".join(bad_pages))
if FAILS:
    print(f"\n❌ {len(FAILS)} 项未通过")
    sys.exit(1)
print("\n✅ 后台夜间逐页对比度：通过")
