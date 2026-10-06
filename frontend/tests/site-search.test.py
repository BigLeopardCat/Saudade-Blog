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

    窄屏这里**直接点抽屉里的 `.mSearchInput`**，跳过"先点汉堡钮拉开抽屉"那一步：
    汉堡钮是个 iconfont 字形（`<i class="iconfont icon-bars">`），沙箱引不到那套字体
    ⇒ 它是 0×0 的盒子，点不到；抽屉本身的几何又长在 `pages/Dashboard/Home/index.sass`
    （本沙箱没编译它）。跳过的只是"拉开抽屉"这个动画，`.mSearchInput` 的 onClick
    （`closePhoneBar(); showModal();`）与线上是**同一个**，弹窗那部分不经过任何简化。
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
        p.wait_for_selector(".mSearchInput", timeout=15000)
        p.wait_for_timeout(500)
        p.locator(".mSearchInput").click()   # 抽屉里那个只读搜索框 = 窄屏入口（见上面的说明）
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

    print("\n⑨ 全程无 JS 报错")
    check("无 pageerror", not all_errs, "; ".join(all_errs[:3]))
    br.close()

_server.shutdown()
shutil.rmtree(SANDBOX, ignore_errors=True)
print("\n" + ("全部通过" if not FAILS else f"失败 {len(FAILS)} 项：" + "; ".join(FAILS)))
sys.exit(1 if FAILS else 0)
