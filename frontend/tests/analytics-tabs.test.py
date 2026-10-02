# -*- coding: utf-8 -*-
"""后台「数据统计」页的无头验收：真组件 + 真 antd + 假后端。

20261001 这一轮把这一页从"一张假的月更折线 + 一张假饼图"改成了**两个页签**：
  · 文章数据 —— 阅读量 / 点赞量 / 收藏量 / 讨论量（四个汇总卡 + 四个榜 + 30 天趋势）
    + **周报 / 月报 / 年报**（按期一张可展开的列表）；
  · 用户活跃 —— 直接渲染 `GET /api/protected/stats/users`。

这些东西里**只有真跑一遍才看得见**的占大多数：
  · 页标题上那条波浪线（`text-decoration: underline wavy`）删没删干净——
    是 computedStyle，不是源码文本；
  · 切粒度到底发没发对请求（`kind` / `limit` 有没有跟着走）——
    只有桩里记的请求条数说了算；
  · **`since` 为 null 与"统计了但都是 0"** 是两件事，界面上必须分开说——
    前者是「还没有统计数据」的空态，后者是一行行的 0；写错了从界面上看不出来；
  · 「部分统计」那枚 Tag 只在 `partial` 期上出现（上线那一周只有半截数据，
    不标出来会被读成"那周流量掉了"）。

沿用既定手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把**真组件**打成一个
bundle、只桩 axios 这一个边界；sass 用 programmatic API 单独编译。
本机无中文字体（截图里汉字是豆腐块），断言全走数值与请求，不受影响。

用法：python3 frontend/tests/analytics-tabs.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/@ant-design/plots/recharts）、playwright(python)。
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

# ── 假后端 ────────────────────────────────────────────────────────────────────
# 三份数据刻意做出**三处不同的边界情形**，判据才不是空转：
#   · 文章报表：四个榜各有内容，总数非零；
#   · 期报：week 三期（第一期 partial）、month 一期、year **since=null**（一行记录都没有）
#     —— 这正是"空态 vs 一堆 0"那条判据要的输入；
#   · 用户报表：明细里留一行 `lastActiveAt: null`（"无活动"要显示成文字而不是空白）。
FAKE_AXIOS = r"""
const calls: any[] = (window as any).__calls = [];

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });

const rank = (n: number, base: number) => Array.from({ length: 5 }, (_, i) => ({
  noteId: 100 + i, title: '示例文章 ' + (i + 1) + '（标题长一点，验证省略号）',
  views: base - i * n, likes: base - i * n - 1, favorites: base - i * n - 2,
  comments: (base - i * n) % 7,
}));

const DAILY = Array.from({ length: 30 }, (_, i) => ({
  date: '2026-09-' + String(i + 1).padStart(2, '0'),
  views: i * 3, likes: i % 5, favorites: i % 3, comments: i % 4,
}));

const REPORT = {
  generatedAt: '2026-10-01 12:00',
  totalViews: 1234, totalLikes: 56, totalFavorites: 7, totalComments: 19,
  topViewed: rank(10, 500), topLiked: rank(2, 40), topFavorited: rank(1, 20),
  topCommented: rank(3, 30),
  daily: DAILY,
};

// 期报：三个粒度各给一份，**year 是 since=null**（没有数据的那一档）
const PERIODS: any = {
  week: {
    generatedAt: '2026-10-01 12:00', kind: 'week', since: '2026-09-28',
    periods: [
      { key: '2026-W40', label: '2026 年第 40 周', start: '2026-09-28', end: '2026-10-04',
        partial: true, views: 300, likes: 12, favorites: 3, comments: 8,
        topNotes: rank(5, 100) },
      { key: '2026-W39', label: '2026 年第 39 周', start: '2026-09-21', end: '2026-09-27',
        partial: false, views: 280, likes: 9, favorites: 1, comments: 5,
        topNotes: rank(4, 90) },
      { key: '2026-W38', label: '2026 年第 38 周', start: '2026-09-14', end: '2026-09-20',
        partial: false, views: 0, likes: 0, favorites: 0, comments: 0, topNotes: [] },
    ],
  },
  month: {
    generatedAt: '2026-10-01 12:00', kind: 'month', since: '2026-09-28',
    periods: [
      { key: '2026-10', label: '2026 年 10 月', start: '2026-10-01', end: '2026-10-31',
        partial: true, views: 42, likes: 3, favorites: 1, comments: 2, topNotes: rank(3, 30) },
    ],
  },
  year: { generatedAt: '2026-10-01 12:00', kind: 'year', since: null, periods: [] },
};

const USERS = {
  generatedAt: '2026-10-01 12:00',
  roleCounts: [{ role: 'admin', count: 1 }, { role: 'user', count: 3 }],
  totalUsers: 4, totalConversations: 9, totalMessages: 88, totalExecutions: 12,
  totalComments: 19,
  activeUsers7d: 2, activeUsers30d: 3, listedUsers: 2,
  users: [
    { id: 1, name: '管理员', role: 'admin', conversations: 6, messages: 70, comments: 11,
      lastActiveAt: '2026-10-01 11:30' },
    { id: 2, name: '用户#2', role: 'user', conversations: 3, messages: 18, comments: 0,
      lastActiveAt: null },
  ],
};

const http = async (cfg: any) => {
  const url = cfg.url as string;
  const params = cfg.params || {};
  calls.push({ url, params });
  if (url === '/api/protected/stats/notes') return env(REPORT);
  if (url === '/api/protected/stats/notes/periods') return env(PERIODS[params.kind] || PERIODS.week);
  if (url === '/api/protected/stats/users') return env(USERS);
  return env(null);
};
export default http;
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Analytics from './src/pages/Dashboard/Analytics/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Analytics />);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="analytics-verify-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # sass 单独编译（组件里 `import './index.sass'` 由 --loader:.sass=text 收下）
    out = sb / "analytics.css"
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / "src/pages/Dashboard/Analytics/index.sass"), str(out)],
                   cwd=str(FE), check=True)

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        # 宽容解码：esbuild 会在中文那行按字节截断，严格 utf-8 解会先炸在解码上、盖住真报错
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body,#root{height:100%;margin:0}</style>'
        '<style>' + out.read_text() + '</style></head><body><div id="root"></div>'
        '<script src="bundle.js"></script>'
        '<script>window.__mount();</script></body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"


def mount(br):
    page = br.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL)
    page.wait_for_selector(".analyticsBody .ant-tabs", timeout=15000)
    page.wait_for_timeout(600)
    page.errs = errs
    return page


with sync_playwright() as p:
    br = p.chromium.launch()
    pg = mount(br)

    # ── 一、页标题与页签 ──────────────────────────────────────────────────────
    print("\n【一】页标题「数据统计」与两个页签")
    head = pg.evaluate("""() => {
        const h2 = document.querySelector('.analyticsBody .akTitle');
        const cs = getComputedStyle(h2);
        return { text: h2.textContent.trim(),
                 deco: cs.textDecorationLine || cs.textDecoration,
                 tabs: [...document.querySelectorAll('.analyticsBody .ant-tabs-tab')]
                        .map((t) => t.textContent.trim()),
                 active: (document.querySelector('.analyticsBody .ant-tabs-tab-active') || {}).textContent };
    }""")
    check("页标题是「数据统计」", head["text"] == "数据统计", head["text"])
    # 波浪线就是 `text-decoration-line: underline` + `text-decoration-style: wavy`。
    # 判 `wavy` 而不是判 `underline`：某天有人改成实线下划线也值得再看一眼，但**波浪**是
    # 用户点名要删的那个。
    check("标题上没有波浪线了", "wavy" not in head["deco"], head["deco"])
    check("两个页签：文章数据 / 用户活跃",
          head["tabs"] == ["文章数据", "用户活跃"], str(head["tabs"]))
    check("默认落在「文章数据」", head["active"] == "文章数据", str(head["active"]))

    # ── 二、文章数据页：四个汇总卡 + 四个榜 ────────────────────────────────────
    print("\n【二】文章数据：阅读量 / 点赞量 / 收藏量 / 讨论量")
    cards = pg.evaluate("""() => [...document.querySelectorAll('.analyticsBody .akCard .ant-statistic-title')]
        .map((el) => el.textContent.trim())""")
    check("四个汇总卡：总阅读量 / 总点赞量 / 总收藏量 / 总讨论量",
          cards == ["总阅读量", "总点赞量", "总收藏量", "总讨论量"], str(cards))
    panels = pg.evaluate("""() => [...document.querySelectorAll('.analyticsBody .akPanel > h3')]
        .map((el) => el.textContent.trim())""")
    check("四个榜单在位",
          [t for t in panels if t.startswith(('阅读量 Top', '点赞量 Top', '收藏量 Top', '讨论量 Top'))]
          == ["阅读量 Top 10", "点赞量 Top 10", "收藏量 Top 10", "讨论量 Top 10"], str(panels))
    lines = pg.evaluate("""() => {
        const canvas = document.querySelector('.analyticsBody .akChart canvas');
        return { hasChart: !!canvas, w: canvas ? canvas.width : 0 };
    }""")
    check("趋势图画出来了（有 canvas）", lines["hasChart"] and lines["w"] > 0, str(lines))

    # ── 三、期报列表：折叠态 / 展开态 / partial 标记 ───────────────────────────
    print("\n【三】周报列表与展开")
    rows = pg.evaluate("""() => [...document.querySelectorAll('.analyticsBody .akPeriodList .ant-collapse-item')]
        .map((el) => ({
            label: el.querySelector('.akPeriodLabel').textContent.trim(),
            nums: el.querySelector('.akPeriodNums').textContent.replace(/\\s+/g, ' ').trim(),
            partial: !!el.querySelector('.akPartial'),
        }))""")
    check("列出了三期（后端给了三期）", len(rows) == 3, str(len(rows)))
    check("行上带四个数（阅读/点赞/收藏/讨论）",
          all(all(k in r["nums"] for k in ('阅读', '点赞', '收藏', '讨论')) for r in rows),
          str(rows[0]["nums"]) if rows else "")
    check("只有标记 partial 的那一期挂「部分统计」",
          [r["partial"] for r in rows] == [True, False, False], str([r["partial"] for r in rows]))
    check("第三期（本期零数据）仍然列出来 —— 零是「真零」，不是「没统计」",
          rows[2]["label"].startswith("2026 年第 38 周"), rows[2]["label"] if rows else "")

    # 展开第一期之前，正文（那 5 行标题）不该在页面上
    before = pg.evaluate("() => document.querySelectorAll('.analyticsBody .akPeriodList .ant-collapse-content-active').length")
    check("默认全部折叠", before == 0, f"展开中的面板 {before} 个")
    pg.locator(".analyticsBody .akPeriodList .ant-collapse-header").first.click()
    pg.wait_for_timeout(500)
    opened = pg.evaluate("""() => {
        const box = document.querySelector('.analyticsBody .ant-collapse-content-active');
        if (!box) return null;
        return {
            n: box.querySelectorAll('.akRank li').length,
            first: (box.querySelector('.akRankTitle') || {}).textContent,
            nums: (box.querySelector('.akRankNums') || {}).textContent.replace(/\\s+/g, ' ').trim(),
        };
    }""")
    check("展开第一期后出现榜单正文", bool(opened) and opened["n"] == 5, str(opened and opened["n"]))
    check("正文里的标题是完整标题（不是图表里的截断）",
          bool(opened) and "示例文章 1" in (opened["first"] or ""), str(opened and opened["first"]))
    check("期报正文每行带四个数",
          bool(opened) and all(k in opened["nums"] for k in ("阅读", "点赞", "收藏", "讨论")),
          str(opened and opened["nums"]))

    # 第三期（零数据）展开后要说"没有数据"，而不是空面板
    pg.locator(".analyticsBody .akPeriodList .ant-collapse-header").nth(2).click()
    pg.wait_for_timeout(500)
    empty_txt = pg.evaluate("""() => {
        const items = [...document.querySelectorAll('.analyticsBody .akPeriodList .ant-collapse-item')];
        const box = items[2].querySelector('.ant-collapse-content-active');
        return box ? box.textContent.replace(/\\s+/g, ' ').trim() : '';
    }""")
    check("零数据那一期展开后明说「没有数据」", "没有数据" in empty_txt, empty_txt[:40])

    # ── 四、切粒度：请求参数必须跟着走 ─────────────────────────────────────────
    print("\n【四】周报 / 月报 / 年报 切换")
    pg.locator(".analyticsBody .ant-segmented-item", has_text="月报").click()
    pg.wait_for_timeout(600)
    last = pg.evaluate("() => window.__calls[window.__calls.length - 1]")
    check("切「月报」发出了 kind=month&limit=12",
          last["params"].get("kind") == "month" and int(last["params"].get("limit")) == 12,
          str(last["params"]))
    n_month = pg.evaluate("() => document.querySelectorAll('.analyticsBody .akPeriodList .ant-collapse-item').length")
    check("月报只剩一期（后端给几期就渲染几期）", n_month == 1, str(n_month))

    pg.locator(".analyticsBody .ant-segmented-item", has_text="年报").click()
    pg.wait_for_timeout(600)
    last = pg.evaluate("() => window.__calls[window.__calls.length - 1]")
    check("切「年报」发出了 kind=year&limit=5",
          last["params"].get("kind") == "year" and int(last["params"].get("limit")) == 5,
          str(last["params"]))
    # since=null ⇒ **一行记录都还没有**，此时必须走空态，绝不能渲染一行行的 0
    year = pg.evaluate("""() => ({
        rows: document.querySelectorAll('.analyticsBody .akPeriodList .ant-collapse-item').length,
        txt: document.querySelector('.analyticsBody .akPeriods').textContent.replace(/\\s+/g, ' ').trim(),
    })""")
    check("since=null 时不渲染任何期行", year["rows"] == 0, f'rows={year["rows"]}')
    check("since=null 时给的是「还没有统计数据」空态（**不是**一排 0）",
          "还没有统计数据" in year["txt"], year["txt"][:60])

    # ── 五、用户活跃页签 ──────────────────────────────────────────────────────
    print("\n【五】用户活跃页签")
    n_before = pg.evaluate("() => window.__calls.length")
    pg.locator(".analyticsBody .ant-tabs-tab", has_text="用户活跃").click()
    pg.wait_for_timeout(900)
    calls = pg.evaluate("() => window.__calls.slice(%d).map((c) => c.url)" % n_before)
    check("切过去才发请求（且打的是 stats/users）",
          calls == ["/api/protected/stats/users"], str(calls))
    # 留在 DOM 里 ≠ 看得见。非活动页签必须**真的被藏起来**——这条钉的是 sass 里
    # 记的那个坑：`.analyticsBody .ant-tabs-tabpane { display:flex }`（0,2,0）
    # 会盖过 antd 的 `.ant-tabs-tabpane-hidden { display:none }`（0,1,0），
    # 两个页签的内容会**同时**铺在屏幕上（间距交给内层 `.akPane` 正是为躲开它）。
    hidden = pg.evaluate("""() => {
        const panes = [...document.querySelectorAll('.analyticsBody .ant-tabs-tabpane')];
        return panes.map((el) => getComputedStyle(el).display);
    }""")
    # 判据是"**有且只有一个**页签看得见"，不写死另一个的值：antd 自己没给
    # `.ant-tabs-tabpane` 定 display（就是 `block`），而本页的排版在更里面的 `.akPane`。
    check("有且只有一个页签可见（非活动的那个 display:none）",
          hidden.count("none") == 1 and len(hidden) == 2, str(hidden))
    # ⚠️ 必须**限定在活动页签内**：antd 的 Tabs 默认 `destroyInactiveTabPane=false`，
    # 头一个页签进过一次就留在 DOM 里（只是 `display:none`）。不加这层会一次数到
    # 十一个卡（文章数据那四个 + 这里七个），看起来像"多渲染了"，其实是对面那个页签。
    u_cards = pg.evaluate("""() => [...document.querySelectorAll(
            '.analyticsBody .ant-tabs-tabpane-active .akCard .ant-statistic-title')]
        .map((el) => el.textContent.trim())""")
    check("七张汇总卡（活跃 7 天/30 天 + 用户/会话/消息/执行/讨论）",
          u_cards == ["活跃用户（7 天）", "活跃用户（30 天）", "用户总数", "总会话数", "总消息数", "总执行数", "总讨论数"],
          str(u_cards))
    table = pg.evaluate("""() => {
        const rows = [...document.querySelectorAll('.analyticsBody .ant-table-tbody tr.ant-table-row')];
        return {
            n: rows.length,
            last: rows.map((r) => r.lastElementChild.textContent.trim()),
            head: [...document.querySelectorAll('.analyticsBody .ant-table-thead th')].map((t) => t.textContent.trim()),
        };
    }""")
    check("明细两行都在", table["n"] == 2, str(table["n"]))
    # `lastActiveAt: null` 必须显示成文字 —— 空白会被读成"渲染坏了"（stats.rs 的口径原话）
    check("无活动的用户显示「无活动」而不是空白", table["last"][1] == "无活动", str(table["last"]))
    check("表头是活动口径那几列（讨论数在第 5 列，最近活动仍是最后一列）",
          table["head"] == ["用户", "角色", "会话数", "消息数", "讨论数", "最近活动"], str(table["head"]))

    check("全程无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()
    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 后台数据统计页：全部通过")
