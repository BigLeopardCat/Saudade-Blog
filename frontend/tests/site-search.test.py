# -*- coding: utf-8 -*-
"""站内聚合搜索（20261006）无头验收：真 Head 组件 + 假后端，走真渲染与真点击。

为什么值得单起一个脚本：
  「点了一条结果能不能到那一条上」这件事**只有真跑一遍才知道**——四类四条路径，
  写错一条的症状是"某一类点了没反应 / 跳到别处"，不报错、不白屏、编译也照样过。
  另有两条同样只在真渲染里看得见的：
    · 计数栏那四枚在 375 视口会不会把整行撑出弹窗（`flex-wrap` 写了不等于生效）；
    · 读失败会不会被渲染成"没搜到"（本站失败是 HTTP 200 + code=500，只看 status 就会）。

  纯模型与源码契约（`hitTarget` 四条路径、说说深链读的是响应式 searchParams）由
  `tests/site-search.test.mjs` 在 CI 里守着；这里负责几何与真点击。

    · sass 用 programmatic API 编译（`node_modules/.bin/sass` 在 Node 18 上崩）；
    · esbuild 把真 Head 打成一个 bundle，**只桩边界**（axios 假后端 / 路由 / redux），
      antd 与 react-dom 都用真的；
    · Playwright 真渲染后按"发了什么请求 + 界面变成什么样 + `__nav` 记到了什么"断言。

用法：python3 frontend/tests/site-search.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)。
注意：本机无中文字体（fc-list CJK = 0）⇒ 汉字是豆腐块，结构与请求判据不受影响。
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
FAKE_AXIOS = r"""
// 假后端。`window.__calls` 记每一次请求，测试按它断言"该发的发了、没发的没发"。
const calls: any[] = (window as any).__calls = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 信封照抄后端：**失败也是 HTTP 200**，靠 `code` 分。只看 status 的写法在这里会露馅。
const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const fail = (msg: string) => ({ status: 200, data: { code: 500, message: msg, data: null } });

// 四类混合命中。**字段名与后端逐字一致**（`board` 是单数、`comments` 是复数）——
// 这里写对了而真身写错，正是 `hitsOf` 那个映射要挡的事，两边都必须是真名。
const FIX = () => ({
  total: 6,
  counts: { note: 2, talk: 2, board: 1, comment: 1 },
  notes: [
    { type: 'note', key: 5, title: '文章甲', snippet: '正文里有 河灯 两个字', author: '站长',
      noteId: null, createTime: '2026-07-01 10:00:00' },
    { type: 'note', key: 6, title: '文章乙', snippet: '也提到 河灯', author: '站长',
      noteId: null, createTime: '2026-07-02 10:00:00' },
  ],
  talks: [
    { type: 'talk', key: 9, title: '说说甲', snippet: '河灯 很好看', author: '泠月喵',
      noteId: null, createTime: '2026-07-03 10:00:00' },
    { type: 'talk', key: 10, title: '说说乙', snippet: '河灯 之二', author: '泠月喵',
      noteId: null, createTime: '2026-07-04 10:00:00' },
  ],
  board: [
    { type: 'board', key: 8, title: '', snippet: '留言里也有 河灯', author: '留名甲',
      noteId: null, createTime: '2026-07-05 10:00:00' },
  ],
  comments: [
    { type: 'comment', key: 41, title: '文章甲', snippet: '评论里提到 河灯', author: '路人',
      noteId: 5, createTime: '2026-07-06 10:00:00' },
  ],
});

const http = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: cfg.data });
  await delay(30);

  if (url === '/api/public/search') {
    // 竞态用例专用（`__seqTest`）：**回什么由关键词本身决定**，且指定某个关键词走慢通道。
    // 这样"最后画在屏幕上的是哪一次的结果"是一眼可读的（条数 = 关键词长度、标题里带关键词）。
    if ((window as any).__seqTest) {
      const kw = ((cfg.data || {}).keyword || '') as string;
      if (kw === (window as any).__slowKw) await delay(1500);
      const n = kw.length;
      return env({
        total: n, counts: { note: n, talk: 0, board: 0, comment: 0 },
        notes: Array.from({ length: n }, (_, i) => ({
          type: 'note', key: 100 + i, title: `№${i + 1}·${kw}`, snippet: '正文 ' + kw,
          author: '站长', noteId: null, createTime: '2026-07-01 10:00:00' })),
        talks: [], board: [], comments: [],
      });
    }
    if ((window as any).__searchFail) return fail('查询失败，请稍后再试');
    if ((window as any).__searchEmpty) {
      return env({ total: 0, counts: { note: 0, talk: 0, board: 0, comment: 0 },
                   notes: [], talks: [], board: [], comments: [] });
    }
    if ((window as any).__searchNoNote) {
      const f = FIX();
      f.notes = []; f.counts.note = 0; f.total = 4;
      return env(f);
    }
    return env(FIX());
  }
  // 其余端点（头部挂载时那些 thunk、用户中心轮询）一律成功、数据为 null
  return env(null);
};

export default http;
"""

# ⚠️ 桩是**真模块表面的手抄副本**：`src/` 里从 react-router-dom 多 import 一个名字，
# 这里没跟着补 ⇒ esbuild 当场 `No matching export` 整包失败。
STUB_ROUTER = (
    "export const useLocation = () => ({ pathname: '/', search: '', hash: '' });\n"
    "export const useNavigate = () => (to: string) => {"
    "(window as any).__nav = ((window as any).__nav || []).concat(to); };\n"
    # Head 本身还没用 useSearchParams（说说页才用，不在本沙箱里）——先备着，
    # 免得日后谁把入口挂到 Head 上时这套件以"打包失败"的方式炸掉。
    "export const useSearchParams = () => [new URLSearchParams(''), () => {}];\n"
)

STUB_REDUX = """\
const state: any = {
  categories: { categories: [] },
  tags: { tags: [] },
  note: { noteList: [] },
  user: { avatar: '/owner.png', blogTitle: 'Saudade' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => Promise.resolve({ status: 200, data: { code: 200, data: null } });
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
"""

HEAD_ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Head from './src/frontHome/Head/index.tsx';
(window as any).__mountHead = () => createRoot(document.getElementById('root')!).render(
  <Head setDark={() => {}} isDark={false} scrollHeight={0} />
);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="sitesearch-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "stub-router.tsx").write_text(STUB_ROUTER, encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(STUB_REDUX, encoding="utf-8")
    (sb / "head-entry.tsx").write_text(HEAD_ENTRY, encoding="utf-8")

    # sass 单独编译（组件里的 `import './index.sass'` 由 esbuild 的 --loader:.sass=text 收下）
    css = []
    for rel in ("src/frontHome/Head/index.sass",):
        out = sb / (pathlib.Path(rel).stem + ".css")
        subprocess.run(["node", "-e",
                        "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                        "require('fs').writeFileSync(process.argv[2],r.css);",
                        str(FE / rel), str(out)], cwd=str(FE), check=True)
        css.append(out.read_text())
    # 全站样式表（`src/main.tsx` 第一行就 import 它）：`--washi-*` 令牌与 `.frontDark`
    # 那几套都住在里面。沙箱只编译组件那份 .sass 的话，靠令牌上色的规则**根本不存在**，
    # 几何/颜色断言会把"规则没生效"读成"页面缺陷"（20260929 那批假红就是这么来的）。
    css.append((sb / "src/index.css").read_text())

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "head-entry.tsx",
                        "--bundle", "--format=iife", "--outfile=head-bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}",
                        f"--alias:react-router-dom={sb}/stub-router.tsx",
                        f"--alias:react-redux={sb}/stub-redux.tsx"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        # 按字节收、宽容解码：esbuild 会在中文那行按字节截断，严格 utf-8 解会先炸在解码上、
        # 把真正的报错盖掉（20260922 实测）。
        raise SystemExit("esbuild 打包失败：\n" + r.stderr.decode("utf-8", "replace"))

    (sb / "head.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        f"<style>{''.join(css)}</style></head><body><div id=\"root\"></div>"
        '<script src="head-bundle.js"></script>'
        '<script>window.__mountHead();</script>'
        '</body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
(ROOT / "frontend/public").exists() and shutil.copyfile(FE / "public/default-avatar.png",
                                                        SANDBOX / "default-avatar.png")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静音：访问日志会落进夜跑日志（那是给人看断言的地方）。
    必须子类覆写——`partial` 的实例属性不影响它转发的那个类。"""

    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

# 必须走 HTTP 而不是 file://：应用里的图片是**根相对路径**，file:// 下必然 404。
HEAD_URL = f"http://127.0.0.1:{_server.server_address[1]}/head.html"


def calls(page):
    return page.evaluate("() => window.__calls || []")


def searches(page):
    return [c for c in calls(page) if c["url"] == "/api/public/search"]


def open_modal(page, init=None, w=1280, h=900):
    """挂真 Head → 从**真入口**点开搜索弹窗。返回 (page, errs)。

    ⚠️ 两个入口，按视口分：`.homeRight` 在 ≤1200px 是 `display: none`（窄屏走抽屉），
    照抄桌面那套会在 `.homeRight > div` 上一直等到超时（这不是页面缺陷，是两套入口本来的分工）。

    窄屏通过真实「打开导航菜单」按钮展开，再点抽屉内搜索框。抽屉样式随 Head
    自身加载，不依赖 Dashboard 首页；按钮即使没有 iconfont 字体也有可点击尺寸。
    """
    p = page.new_page(viewport={"width": w, "height": h})
    errs = []
    p.on("pageerror", lambda e: errs.append(str(e)))
    if init:
        p.add_init_script(init)
    p.goto(HEAD_URL)
    if w > 1200:
        p.wait_for_selector(".homeRight > div", timeout=15000)
        p.wait_for_timeout(500)
        p.locator(".homeRight > div").first.click()
    else:
        p.get_by_role("button", name="打开导航菜单").click()
        p.wait_for_selector(".phoneSide.openBar", state="visible", timeout=15000)
        p.locator(".mSearchInput").click()
    p.wait_for_selector(".searchModalInput", timeout=10000)
    p.wait_for_timeout(300)
    return p, errs


def type_search(p, kw="河灯", settle=800):
    p.fill(".searchModalInput", kw)
    p.wait_for_timeout(settle)


def chip_texts(p):
    return p.eval_on_selector_all(".search-chip", "els => els.map(e => e.textContent.trim())")


def badges(p):
    return p.eval_on_selector_all(".search-item .search-badge",
                                  "els => els.map(e => e.textContent.trim())")


def titles(p):
    """结果行的标题文本（留言那一行没有标题，自然不在里面）——①d 判「屏幕上是谁的结果」用。"""
    return p.eval_on_selector_all(".search-item .search-item-title",
                                  "els => els.map(e => e.textContent.trim())")


def nav_last(p):
    return p.evaluate("() => (window.__nav || []).slice(-1)[0]")


def reopen(p):
    """点了一条结果后弹窗会关掉（`openHit` 先关再跳）。再开一次继续点。"""
    p.wait_for_timeout(500)
    p.locator(".homeRight > div").first.click()
    p.wait_for_selector(".searchModalInput", timeout=10000)
    p.wait_for_timeout(400)


all_errs = []
with sync_playwright() as p:
    br = p.chromium.launch()

    # ── ① 请求：防抖、端点、关键词 ────────────────────────────────────────────
    print("\n① 输入就搜（500ms 防抖），打的是聚合端点")
    pg, errs = open_modal(br)
    pg.fill(".searchModalInput", "河灯")
    pg.wait_for_timeout(200)
    check("刚敲完不立刻发请求（500ms 防抖）", len(searches(pg)) == 0,
          f"200ms 时已有 {len(searches(pg))} 次")
    pg.wait_for_timeout(700)
    s = searches(pg)
    check("停手后自己发了一次", len(s) == 1, f"{len(s)} 次")
    check("打的是聚合端点、POST、带上关键词",
          s and s[0]["url"] == "/api/public/search" and s[0]["method"] == "POST"
          and (s[0]["data"] or {}).get("keyword") == "河灯",
          str(s[:1]))

    # ── ①b 逐字符输入（用户 20261013 报的「输入内容时抖动」）────────────────────
    # ①节一直用 `fill()`，而 `fill()` 只发**一次** input 事件 ⇒ 它看不见"防抖器每次
    # render 换一个新的"这件事。真人是逐字符敲的，这里就必须逐字符敲（`keyboard.type`）。
    # 修复前的实测：敲 5 个字发 **5 次**请求（河 / 河灯 / 河灯留 / 河灯留言 / 河灯留言板），
    # 每个回包各 `setAgg` 一次 ⇒ 结果面随回包先后反复重画（抖动），且乱序时会显示错的词的结果。
    print("\n①b 逐字符敲入：整串只发一次请求（防抖器只建一次，不是每次 render 一个新的）")
    pn, errs = open_modal(br)
    pn.click(".searchModalInput")
    pn.keyboard.type("河灯留言板", delay=60)      # 5 个字、共 ~300ms < 500ms 防抖
    pn.wait_for_timeout(1200)
    s = searches(pn)
    check("敲 5 个字只发一次请求（修复前 5 次）", len(s) == 1,
          f"{len(s)} 次：" + str([(c["data"] or {}).get("keyword") for c in s]))
    check("发出去的是**整串**关键词，不是某个中间前缀",
          s and (s[0]["data"] or {}).get("keyword") == "河灯留言板",
          str([(c["data"] or {}).get("keyword") for c in s]))
    pn.close()
    all_errs.extend(errs)

    # ── ①c 清空输入框 ───────────────────────────────────────────────────────
    # 防御的是"清空之后，先前沿途按键留下的那些防抖定时器一个个到点，用**已经不在框里**
    # 的旧关键词接着发请求"。修复前实测：敲两个字（河、河灯）后立刻清空，照样发出
    # **2 次**（`河`、`河灯`）——因为每次按键各建了一个防抖器，清空这条早退路径谁也没 cancel。
    # 注意症状在 DOM 里是**看不见**的：卡片整块的 display 由 `searchKeyword` 决定
    # （空 ⇒ 整块隐藏），所以在途回包就算把 agg 填回来也渲染不出来 ⇒ 判据只能落在
    # 请求本身（"清空后一次都不许发"），不能落在"列表是不是空的"（那恒真）。
    print("\n①c 清空输入框：挂着的那些防抖不许再发请求")
    pn, errs = open_modal(br)
    pn.click(".searchModalInput")
    pn.keyboard.type("河灯", delay=40)
    pn.wait_for_timeout(60)                      # 仍在 500ms 防抖窗口内
    pn.fill(".searchModalInput", "")
    pn.wait_for_timeout(1000)                    # 足够让那次防抖到点（若没被 cancel）
    check("清空之后一次请求都没发（挂着的那次被 cancel 掉了）",
          len(searches(pn)) == 0,
          f"{len(searches(pn))} 次：" + str([(c["data"] or {}).get("keyword") for c in searches(pn)]))
    pn.close()
    all_errs.extend(errs)

    # ── ①d 乱序回包 ────────────────────────────────────────────────────────
    # 真网络上"慢的是前一次查询"是常态，本地假后端按调用顺序同步返回 ⇒ 只有**手造慢通道**
    # 才看得见。没有序号闸时，慢的旧回包最后落地、把新关键词的结果盖掉 —— 那不只是抖，
    # 是**显示错的搜索结果**（框里写着 A，列表里是 B 的结果）。
    print("\n①d 乱序回包：先发的慢回包不许盖掉后发的快结果")
    pn, errs = open_modal(br, "window.__seqTest = true; window.__slowKw = '河';")
    pn.click(".searchModalInput")
    pn.keyboard.type("河", delay=40)
    pn.wait_for_timeout(700)                     # 第一条（关键词「河」，慢通道 1.5s）已在途
    check("这时确实有一条请求在途", len(searches(pn)) == 1, f"{len(searches(pn))} 次")
    pn.keyboard.type("灯", delay=40)             # 值变成「河灯」→ 500ms 后再发一条（快）
    pn.wait_for_timeout(1000)                    # 快的那条先落地
    check("先看到的是新关键词「河灯」的结果（2 条）",
          pn.locator(".search-item").count() == 2,
          f"{pn.locator('.search-item').count()} 条：" + str(titles(pn)))
    pn.wait_for_timeout(1700)                    # 慢的那条（旧关键词「河」）此刻才落地
    check("旧关键词的慢回包落地后，列表仍是「河灯」的结果（没有被盖回 1 条）",
          titles(pn) == ["№1·河灯", "№2·河灯"], str(titles(pn)))
    check("两次请求都发出去了（判据是「谁画在屏幕上」，不是「省掉了一次请求」）",
          len(searches(pn)) == 2, f"{len(searches(pn))} 次")
    pn.close()
    all_errs.extend(errs)

    # ── ② 标题行：总数 + 四枚计数 ────────────────────────────────────────────
    print("② 标题行 =「搜索结果（总数）」+ 文章/说说/留言/评论 四枚计数")
    total = pg.inner_text(".searchTotal")
    check("总数是全角括号的「搜索结果（6）」", total == "搜索结果（6）", repr(total))
    chips = chip_texts(pg)
    check("四枚计数按 文章→说说→留言→评论 的顺序、各带自己的命中数",
          chips == ["文章（2）", "说说（2）", "留言（1）", "评论（1）"], str(chips))
    check("默认没有选中任何一枚（= 全部）",
          pg.locator(".search-chip.is-active").count() == 0,
          str(pg.locator(".search-chip.is-active").count()))

    # ── ③ 列表：四类混排、每组相邻、行首有类型徽章 ────────────────────────────
    print("③ 列表按 文章→说说→留言→评论 分组，行首看得出是哪一类")
    check("六条命中都在（四类之和）", pg.locator(".search-item").count() == 6,
          str(pg.locator(".search-item").count()))
    check("分组序 = 文章,文章,说说,说说,留言,评论",
          badges(pg) == ["文章", "文章", "说说", "说说", "留言", "评论"], str(badges(pg)))
    check("留言那一行没有标题行（那一列的 title 是印章，后端给的是空串）",
          pg.locator(".search-item", has_text="留言里也有 河灯")
            .locator(".search-item-title").count() == 0,
          str(pg.locator(".search-item", has_text="留言里也有 河灯").inner_text()))
    check("评论那一行带的是**所属文章**的标题",
          pg.locator(".search-item", has_text="评论里提到 河灯")
            .locator(".search-item-title").inner_text() == "文章甲",
          pg.locator(".search-item", has_text="评论里提到 河灯").inner_text())

    # ── ④ 筛选：单击选中、再点回到全部 ───────────────────────────────────────
    print("④ 点一枚计数只看那一类；再点一次回到全部")
    pg.locator(".search-chip", has_text="说说").click()
    pg.wait_for_timeout(300)
    check("只剩说说的两条", pg.locator(".search-item").count() == 2,
          str(pg.locator(".search-item").count()))
    check("两行都是说说", badges(pg) == ["说说", "说说"], str(badges(pg)))
    check("选中态标在那一枚上（一眼看得出选中的是谁）",
          pg.locator(".search-chip.is-active").inner_text().startswith("说说"),
          pg.locator(".search-chip.is-active").inner_text())
    check("筛选是**本地**的，不再打一次请求", len(searches(pg)) == 1,
          f"{len(searches(pg))} 次")
    pg.locator(".search-chip", has_text="说说").click()
    pg.wait_for_timeout(300)
    check("再点一次回到全部（六条）", pg.locator(".search-item").count() == 6,
          str(pg.locator(".search-item").count()))
    check("回到全部后没有选中态", pg.locator(".search-chip.is-active").count() == 0)

    # ── ⑤ 每一条都点得动、各自跳到那一条自己 ────────────────────────────────
    print("⑤ 四类结果各行点击都落到那条内容本身")
    cases = [
        ("文章甲", "/article/5", "文章 → 文章详情"),
        ("河灯 很好看", "/talk?tk=9", "说说 → 说说列表定位到那一条"),
        ("留言里也有 河灯", "/guestbook?lid=8", "留言 → 留言板定位到那盏灯"),
        ("评论里提到 河灯", "/article/5?cid=41", "评论 → 所属文章 + 评论区定位到那条"),
    ]
    for text, want, desc in cases:
        row = pg.locator(".search-item", has_text=text)
        if row.count() == 0:
            check(desc, False, "没找到那一行")
            continue
        row.first.click()
        pg.wait_for_timeout(600)
        check(desc, nav_last(pg) == want, f"__nav 最后一项 = {nav_last(pg)!r}（期望 {want!r}）")
        reopen(pg)

    # 点行之后弹窗应当关上（否则跳过去还压着一层）
    pg.locator(".search-item").first.click()
    pg.wait_for_timeout(600)
    check("点了一条之后弹窗自己关掉",
          pg.locator(".searchModalInput").count() == 0 or
          not pg.locator(".searchModalInput").first.is_visible(),
          "searchModalInput 仍可见")
    pg.close()
    all_errs.extend(errs)

    # ── ⑥ 读失败 ≠ 没搜到 ───────────────────────────────────────────────────
    print("⑥ 接口失败（HTTP 200 + code=500）如实说失败，不渲染成「没找到」")
    pg, errs = open_modal(br, "window.__searchFail = true;")
    type_search(pg)
    check("说了「搜索失败，请稍后再试」", pg.locator(".searchEmpty").count() == 1
          and "搜索失败" in pg.locator(".searchEmpty").inner_text(),
          pg.locator(".searchEmpty").inner_text() if pg.locator(".searchEmpty").count()
          else "(没有空态)")
    check("没有把它说成「未找到相关内容」",
          pg.locator(".searchEmpty", has_text="未找到").count() == 0)
    check("失败时列表是空的（没有半截结果压着）", pg.locator(".search-item").count() == 0,
          str(pg.locator(".search-item").count()))
    pg.close()
    all_errs.extend(errs)

    # ── ⑦ 空态三种说法互不混淆 ──────────────────────────────────────────────
    print("⑦ 「四类全空」与「这一类里没有」是两句不同的话")
    pg, errs = open_modal(br, "window.__searchEmpty = true;")
    type_search(pg)
    check("四类全空 → 未找到相关内容", "未找到相关内容" in pg.locator(".searchEmpty").inner_text(),
          pg.locator(".searchEmpty").inner_text())
    check("全空时四枚计数照样显示（计数是事实，不是空就藏起来）",
          chip_texts(pg) == ["文章（0）", "说说（0）", "留言（0）", "评论（0）"],
          str(chip_texts(pg)))
    pg.close()
    all_errs.extend(errs)

    pg, errs = open_modal(br, "window.__searchNoNote = true;")
    type_search(pg)
    check("有的类有、有的类没有 → 总数仍是 4", pg.inner_text(".searchTotal") == "搜索结果（4）",
          pg.inner_text(".searchTotal"))
    pg.locator(".search-chip", has_text="文章").click()
    pg.wait_for_timeout(300)
    empty = pg.locator(".searchEmpty").inner_text()
    check("点「文章」（0 命中）说的是「文章」里没有命中的内容，不是「未找到相关内容」",
          "文章" in empty and "未找到" not in empty, repr(empty))
    pg.close()
    all_errs.extend(errs)

    # ── ⑧ 窄屏：四枚计数不许把弹窗顶出视口 ──────────────────────────────────
    print("⑧ 375 / 390 / 1440 三个视口：计数栏不横向溢出，窄屏那档样式真的生效")
    for w in (375, 390, 1440):
        pg, errs = open_modal(br, w=w)
        type_search(pg)
        m = pg.evaluate("""() => {
            const q = (s) => document.querySelector(s);
            const row = q('.searchTitleRow'), modal = q('.searchModal');
            const chips = [...document.querySelectorAll('.search-chip')];
            const card = q('.searchModal .ant-card');
            const rows = new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size;
            const r = (el) => el.getBoundingClientRect();
            const input = q('.searchModalInput');
            return {
                rowOver: row.scrollWidth - row.clientWidth,
                modalOver: modal.scrollWidth - modal.clientWidth,
                chipRight: Math.max(...chips.map((c) => r(c).right)),
                chipLeft: Math.min(...chips.map((c) => r(c).left)),
                cardRatio: r(card).width / modal.clientWidth,
                chipRows: rows,
                inputFont: getComputedStyle(input).fontSize,
                vw: window.innerWidth,
            };
        }""")
        check(f"{w}：计数栏自身没有横向溢出（scrollWidth ≤ clientWidth）",
              m["rowOver"] <= 1, f"溢出 {m['rowOver']}px")
        check(f"{w}：四枚计数全部落在视口内",
              m["chipLeft"] >= 0 and m["chipRight"] <= m["vw"] + 1,
              f"left={m['chipLeft']:.0f} right={m['chipRight']:.0f} vw={m['vw']}")
        check(f"{w}：弹窗内容没有横向溢出", m["modalOver"] <= 1, f"溢出 {m['modalOver']}px")
        print(f"     （{w}：计数占 {m['chipRows']} 行、卡片宽 {m['cardRatio']*100:.0f}% 、"
              f"输入框字号 {m['inputFont']}）")
        if w <= 768:
            # 窄屏那档把 `.searchModalInput` 字号收到 1rem、卡片按 `width:100% !important`
            # 摊开（内联是 80%）。这两条是"媒体查询到底生效没有"最直接的读数。
            check(f"{w}：窄屏媒体查询生效（输入框 16px、卡片摊满）",
                  m["inputFont"] == "16px" and m["cardRatio"] >= 0.9,
                  f"font={m['inputFont']} card={m['cardRatio']:.2f}")
        else:
            check(f"{w}：宽屏不吃窄屏那档覆盖（输入框仍是 1.5rem、卡片仍是 80% 上下）",
                  m["inputFont"] == "24px" and m["cardRatio"] <= 0.85,
                  f"font={m['inputFont']} card={m['cardRatio']:.2f}")
        pg.close()
        all_errs.extend(errs)

    # ── ⑩ 遮罩与药丸：背景压得够不够暗、字压在上面读不读得出来 ────────────────
    # 用户 20261013 原话：「检索框把背景暗度和迷糊度压得不够低，导致看不清检索框部分文本」。
    # 这个弹窗的**全部内容都没有自己的底**（`Modal.contentBg=transparent` + `.searchModal`
    # transparent），遮罩就是它的背景 ⇒ 底下那屏从遮罩的透明里透上来，字压在**忽明忽暗**的
    # 图案上。所以这里量两件东西：
    #   ① 遮罩这一层有没有真的被压暗/模糊（computed 值——这是**确定性**的读数）；
    #   ② 药丸里那行字底下的亮度**跳动幅度**（像素读数——"读起来累不累"的真身是它，
    #      不是平均对比度：修复前黑字压在 0.7 白药丸上本来就有 9.9:1）。
    #
    # 样板是**注入的纯黑白棋盘**（8px，约当正文的字级细节），不是沙箱里那点内容：
    # 沙箱 Head 后面本来是一片空白，量什么都是 0.01（实测），那种判据看着绿、其实什么都没测。
    # 棋盘是全对比度的最坏情况 ⇒ 读数是"上界"，只许比这更好。
    #
    # ⚠️ `backdrop-filter` 的**像素**读数在这个无头环境里不可用：实测 blur(2px) 生效
    #    （相邻跳变 6.59→2.72），而 blur(10px)/blur(30px) 反而退回**没有模糊**的样子
    #    （6.19 / 5.04，棋盘原样透出来）—— 这是渲染器的降级，不是页面的毛病。所以模糊只按
    #    computed 值判，"压暗"按像素判（像素那边把模糊临时摘掉，两臂都摘，读数才可比）。
    print("\n⑩ 遮罩：压暗 + 模糊都写在真渲染上；药丸里的字压在可读的底上")
    pg, errs = open_modal(br)
    pg.fill(".searchModalInput", "Hello world 123")   # 本机无中文字体 ⇒ 用 ASCII 才量得到真字形
    pg.wait_for_timeout(700)

    # ⚠️ 先读 computed、**再**注入样板与覆盖：下面那一段会把 `backdrop-filter` 内联成 none
    #    （像素两臂都摘掉模糊），读晚了就永远读到 'none' —— 这个顺序是判据的一部分。
    cs = pg.evaluate("""() => {
        const m = document.querySelector('.ant-modal-mask');
        const s = getComputedStyle(m);
        const i = getComputedStyle(document.querySelector('.searchModalInput'));
        return { cls: m.className, bg: s.backgroundColor, bf: s.backdropFilter || s.webkitBackdropFilter,
                 pill: i.backgroundColor, ink: i.color };
    }""")
    alpha = float((cs["bg"].split(",")[3] or "1").strip(" )")) if "," in cs["bg"] else 1.0
    check("遮罩挂上了 .search-mask（classNames.mask 真的落到那一层上）",
          "search-mask" in cs["cls"], cs["cls"])
    check("遮罩底色比 antd 出厂值（0.45）更暗（alpha ≥ 0.6，且没被 antd 的运行时样式盖掉）",
          alpha >= 0.6, f'{cs["bg"]} alpha={alpha}')
    check("遮罩带模糊（backdrop-filter 里有 blur(≥8px)）",
          "blur(" in cs["bf"] and float(cs["bf"].split("blur(")[1].split("px")[0]) >= 8,
          repr(cs["bf"]))
    check("药丸仍是半透明（没被改成一坨实心白）",
          0.7 <= float(cs["pill"].split(",")[3].strip(" )")) < 1.0, cs["pill"])

    # 遮罩底下铺一张纯黑白棋盘（8px）：位置固定、全对比度，量的是"背景能透上来多少"
    pg.evaluate("""() => {
        const d = document.createElement('div');
        d.id = '__checker';
        d.style.cssText = 'position:fixed;left:0;top:0;right:0;height:600px;z-index:1;' +
          'background-image:repeating-conic-gradient(#000 0% 25%, #fff 0% 50%);background-size:8px 8px;';
        document.body.appendChild(d);
        // 模糊在这个渲染器里对大半径会降级（见上面注释）⇒ 像素那一半的两臂都摘掉它，
        // 免得"这一臂模糊生效、那一臂没生效"把读数搞乱。
        document.querySelector('.ant-modal-mask').style.backdropFilter = 'none';
    }""")
    pg.wait_for_timeout(250)

    from PIL import Image  # noqa: E402  （与 live2d-render.test.py 同一处依赖）
    import io  # noqa: E402

    def shot(p, box):
        return Image.open(io.BytesIO(p.screenshot(clip=box))).convert("L")

    def wcag(v1, v2):
        f = lambda v: (((v / 255) + 0.055) / 1.055) ** 2.4 if v / 255 > 0.03928 else (v / 255) / 12.92
        a, b = f(v1), f(v2)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)

    r = pg.evaluate("() => document.querySelector('.searchModalInput').getBoundingClientRect().toJSON()")

    def band_box():
        """药丸里**没有字**的一条横带（避开文字中线与两端的圆角）。"""
        return {"x": int(r["x"] + r["width"] * 0.15), "y": int(r["y"] + r["height"] * 0.78),
                "width": int(r["width"] * 0.70), "height": int(r["height"] * 0.12)}

    def spread(bbox):
        d = sorted(shot(pg, bbox).getdata())
        return d[-1] - d[0], d[len(d) // 2]

    w_now, mid_now = spread(band_box())
    # 字那一块：取最暗的 2% 当"墨"，与**同一张图**的中位色比 —— 字与底在同一张图里，
    # 不受"页面底色到底算哪一层"影响（这是 login-modal 那套 `__probe` 的教训）。
    ink_box = {"x": int(r["x"] + 30), "y": int(r["y"] + 8),
               "width": int(r["width"] - 60), "height": int(r["height"] - 16)}
    ink_px = sorted(shot(pg, ink_box).getdata())
    ink = ink_px[max(0, int(len(ink_px) * 0.02))]
    ratio = wcag(ink, mid_now)
    print(f"     （药丸底 中位={mid_now} 带宽={w_now}/255；字墨={ink}；字/底对比 {ratio:.1f}:1）")
    check("药丸里那行字的对比度 ≥ 4.5:1", ratio >= 4.5, f"{ratio:.2f}:1")
    check("字底下的亮度跳动压住了（最坏样板下带宽 ≤ 22/255；修复前是 42）",
          w_now <= 22, f"{w_now}/255")

    # 正控：把遮罩退回 antd 的出厂值 0.45（只改这一个属性），带宽**必须**变大——
    # 否则这个读数是死的（"改回去也照样绿"＝判据没接在这件事上）。
    pg.evaluate("() => {document.querySelector('.ant-modal-mask').style.background='rgba(0,0,0,0.45)';}")
    pg.wait_for_timeout(250)
    w_ctl, _ = spread(band_box())
    check("正控：遮罩退回 0.45 时带宽明显变大（读数接在遮罩上，不是恒绿）",
          w_ctl > w_now + 6, f"0.45 → {w_ctl}/255 vs 0.62 → {w_now}/255")
    # 正控二：药丸退回 0.7（只改这一个属性）——它这一层对读数的贡献比遮罩还大
    pg.evaluate("""() => {
        document.querySelector('.ant-modal-mask').style.background='';
        document.querySelector('.searchModalInput').style.background='rgba(255,255,255,0.7)';
    }""")
    pg.wait_for_timeout(250)
    w_ctl2, _ = spread(band_box())
    check("正控：药丸退回 0.7 时带宽也变大", w_ctl2 > w_now + 4,
          f"0.7 → {w_ctl2}/255 vs 0.82 → {w_now}/255")
    pg.screenshot(path="/tmp/site-search-mask.png")
    pg.close()
    all_errs.extend(errs)

    print("\n⑨ 全程无 JS 报错")
    check("无 pageerror", not all_errs, "; ".join(all_errs[:3]))
    br.close()

_server.shutdown()
shutil.rmtree(SANDBOX, ignore_errors=True)
print("\n" + ("全部通过" if not FAILS else f"失败 {len(FAILS)} 项：" + "; ".join(FAILS)))
sys.exit(1 if FAILS else 0)
