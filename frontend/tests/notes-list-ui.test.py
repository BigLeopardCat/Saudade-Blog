# -*- coding: utf-8 -*-
"""后台「全部文章」列表页改版的无头验收：真组件 + 真 antd + 假后端。

20260924 追加【五】：列表区铺满卡片、分页条移出滚动区钉在底部、`scroll.y` 撤掉后
表头改靠 `position: sticky` 吸顶、每页条数可调（写进 URL）。四条都只有真跑一遍才
看得见（几何、层级、以及"改每页条数会不会又去拉一次数据"），且它们**互相牵连**
——少写 `tableLayout="fixed"` 列宽就失效、分页条留在滚动区里就会被滚走。

20260923 那轮的四处改动**也都只有真跑一遍才看得见**——
  · 「筛选栏收成一行」是布局结果：`layout="inline"` 下四个控件的 rect.top 是不是同一个值，
    读代码看不出来（`Col span={8}` 换掉之后，谁也不敢保证 antd 的 inline 一定不折行）；
  · 「新增文章按钮挪到标签按钮前」是个**顺序**判据：得拿两者的 getBoundingClientRect 比左右；
  · 「切页不再重新请求」是本轮唯一的**行为**变化，而且判据只有一个——桩里记的请求条数。
    光看"界面上页码变了"完全区分不出"前端切片"和"又拉了一遍整表"；
  · 「深链里的日期会被点搜索清掉」更是只有发出去的那份请求体说了算。

沿用既定手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把**真组件**打成 bundle，
**只桩 axios 这一个边界**（路由用真的 MemoryRouter —— 这页的分页/筛选全靠 URL 真源，
桩掉路由等于把被测对象换掉）；sass 用 programmatic API 单独编译后用 `--loader:.sass=text`
收下。本机无中文字体（截图里汉字是豆腐块），断言全走数值与请求，不受影响。

用法：python3 frontend/tests/notes-list-ui.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/react-router-dom/@mui）、playwright(python)。
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


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# ── 假后端：只桩 axios 这一个边界 ─────────────────────────────────────────────
# 20 行 = 2.5 页（每页 8）⇒ 分页组件真的有多页可翻，"切第 2 页"才有意义。
FAKE_AXIOS = r"""
// 假后端。`window.__calls` 记每一次请求 —— 本轮的硬判据（"切页有没有重新拉"）只能从它读。
const calls: any[] = (window as any).__calls = [];
localStorage.setItem('tokenKey', 'x.y.z');

const ROWS = Array.from({ length: 20 }, (_, i) => {
  const id = 100 + i;
  return {
    noteKey: id,
    noteTitle: '第 ' + (i + 1) + ' 篇测试文章（标题足够长，用来验证省略号列宽）',
    cover: '/static/cover' + (i % 3) + '.jpg',
    noteCategory: 2,
    noteTags: [5, 6],
    isTop: i % 4 === 0 ? 1 : 0,
    updateTime: '2026-09-1' + (i % 9) + ' 10:00:00',
    status: 'public',
    draftOf: null,
  };
});

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 服务端本来会按 start_date/end_date 过滤；这里只照抄"收没收到这两个字段"这件事——
// 本轮的判据是"清掉之后不再发"，不是"服务端过滤得对不对"。
const http = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: wire(cfg.data) });
  await delay(30);
  if (url === '/api/protected/notes/list') return env(ROWS);
  if (url === '/api/protected/notes/search') return env(ROWS);
  return env(null);
};

export default http;
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AllNotes from './src/pages/Dashboard/Notes/AllNotes/index.tsx';

// MemoryRouter 不改浏览器地址栏（这正是它的用途），所以"导航去哪了"要自己记：
// 一个与页面同级的间谍组件，每次 location 变化就往 window.__loc 里追加一条。
function Spy() {
  const loc = useLocation();
  React.useEffect(() => {
    const w = window as any;
    w.__loc = (w.__loc || []).concat([loc.pathname + loc.search]);
  }, [loc]);
  return null;
}

// 不桩路由：这一页的页码/tab/筛选条件全部以 URL 为唯一真源（见 listState.ts 文件头），
// 桩掉 useSearchParams 等于把被测对象换掉。用真的 MemoryRouter，初始地址由测试给。
(window as any).__mount = (path: string) => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[path]}>
    <Spy />
    <Routes>
      <Route path="/dashboard/notes/allnotes" element={<AllNotes />} />
    </Routes>
  </MemoryRouter>
);
"""

STUB_REDUX = """\
const state: any = {
  categories: { categories: [{ categoryKey: 2, categoryTitle: '编程', color: 'blue', icon: 'icon-bianji2' }] },
  tags: { tag: [{ key: 5, tagName: 'React' }, { key: 6, tagName: 'Asyncio' }] },
  note: { noteList: [] },
  user: { avatar: '', name: '管理员' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => undefined;
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="notes-ui-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(STUB_REDUX, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # sass 单独编译（组件里 `import './index.sass'` 由 --loader:.sass=text 收下）
    sass_files = ["src/pages/Dashboard/Notes/AllNotes/index.sass"]
    css = []
    for rel in sass_files:
        out = sb / (pathlib.Path(rel).stem + ".css")
        subprocess.run(["node", "-e",
                        "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                        "require('fs').writeFileSync(process.argv[2],r.css);",
                        str(FE / rel), str(out)], cwd=str(FE), check=True)
        css.append(out.read_text())

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}",
                        f"--alias:react-redux={sb}/stub-redux.tsx"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        # 宽容解码：esbuild 会在中文那行按字节截断，严格 utf-8 解会先炸在解码上、盖住真报错
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    # 20260924：给页面一个**真实的高度上下文**。这页的列表区是 flex 撑满的
    # （`.AllCard{height:100%}`，真实环境里那一 100% 是后台壳的 `.Card` 给的 95vh），
    # 沙箱只挂了一个裸组件，没有父高度可继承 ⇒ 列表区退化成内容高、"铺满卡片"
    # 这类断言全是空转。这里用 `#root{height:100%}` 补上那一层。
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body,#root{height:100%;margin:0}</style>'
        '<style>' + "\n".join(css) + '</style></head><body><div id="root"></div>'
        '<script src="bundle.js"></script></body></html>', encoding="utf-8")
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


def mount(br, path="/dashboard/notes/allnotes", size=(1440, 900)):
    page = br.new_page(viewport={"width": size[0], "height": size[1]})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL)
    page.evaluate("(p) => window.__mount(p)", path)
    page.wait_for_selector(".AllCard .ant-table-row", timeout=10000)
    page.wait_for_timeout(300)
    page.errs = errs
    return page


def form_items(page):
    """四个筛选控件的几何 + 控件清单。`.ant-form-item` 里最后一个是没有 label 的按钮项。"""
    return page.evaluate("""() => {
        const items = [...document.querySelectorAll('.AllCard .ant-form-item')];
        return items.map((el) => {
            const label = el.querySelector('.ant-form-item-label label');
            const b = el.getBoundingClientRect();
            return { label: label ? label.textContent : '', top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        });
    }""")


with sync_playwright() as p:
    br = p.chromium.launch()

    # ── 一、筛选栏收成一行 ─────────────────────────────────────────────────────
    # 判据取"四个控件的 rect.top 是不是同一个值"而不是"表单高度 < N"：高度会被 padding
    # 和字号带偏，而 top 同不同一行是布局的直接后果。（1440 与 1280 各来一遍 —— inline
    # 布局窄屏会折行，1280 是后台侧栏展开后最常见的工作宽度。）
    print("\n【一】筛选栏收成一行")
    for w in (1440, 1280):
        pg = mount(br, size=(w, 900))
        items = form_items(pg)
        fields = [i for i in items if i["label"] in ('文章标题', '文章分类', '文章标签', '是否置顶')]
        check(f"{w}px：四个筛选控件都在（标题/分类/标签/置顶）", len(fields) == 4,
              str([i["label"] for i in items]))
        tops = [i["top"] for i in fields]
        check(f"{w}px：四个控件 rect.top 相差 < 4px（确实同一行）",
              max(tops) - min(tops) < 4, f'tops={[round(t, 1) for t in tops]}')
        check(f"{w}px：控件按「标题→分类→标签→置顶」从左到右排",
              [i["left"] for i in fields] == sorted(i["left"] for i in fields),
              str([round(i["left"]) for i in fields]))
        check(f"{w}px：整条筛选栏高度收敛到一行（< 100px）",
              max(i["bottom"] for i in items) - min(i["top"] for i in items) < 100,
              f'高度={max(i["bottom"] for i in items) - min(i["top"] for i in items):.1f}px')
        # 反面判据：`Row`/`Col` 那套还留着的话，Form 的**直接子节点**里一定有个 `.ant-row`。
        # ⚠️ 不能用 `.AllCard .ant-row` 泛匹配 —— antd 的 `Form.Item` 内部自带
        # `.ant-form-item-row`（inline 布局下每个 item 一个），泛匹配会永远假红。
        check(f"{w}px：不再有 Row/Col 包裹（form 的直接子节点里没有 .ant-row）",
              pg.evaluate("() => document.querySelectorAll('.AllCard form > .ant-row').length") == 0)
        # 发布时间控件撤掉后，页面上不该再有日期选择器（RangePicker 会渲染 .ant-picker）
        check(f"{w}px：「发布时间」控件已撤（.ant-picker 计数为 0）",
              pg.evaluate("() => document.querySelectorAll('.AllCard .ant-picker').length") == 0)
        check(f"{w}px：无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
        pg.close()

    # ── 二、新增文章按钮：缩小 + 挪到「全部文章」标签之前 ────────────────────────
    print("\n【二】「新增文章」按钮的位置与形态")
    pg = mount(br)
    geo = pg.evaluate("""() => {
        const btn = [...document.querySelectorAll('.AllCard .ant-btn')]
            .find((b) => b.textContent.includes('新增文章'));
        const tab = document.querySelector('.AllCard .ant-tabs-tab');
        const r = (el) => { const b = el.getBoundingClientRect();
                            return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height }; };
        return { btn: btn ? r(btn) : null, tab: tab ? r(tab) : null,
                 cls: btn ? btn.className : '', small: btn ? btn.classList.contains('ant-btn-sm') : false,
                 fabAdd: document.querySelectorAll('.AllCard [aria-label="add"]').length,
                 rrp: document.querySelectorAll('.AllCard .ant-picker-range').length };
    }""")
    check("有一颗「新增文章」按钮", geo["btn"] is not None, str(geo["cls"]))
    check("是 antd 的小号按钮（不再是 40px 的圆形 Fab）",
          geo["small"] and geo["btn"]["h"] <= 26, f'h={geo["btn"]["h"]:.1f}')
    check("点它之前没有别的 add 按钮残留（旧 Fab 已删）", geo["fabAdd"] == 0, str(geo["fabAdd"]))
    check("按钮在「全部文章」标签按钮之前（right <= tab.left）",
          geo["btn"]["right"] <= geo["tab"]["left"] + 0.5,
          f'btn.right={geo["btn"]["right"]:.1f} tab.left={geo["tab"]["left"]:.1f}')
    check("按钮与标签条同一行（垂直重叠）",
          geo["btn"]["bottom"] > geo["tab"]["top"] and geo["btn"]["top"] < geo["tab"]["bottom"])
    # 20260927 用户报「刷新按钮和后面的页标签太挤了」：tab 条左侧的附加内容里有两颗按钮
    # （新增文章 / 刷新），新增文章自带 margin-right、刷新没有 ⇒ 刷新与第一个标签之间
    # 只剩 antd 的默认值。判据取**刷新按钮右缘到第一个标签左缘的距离**，与页内既有的
    # 12px 节奏对齐（新增文章 → 刷新 就是 12px）。改成量距离而不是"某处有个 margin"：
    # margin 写在谁身上、被谁吃掉，读代码看不出来。
    rgeo = pg.evaluate("""() => {
        const btn = [...document.querySelectorAll('.AllCard .ant-btn')]
            .find((b) => b.textContent.includes('刷新'));
        const tab = document.querySelector('.AllCard .ant-tabs-tab');
        if (!btn || !tab) return null;
        const b = btn.getBoundingClientRect(), t = tab.getBoundingClientRect();
        return { right: b.right, left: t.left, gap: t.left - b.right, text: btn.textContent.trim() };
    }""")
    check("有一颗「刷新」按钮，且在标签条左侧", rgeo is not None and rgeo["gap"] > -0.5,
          str(rgeo))
    check("刷新按钮与后面的页标签不挤（间距 ≥ 12px）",
          rgeo is not None and rgeo["gap"] >= 12,
          f'gap={rgeo["gap"]:.1f}px' if rgeo else 'null')
    if rgeo:
        # 与「新增文章 → 刷新」的间距一致（同一行的两颗按钮不该用两套节奏）
        gap2 = pg.evaluate("""() => {
            const bs = [...document.querySelectorAll('.AllCard .ant-btn')];
            const add = bs.find((b) => b.textContent.includes('新增文章'));
            const rf = bs.find((b) => b.textContent.includes('刷新'));
            if (!add || !rf) return null;
            return rf.getBoundingClientRect().left - add.getBoundingClientRect().right;
        }""")
        check("与「新增文章 → 刷新」的间距同量级（同一套节奏）",
              gap2 is not None and abs(rgeo["gap"] - gap2) <= 8,
              f'refresh→tab={rgeo["gap"]:.1f} add→refresh={gap2}')
    pg.locator(".AllCard .ant-btn", has_text="新增文章").first.click()
    pg.wait_for_timeout(250)
    # MemoryRouter 不动浏览器地址栏，导航去向由 entry 里那个 Spy 记进 window.__loc
    check("点它导航到 /dashboard/notes/newnote",
          pg.evaluate("() => window.__loc[window.__loc.length - 1]") == '/dashboard/notes/newnote',
          str(pg.evaluate("() => window.__loc")))
    pg.close()

    # ── 三、切页不再重新请求（本轮唯一的**行为**变化）───────────────────────────
    # 视口压到 700 高：列表区是 flex 撑满的，20 行 × 70px 必然溢出，否则"回顶"这条
    # 断言是空转（scrollTop 本来就没得滚）。前置条件单独断言。
    print("\n【三】切页不再重新请求 + 回顶")
    pg = mount(br, size=(1440, 700))
    box = pg.evaluate("""() => {
        const b = document.querySelector('.AllCard .custom-scroll-container');
        return { sh: b.scrollHeight, ch: b.clientHeight };
    }""")
    check("前置：列表内容真的溢出了（否则回顶断言是空转）", box["sh"] > box["ch"] + 40,
          f'{box["sh"]} vs {box["ch"]}')
    n0 = pg.evaluate("() => window.__calls.length")
    check("首屏拉了一次数据", n0 == 1, f"calls={n0}")
    pg.evaluate("() => { document.querySelector('.AllCard .custom-scroll-container').scrollTop = 120; }")
    pg.wait_for_timeout(60)
    pg.locator(".AllCard .ant-pagination-item-2").first.click()
    pg.wait_for_timeout(700)
    n1 = pg.evaluate("() => window.__calls.length")
    check("切到第 2 页：**没有**再发请求（前端切片）", n1 == n0, f"{n0} → {n1}")
    check("切页后列表滚回顶部（scrollTop === 0）",
          pg.evaluate("() => document.querySelector('.AllCard .custom-scroll-container').scrollTop") == 0)
    first_title = pg.evaluate("() => document.querySelector('.AllCard .note-title-txt').textContent")
    check("第 2 页显示的是第 11 篇（每页 10 条，切片真的换了）", '第 11 篇' in first_title, first_title)
    # 对照：切 tab 是**该**重新拉的（否则上面那条"没发请求"可能只是计数器不灵）
    pg.locator(".AllCard .ant-tabs-tab", has_text="私密文章").first.click()
    pg.wait_for_timeout(700)
    n2 = pg.evaluate("() => window.__calls.length")
    check("对照：切 tab 会重新请求（说明计数器有效）", n2 == n1 + 1, f"{n1} → {n2}")
    check("切 tab 后页码回到第 1 页",
          pg.evaluate("() => document.querySelector('.AllCard .ant-pagination-item-active').textContent") == '1')
    check("第三节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 四、深链里的日期条件点搜索会被清掉 ─────────────────────────────────────
    # 「发布时间」控件撤了，但 `?from=&to=` 仍在 URL 契约里（老深链要能进来）。风险在于
    # setParam 是合并语义：从深链进来再点搜索，旧日期会隐形地继续生效，而页面上已经
    # 没有任何控件能看见或清掉它 —— 所以 onFinish 里那两行显式清空必须有回归锁。
    print("\n【四】深链日期条件：能进来，且点搜索后被清掉")
    pg = mount(br, path="/dashboard/notes/allnotes?from=2026-09-01&to=2026-09-10")
    first = pg.evaluate("() => window.__calls[0]")
    check("带 ?from=&to= 进来：首请求按搜索走，且带上了日期条件",
          first["url"] == '/api/protected/notes/search'
          and first["data"].get('start_date') == '2026-09-01'
          and first["data"].get('end_date') == '2026-09-10', str(first))
    # ⚠️ 不能用 has_text="搜索"：antd 会给**两个汉字**的按钮自动插一个空格（渲染成「搜 索」），
    # 按整词匹配永远命中不了（20260922 在 user-center.test.py 上踩过同一个坑）。按 type 定位。
    pg.locator('.AllCard form button[type="submit"]').first.click()
    pg.wait_for_timeout(700)
    last = pg.evaluate("() => window.__calls[window.__calls.length - 1]")
    check("点搜索：日期条件不再发出（from/to 被显式清空）",
          last["url"] == '/api/protected/notes/list', str(last))
    check("点搜索后 URL 里的 from/to 也消失了",
          pg.evaluate("() => document.querySelectorAll('.AllCard .ant-picker').length") == 0)
    check("第四节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 五、列表区铺满卡片、分页条钉底、表头吸顶（20260924 重排）────────────────
    # 这一轮撤掉了 `scroll={{y:'56vh'}}`：那个定高滚动区在 900 高的窗口上只有 504px、
    # 刚好把每页最后一条藏进滚动区，而卡片下方还空着 150px。下面每条都只有真跑一遍
    # 才看得见（几何、层级、以及"改每页条数会不会又去拉一次数据"）。
    print("\n【五】列表区铺满卡片 + 分页条钉底 + 表头吸顶")
    pg = mount(br, size=(1440, 900))
    geo = pg.evaluate("""() => {
        const R = (el) => { const b = el.getBoundingClientRect();
            return {t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1)}; };
        const card = document.getElementById('root');   // 沙箱里它就是"页面高度"（见 index.html）
        const sr = document.querySelector('.AllCard .searchRes');
        const cont = document.querySelector('.AllCard .custom-scroll-container');
        const foot = document.querySelector('.AllCard .listFooter');
        return {
            card: R(card), sr: R(sr), cont: R(cont), foot: R(foot),
            legacyBody: document.querySelectorAll('.AllCard .ant-table-body').length,
            tableLayout: getComputedStyle(document.querySelector('.AllCard .ant-table table')).tableLayout,
            panelBg: getComputedStyle(sr).backgroundColor,
            rows: document.querySelectorAll('.AllCard .ant-table-row').length,
            sizeChanger: document.querySelectorAll('.AllCard .ant-pagination-options').length,
            total: (document.querySelector('.AllCard .listFooter') || {}).textContent || '',
        };
    }""")
    check("每页 10 条（不再是 8）", geo["rows"] == 10, f'rows={geo["rows"]}')
    check("列表区一直铺到卡片底部（原来的空白没有了）",
          abs(geo["sr"]["b"] - geo["card"]["b"]) < 3 and abs(geo["foot"]["b"] - geo["card"]["b"]) < 3,
          f'面板底 {geo["sr"]["b"]} / 分页底 {geo["foot"]["b"]} / 卡片底 {geo["card"]["b"]}')
    check("分页条紧贴滚动区下沿（在滚动区**之外**，滚多远都看得见）",
          abs(geo["foot"]["t"] - geo["cont"]["b"]) < 3,
          f'分页顶 {geo["foot"]["t"]} / 滚动区底 {geo["cont"]["b"]}')
    # 撤掉 scroll.y 之后 rc-table 只渲染一张表（没有独立的表头/表体两张表），
    # 表头吸顶才能靠一行 position:sticky 做到
    check("单表结构（没有 .ant-table-body 这层了）", geo["legacyBody"] == 0,
          f'legacyBody={geo["legacyBody"]}')
    check("列宽仍是 fixed 布局（百分比列宽全靠它）", geo["tableLayout"] == "fixed",
          str(geo["tableLayout"]))
    check("分页条带每页条数选择器", geo["sizeChanger"] == 1)
    check("总数文案在位（第 x-y 条 / 共 N 篇）", "第 1-10 条" in geo["total"] and "共 20 篇" in geo["total"],
          geo["total"][:40])
    stuck = pg.evaluate("""() => {
        const cont = document.querySelector('.AllCard .custom-scroll-container');
        const th = document.querySelector('.AllCard .ant-table-thead th');
        cont.scrollTop = cont.scrollHeight;
        const ct = cont.getBoundingClientRect().top, tt = th.getBoundingClientRect().top;
        return {scrolled: cont.scrollTop > 20, gap: Math.abs(ct - tt)};
    }""")
    check("列表滚到底时表头仍吸在滚动区顶部",
          stuck["scrolled"] and stuck["gap"] < 2, str(stuck))
    # 表头吸顶了还不够：行内那三颗 MUI Fab 自带 z-index:1050，会**画在表头上面**
    # （实测截图里第一行的操作按钮浮在表头上）。断言的是叠放次序本身，不是某张截图。
    zs = pg.evaluate("""() => {
        const th = document.querySelector('.AllCard .ant-table-thead th');
        const fab = document.querySelector('.AllCard .ant-table-row .MuiFab-root');
        return {th: +getComputedStyle(th).zIndex, fab: +getComputedStyle(fab).zIndex};
    }""")
    check("行内 Fab 不再压在吸顶表头之上（z-index 已归零）",
          zs["fab"] < zs["th"], f'fab={zs["fab"]} th={zs["th"]}')

    # 改每页条数：要写进 URL（返回列表/刷新后还在），且**不该**重新拉数据
    n_before = pg.evaluate("() => window.__calls.length")
    pg.locator(".AllCard .ant-pagination-options .ant-select").first.click()
    pg.wait_for_timeout(300)
    pg.locator(".ant-select-item-option", has_text="20 条/页").first.click()
    pg.wait_for_timeout(700)
    n_after = pg.evaluate("() => window.__calls.length")
    check("改每页条数：**没有**重新拉数据（数据与分页无关，只是切片变了）",
          n_after == n_before, f"{n_before} → {n_after}")
    check("改每页条数：URL 里写上了 size=20",
          "size=20" in (pg.evaluate("() => window.__loc[window.__loc.length - 1]") or ""),
          str(pg.evaluate("() => window.__loc")))
    check("改每页条数：一屏 20 条、页数变 1",
          pg.evaluate("() => document.querySelectorAll('.AllCard .ant-table-row').length") == 20
          and pg.evaluate("() => document.querySelectorAll('.AllCard .ant-pagination-item').length") == 1)
    check("第五节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 后台文章列表页改版：全部通过")
