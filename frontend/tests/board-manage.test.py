# -*- coding: utf-8 -*-
"""后台「评论管理」页（BoardManage）20260926 那批改动的无头验收：真组件 + 真 antd + 假后端。

这一批三件事，判据都只有"真跑一遍"才看得见：

  · **「AI 审核」列的 tooltip 带上 aiReason 全文** —— 此前那一列只显示裁决词，AI 的说明
    在整个系统里只存在于 AI 服务那一次的 HTTP 响应里。**两侧都要验**：有 aiReason 的行
    hover 出来的 tooltip 里含那句全文；aiReason 为 null 的行，tooltip **照常出现**（先断
    它真挂出来了，否则下一条是空转）但里面**没有** .bm-ai-reason 那一块。只验一侧会被
    "永远显示（占位/空串）"的实现蒙过。
  · **理由必填** —— 文本框空（或只有空白）时「确认驳回」禁用，点它**一个写请求都不发**。
    "必填"锁的是行为（disabled + 零请求），不锁那句话的写法。
  · **常见违规类型预设 / 采用 AI 说明** —— 点一下把文案填进**可编辑**的文本框；「采用 AI
    说明」只在**这一行**有 aiReason 时出现。"可编辑"不能只看 readOnly 属性：填一个自定义
    值、看主按钮跟着变可用，才证明它真接回了 state（只读回显也能把值显示出来）。
  · **已有理由的回显 + 沿用** —— 弹窗里多一行回显（含那条已有理由原文）与一个「沿用」按钮。
  · **跨端同步**（第八节，用户报「评论状态变更前端跟不上 agent，也要刷新网页」）—— 看板娘
    一轮收尾的事件到达 ⇒ 这一页自己多拉一次列表；驳回弹窗开着时那一次不许拉；手动「刷新」
    按钮照旧给 loading 反馈，背景那一次不给。`utils/liveRefresh.ts` 的四条纪律由模块级
    `live-refresh.test.mjs` 锁，本节锁的是**这一页真的接了它、而且接对了**。
  · **已通过的留言也能驳回**（20260930，第七③节）—— 此前 `approved === 1` 的行操作区只有
    「删除」，改不了结论；现在挂上同一个驳回入口（同一档 `audit(id, 0, reason)`、同一个
    「理由必填」弹窗），点完那一行当场翻成「未通过」。后端 `audit_board` 从来没有状态守卫
    （只查登录/存在性/`src=="board"`），所以这一改的**全部风险面就在这排按钮的渲染条件 +
    本地写回**上，两处都在本文件里被判。注意这与"通过与否决是一对互斥入口"是**两件事**：
    互斥指的是"同一行不会同时给出两颗方向相反的立即动作按钮"，而改判入口在每一档恰好一个
    （待审/已通过 → 驳回；已驳回 → 恢复通过）。

驳回请求的契约是 `PUT /api/protect/board/<id>/audit`、body **严格等于**
`{approved: 0, reason: "<填的值>"}`——键集合也要对（多传/少传都算红）。注意 approved 传的是
**0**（"驳回"这个动作码），不是落库的 2：后端 `audit_board`（src/routes/talks.rs:670）把
`approved == 0` 翻成写 `approved = 2`「未通过」。所以断言必须按**请求**那一侧的契约写。

沿用既定手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把真组件打成 bundle，
只桩一个边界（`src/apis/axios.tsx`）；sass 用 programmatic API 单独编译后 `--loader:.sass=text`
收下（顺带让这个文件过一次编译——本机唯一拦得下构建级缺陷的环节）。两个必踩的坑写在下面：
假响应一律走**深拷贝**（把同一个数组引用丢回去会被 React 的 Object.is 判等拦下、界面纹丝
不动，症状是"请求成功了但行没动"），以及 antd 的 autoInsertSpace 会在两个汉字之间插空格
（「驳 回」/「沿 用」）⇒ 认定按钮文案前一律抹空白。本机无中文字体（汉字渲染成豆腐块），
断言全走数值、条数与请求体。

用法：python3 frontend/tests/board-manage.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)。
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

# ── 夹具与契约值（Python 侧；JS 侧 FAKE_AXIOS/ENTRY 里各有一份同名的，改一处要一起改）──
REJECT_ROWS = ["驳回靶子A", "驳回靶子B", "驳回靶子C", "驳回靶子D"]  # approved=0
PASS_ROWS = ["通过甲", "通过乙", "通过丙", "通过丁"]                # approved=1
BAD_ROWS = ["已驳回甲", "已驳回乙"]                                  # approved=2
CONTENTS = REJECT_ROWS + PASS_ROWS + BAD_ROWS
AI_A = "疑似广告引流：正文带站外链接 spam.example"   # 驳回靶子A 的 aiReason
REASON_C = "这条留言与灯的主题无关"                  # 驳回靶子C 已有的 rejectReason
REASON_BAD = "广告刷屏，与灯无关"                    # 已驳回甲 已有的 rejectReason
PRESETS = ["广告引流", "色情低俗", "辱骂攻击", "违法敏感", "恶意外链", "与留言板无关", "内容难以辨认"]


def nz(s):
    """抹掉所有空白再比：antd 的 autoInsertSpace 会在两个汉字之间插空格（「驳 回」），
    不抹的话判的是 antd 的排版而不是我们的文案。"""
    return re.sub(r"\s+", "", s or "")


FAKE_AXIOS = r"""
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
// ⚠️ 每次 GET 都必须回**深拷贝**：真 HTTP 每次都反序列化出一个新对象，而这里面的数组是
// 同一个引用 ⇒ `setItems(同一个引用)` 会被 React 的 Object.is 判等拦下、**不触发重渲染**，
// 症状是"请求成功了但界面纹丝不动"。
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ⚠️ 必须是**带方法的对象**，不能是裸函数：真实 `src/apis/axios.tsx` 导出的是
// `axios.create()` 出来的实例，调用方写的是 `http.get(...)`/`http.put(...)`。
// 做成裸函数时 `http.get` 是 undefined ⇒ 组件里 `try{ await http.get() }catch{}`
// 把 TypeError 静静吃掉（只弹一条 message.error），**桩里一条记录都没有**。
const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: wire(cfg.data) });
  await delay(20);
  // 列表：回**假后端那一份**（页数/条数/各行字段都从它派生，断言才是数据驱动的）
  if (url === '/api/protect/board') {
    // 第八节用：把**这一次**响应扣在手里，好让"请求在途"那一段足够长、断言落得进去
    // （`delay(20)` 那 20ms 靠 evaluate 的往返去撞，是在赌时序）。扣一次就自动清掉。
    const h = (window as any).__holdNext;
    if (h) { (window as any).__holdNext = null; await h; }
    return env(wire((window as any).__board));
  }
  if (url === '/api/protected/websetting') {
    // 人工复核开着：这不是随手挑的取值——"待审行带 AI 判定/AI 说明"这种状态**只在它开着时
    // 才产生**（src/routes/talks.rs:444 的 `let approved = if manual_on { 0 } else { 2 }`），
    // 关着的话整个夹具那些行在库里就不该存在。它只影响几处 tooltip 的措辞（本文件不断言）。
    return env({ aiReviewEnabled: false, manualReviewEnabled: true });
  }
  // 人工裁决。真后端把 approved==0 翻成写 approved=2（见 src/routes/talks.rs::audit_board），
  // 桩只回成功、不回写——这一页锁的是**请求**那一侧的契约（body 形状见第五节）。
  if (/^\/api\/protect\/board\/\d+\/audit$/.test(url)) return env('Audited');
  return env(null);
};

const http = {
  get: (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' }),
  post: (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' }),
  put: (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' }),
  delete: (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' }),
};
export default http;
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import BoardManage from './src/pages/Dashboard/BoardManage/index.tsx';

// ── 假后端的数据（10 条 = 正好一页，每页 10）──────────────────────────────────
// 四种行各有用途，缺一种就有断言落空：
//   · 待审 4 行（approved=0）：AI 说明有/无 × 已有理由有/无 —— 三个"亮灭取决于数据"
//     的判据各要两侧（「采用 AI 说明」、弹窗里的理由回显与沿用）
//   · 通过 4 行（approved=1）：操作列该只有「删除」，没有「驳回」入口
//   · 已驳回 2 行（approved=2）：列表里回显驳回理由；没写理由的那一行不许把 null 打出来
const AI_A = '疑似广告引流：正文带站外链接 spam.example';
const REASON_C = '这条留言与灯的主题无关';
const REASON_BAD = '广告刷屏，与灯无关';
const mk = (i: number, o: any) => ({
  talkKey: 1000 + i,
  content: 'x', cat: ['愿', '寄', '忆', '诉'][i % 4], v: i % 3,
  author: '留名' + (i + 1),
  createTime: '2026-09-' + String(20 + i) + ' 10:00:00',
  userId: 700 + i, username: 'u' + i, nickname: '昵称' + i,
  approved: 0, ai_result: null, aiReason: null, rejectReason: null,
  ...o,
});
const BOARD = [
  mk(0, { content: '驳回靶子A', ai_result: 'flag', aiReason: AI_A }),
  mk(1, { content: '驳回靶子B' }),
  // 「待审 + 已有理由」这一档的真实来源（src/routes/talks.rs:444-449）：AI 判 reject 而
  // 人工复核也开着 ⇒ approved 落 0（待审）、reject_reason 先留着（人工若也驳回、手填
  // 为空就回落到它）。所以这一行必须是 ai_result='reject'，不能是 'pass'——'pass' 那一支
  // 的 reject_reason 恒为 None，那个组合在库里根本不存在。
  mk(2, { content: '驳回靶子C', ai_result: 'reject',
          aiReason: 'AI 说明B：看不出与灯的主题有什么关联', rejectReason: REASON_C }),
  mk(3, { content: '驳回靶子D' }),
  mk(4, { content: '通过甲', approved: 1, ai_result: 'pass' }),
  mk(5, { content: '通过乙', approved: 1, ai_result: 'reject' }),
  mk(6, { content: '通过丙', approved: 1, ai_result: null }),
  mk(7, { content: '通过丁', approved: 1, ai_result: 'pass' }),
  mk(8, { content: '已驳回甲', approved: 2, ai_result: 'reject', rejectReason: REASON_BAD }),
  mk(9, { content: '已驳回乙', approved: 2, ai_result: 'reject' }),
];
(window as any).__board = BOARD;
// 条数可换：用来证"行数是跟着响应走的"，不是恰好撞上 10
(window as any).__setBoardSize = (n: number) => { (window as any).__board = BOARD.slice(0, n); };
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<BoardManage />);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="board-manage-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # sass 必须单独编译（`--loader:.sass=empty/text` 都只是把样式吞掉，不会进页面）：
    # 这一轮 index.sass 也动过（弹窗里那三块），顺手让它过一次编译。
    sass_rel = "src/pages/Dashboard/BoardManage/index.sass"
    css_out = sb / "board.css"
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / sass_rel), str(css_out)], cwd=str(FE), check=True)
    css = css_out.read_text()

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body,#root{height:100%;margin:0}'
        # 真站在 frontend/src/frontHome/main.css 里有一条全局 `*{box-sizing:border-box}`，
        # 后台页面同样吃它；沙箱不照搬的话几何/滚动这类断言会在沙箱里失真。
        '*{box-sizing:border-box;margin:0;padding:0}</style>'
        '<style>' + css + '</style></head><body><div id="root"></div>'
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

# 弹窗一律按"当前**可见**的那一个"取：antd 关窗只是把 wrap 藏起来（display:none），
# DOM 留着 ⇒ 不带 `:visible` 的选择器会先撞上那个已关闭的壳。
VIS = ".ant-modal-wrap:visible"


def mount(br, board_n=None, size=(1440, 900)):
    """挂载页面。`board_n` 指定假后端返回几条（默认 10 = 整个夹具）。"""
    page = br.new_page(viewport={"width": size[0], "height": size[1]})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL)
    if board_n:
        page.evaluate("(n) => window.__setBoardSize(n)", board_n)
    page.evaluate("() => window.__mount()")
    try:
        page.wait_for_selector(".ant-table-row", timeout=10000)
    except Exception:
        # 等不到就别只说"超时"：把关键节点、行数、请求记录与页面异常一起打出来。
        # 本仓最像"选择器写错了"的那种事故其实是整页白屏（组件新接一条读
        # import.meta.env 的依赖链，或桩里缺一个导出）——那时只有这条能点出真因。
        print("  ⚠ 等不到 .ant-table-row，现场：")
        print("    " + page.evaluate("""() => JSON.stringify({
            root: document.getElementById('root').children.length,
            shell: !!document.querySelector('.BoardManage'),
            rows: document.querySelectorAll('.ant-table-row').length,
            axiosStub: window.__axiosStub === true,
            calls: (window.__calls || []).map((c) => c.method + ' ' + c.url),
        })"""))
        print("    页面异常：" + ("; ".join(errs[:3]) or "（无）"))
        raise
    page.wait_for_timeout(600)
    page.errs = errs
    return page


GEO_LIST = """() => {
    const nz = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
    const rows = [...document.querySelectorAll('.ant-table-row')];
    const cnt = (r, t) => [...r.querySelectorAll('button')].filter((b) => nz(b.textContent) === t).length;
    return {
        rows: rows.length,
        count: nz((document.querySelector('.bm-count') || {}).textContent),
        pagers: document.querySelectorAll('.bm-foot .ant-pagination-item').length,
        rowInfo: rows.map((r) => {
            const c = r.querySelector('.bm-content');
            const e = r.querySelector('.bm-reason');
            // 「人工审核」列（第 8 格 = 索引 7；第 1 格是「印章」）的标签文案——本地写回
            // 是否真的把那一行翻成「未通过」，唯一能看出来的地方（见第七节）。
            const mt = r.querySelector('td:nth-child(8) .ant-tag');
            return {
                content: c ? c.textContent : null,
                reject: cnt(r, '驳回'), pass: cnt(r, '通过'), restore: cnt(r, '恢复通过'),
                del_: cnt(r, '删除'),
                manualTag: mt ? nz(mt.textContent) : null,
                reason: e ? e.textContent : null,
                reasonNone: !!r.querySelector('.bm-reason-none'),
                text: r.textContent,
            };
        }),
    };
}"""


def by_content(g, content):
    """按留言正文取行（行序由 createTime 排序决定，夹具里刻意都不同 ⇒ 不靠行序断言）。"""
    for r in g["rowInfo"]:
        if r["content"] == content:
            return r
    return None


REJECT_DIALOG = """() => {
    const nz = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
    const w = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (x) => getComputedStyle(x).display !== 'none' && x.querySelector('.bm-reject-ok'));
    if (!w) return null;
    const q = (s) => { const e = w.querySelector(s); return e ? nz(e.textContent) : ''; };
    const ok = w.querySelector('.bm-reject-ok');
    const ta = w.querySelector('textarea');
    return {
        title: q('.ant-modal-title'),
        ok: ok ? nz(ok.textContent) : '',
        okDisabled: ok ? ok.disabled : null,
        body: q('.ant-modal-body'),
        taCount: w.querySelectorAll('textarea').length,
        taVal: ta ? ta.value : null,
        taReadOnly: ta ? (ta.readOnly || ta.disabled) : null,
        presets: [...w.querySelectorAll('.bm-reject-preset')].map((b) => nz(b.textContent)),
        useAi: !!w.querySelector('.bm-reject-use-ai'),
        reuse: !!w.querySelector('.bm-reject-reuse'),
        existing: q('.bm-reject-existing'),
    };
}"""


def dlg(pg):
    return pg.evaluate(REJECT_DIALOG)


def write_calls(pg):
    """本页发出的**写请求**（非 GET）。"禁用时一个请求都不能发"用它——只筛 PUT 会把
    "偷偷改走 POST"这类回退漏掉。"""
    return pg.evaluate("""() => window.__calls.filter((c) => c.method !== 'GET')
        .map((c) => ({ url: c.url, method: c.method, body: c.data }))""")


def audit_puts(pg):
    """本页发出的审核请求（PUT …/audit）。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'PUT' && /\\/audit$/.test(c.url))
        .map((c) => ({ url: c.url, method: c.method, body: c.data }))""")


def get_urls(pg):
    return pg.evaluate("() => window.__calls.filter((c) => c.method === 'GET').map((c) => c.url)")


def board_gets(pg):
    """本页发出的 `GET /api/protect/board` 次数（第八节的唯一判据）。"""
    return get_urls(pg).count("/api/protect/board")


def fire_agent_done(pg):
    """派发看板娘一轮收尾事件（`components/UserCenter/agentTurn.ts` 的
    `AGENT_TURN_DONE_EVENT = 'agent-turn-done'`，由 chat-stream.js 在流收尾时派发）。
    名字在这里是**字面量**：它一改，本节的断言就该跟着红——`live-refresh.test.mjs`
    第八节锁的是"三处同名"，那边锁常量与派发方，这边锁**这一页真的接了它**。"""
    pg.evaluate("() => window.dispatchEvent(new Event('agent-turn-done'))")


def hold_next_board(pg):
    """把下一次 `GET /api/protect/board` 的响应扣住，返回放行函数（见桩里 `__holdNext`）。"""
    pg.evaluate("""() => { window.__holdNext = new Promise((res) => { window.__releaseBoard = res; }); }""")

    def release():
        pg.evaluate("() => { const r = window.__releaseBoard; window.__releaseBoard = null; if (r) r(); }")

    return release


def spinning(pg):
    """表格的 loading 圈（antd Table 的 `loading` 落到 `.ant-spin-spinning`）。"""
    return pg.evaluate("() => document.querySelectorAll('.ant-spin-spinning').length")


def click_refresh(pg):
    """点工具栏的「刷新」按钮。按**整串文案**找（抹空白后相等）——与行内按钮同一条理由：
    antd 会把两个汉字渲染成「刷 新」，`has_text='刷新'` 恒不命中。找的是 `.bm-toolbar`
    里那一个，不会误撞弹窗/行内的按钮。"""
    pg.evaluate("""() => {
        const nz = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
        const b = [...document.querySelectorAll('.bm-toolbar button')]
            .find((x) => nz(x.textContent) === '刷新');
        if (!b) throw new Error('工具栏里没有「刷新」按钮');
        b.click();
    }""")


def _row_index(pg, content):
    return pg.evaluate("""(c) => [...document.querySelectorAll('.ant-table-row')]
        .findIndex((r) => { const e = r.querySelector('.bm-content'); return !!e && e.textContent === c })""",
                       content)


def row_loc(pg, content):
    i = _row_index(pg, content)
    if i < 0:
        raise SystemExit("找不到正文为「%s」的留言行（夹具或渲染变了）" % content)
    return pg.locator(".ant-table-row").nth(i)


def open_reject(pg, content):
    """打开某一行的驳回弹窗（已经开着就只读一次状态）。按**行内按钮的整串文案**找
    （抹空白后相等）——antd 会把两个汉字渲染成「驳 回」，`has_text="驳回"` 恒不命中。

    容忍"上一处缺陷把弹窗提前关掉了/根本没弹"：那时若照旧去点行上的按钮，会被弹窗的
    遮罩拦住、整段变成 playwright 超时，红得看不出红在哪。这里补开一个，好让后面
    每一条断言各自变红。"""
    if dlg(pg) is None:
        row_loc(pg, content).locator("button", has_text=re.compile(r"^驳\s*回$")).first.click()
        pg.wait_for_timeout(350)
    return dlg(pg)


def cancel_modal(pg):
    """点弹窗的取消（`.ant-modal-footer` 里第一个按钮，也就是 cancelText 那个）。
    弹窗已经不在（被前一处缺陷关掉了）就什么都不做——"取消零请求"那条断言照样成立，
    要红的是把它提前关掉的那一条。"""
    if dlg(pg) is not None:
        pg.locator(VIS + " .ant-modal-footer .ant-btn").first.click()
        pg.wait_for_timeout(350)


with sync_playwright() as p:
    br = p.chromium.launch()

    # ── 一、列表加载：行数与「驳回」入口 ──────────────────────────────────────
    print("\n【一】列表加载：行数 = 假后端返回的条数，驳回入口只给待审行")
    pg = mount(br)
    g = pg.evaluate(GEO_LIST)
    check("留言列表渲染出来了，行数 == 假后端返回的条数（10 条）", g["rows"] == 10,
          f'rows={g["rows"]}')
    check("「共 N 条留言」的计数与返回条数一致", g["count"] == "共10条留言", g["count"])
    check("每行的留言正文就是假后端那一份（不是空壳/写死的行）",
          sorted(r["content"] for r in g["rowInfo"]) == sorted(CONTENTS),
          str(sorted(r["content"] for r in g["rowInfo"])))
    check("列表只发了一次 GET /api/protect/board", get_urls(pg).count("/api/protect/board") == 1,
          str(get_urls(pg)))
    check("每行的操作区都有「删除」入口", all(r["del_"] == 1 for r in g["rowInfo"]),
          str([r["content"] for r in g["rowInfo"] if r["del_"] != 1]))
    # 「驳回」入口按状态给（20260930 起）：待审(0) 与**已通过(1)** 都有，未通过(2) 没有
    #（那一档给的是「恢复通过」）。已通过那档是 20260930 新增的能力：**把已经放行的留言
    # 收回来**——后端 handler 从来没有状态守卫（`audit_board` 只查登录/存在性/src=="board"），
    # 卡点一直只在这排按钮的渲染条件上。
    check("待审的 4 行各有一个「驳回」入口",
          all(by_content(g, c)["reject"] == 1 for c in REJECT_ROWS),
          str({c: by_content(g, c)["reject"] for c in REJECT_ROWS}))
    check("已通过的 4 行**也各有一个「驳回」入口**（20260930：已通过的可再驳回）",
          all(by_content(g, c)["reject"] == 1 for c in PASS_ROWS),
          str({c: by_content(g, c)["reject"] for c in PASS_ROWS}))
    check("未通过的 2 行没有「驳回」入口（那一档给的是「恢复通过」）",
          all(by_content(g, c)["reject"] == 0 for c in BAD_ROWS),
          str({c: by_content(g, c)["reject"] for c in BAD_ROWS}))
    check("待审的 4 行操作区是「通过」+「驳回」+「删除」",
          all(by_content(g, c)["pass"] == 1 and by_content(g, c)["restore"] == 0 for c in REJECT_ROWS),
          str({c: (by_content(g, c)["pass"], by_content(g, c)["restore"]) for c in REJECT_ROWS}))
    # 通过的 4 行：只留「驳回」（改判入口）——「通过」不能再点（那一下是空操作）、
    # 「恢复通过」是给未通过那档的。这三个计数一起判，防的是"顺手把三颗按钮都挂上去"。
    check("通过的 4 行操作区是「驳回」+「删除」（没有「通过」/「恢复通过」）",
          all(by_content(g, c)["pass"] == 0 and by_content(g, c)["reject"] == 1
              and by_content(g, c)["restore"] == 0 for c in PASS_ROWS),
          str({c: (by_content(g, c)["pass"], by_content(g, c)["reject"],
                   by_content(g, c)["restore"]) for c in PASS_ROWS}))
    check("未通过的 2 行操作区是「恢复通过」+「删除」",
          all(by_content(g, c)["restore"] == 1 and by_content(g, c)["pass"] == 0
              and by_content(g, c)["reject"] == 0 for c in BAD_ROWS),
          str({c: by_content(g, c)["restore"] for c in BAD_ROWS}))
    check("第一节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # 行数必须是**跟着响应走**的：换一份 4 条的响应，行数与计数一起变（否则上面那条
    # "10 行"可能只是恰好等于每页条数 PAGE_SIZE 的巧合）
    pg = mount(br, board_n=4)
    g4 = pg.evaluate(GEO_LIST)
    check("响应换成 4 条 ⇒ 行数与计数一起变成 4（行数是数据驱动的）",
          g4["rows"] == 4 and g4["count"] == "共4条留言", f'rows={g4["rows"]} count={g4["count"]}')
    check("第一节b无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 二、先弹窗、弹窗开着零请求、空理由禁用 ─────────────────────────────────
    print("\n【二】驳回：先弹窗 + 弹窗开着零请求 + 理由为空时主按钮禁用")
    pg = mount(br)
    d0 = open_reject(pg, "驳回靶子B")   # 这一行 aiReason 为 null，顺带当"无 AI 说明"的载体
    check("点「驳回」是**先弹窗**，不是直接下手", d0 is not None, str(d0))
    check("**弹窗开着的时候一个写请求都没发**（动作必须等那一下确认）",
          write_calls(pg) == [], str(write_calls(pg)))
    check("弹窗里只有一个输入框（理由文本框）", d0 and d0["taCount"] == 1, str(d0 and d0["taCount"]))
    check("主按钮上写的是这一下的动作词「确认驳回」", d0 and d0["ok"] == "确认驳回",
          str(d0 and d0["ok"]))
    check("理由为空 ⇒ 主按钮**禁用**（界面上的「必填」）", d0 and d0["okDisabled"] is True,
          str(d0 and d0["okDisabled"]))
    # 禁用不只是个样式：真点下去（force 绕过 playwright 的可操作性检查）也一个写请求都不许有
    pg.locator(VIS + " .bm-reject-ok").click(force=True)
    pg.wait_for_timeout(400)
    check("理由为空时点主按钮：**一个写请求都没发**", write_calls(pg) == [], str(write_calls(pg)))

    # 只有空白字符也算空（"理由必填"不该被几个空格绕过去）
    open_reject(pg, "驳回靶子B")          # 上一步若因缺陷把弹窗发关了，这里补开
    pg.locator(VIS + " textarea").fill("   \t  ")
    pg.wait_for_timeout(250)
    d1 = dlg(pg)
    check("只填空白字符也算空 ⇒ 主按钮仍禁用", d1 and d1["okDisabled"] is True,
          str(d1 and d1["taVal"]))
    pg.locator(VIS + " .bm-reject-ok").click(force=True)
    pg.wait_for_timeout(400)
    check("只填空白字符时点主按钮：一个写请求都没发", write_calls(pg) == [], str(write_calls(pg)))

    # 文本框是**可编辑**的：填一个自定义值 ⇒ 主按钮跟着变可用（只读回显做不到这件事）
    open_reject(pg, "驳回靶子B")
    pg.locator(VIS + " textarea").fill("手写的理由：与灯无关")
    pg.wait_for_timeout(250)
    d2 = dlg(pg)
    check("文本框可编辑（填自定义值后主按钮变为可点）",
          d2 and d2["taVal"] == "手写的理由：与灯无关" and d2["okDisabled"] is False, str(d2))
    check("**弹窗开着、理由也填好了，仍是一个写请求都没发**（点下去才发）",
          write_calls(pg) == [], str(write_calls(pg)))

    # 取消（cancelText="取消"）⇒ 零请求
    cancel_modal(pg)
    check("点取消：关窗且**零写请求**（没有偷偷把动作做掉）",
          dlg(pg) is None and write_calls(pg) == [],
          f'dlg={dlg(pg)} writes={write_calls(pg)}')
    check("第二节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 三、常见违规类型预设 + 采用 AI 说明（两侧）─────────────────────────────
    print("\n【三】预设按钮组 + 「采用 AI 说明」（按钮亮灭取决于这一行的数据）")
    pg = mount(br)
    d = open_reject(pg, "驳回靶子A")    # 这一行有 aiReason
    check("弹窗里有「常见违规类型预设」按钮组（7 个常见类型）",
          d and d["presets"] == PRESETS, str(d and d["presets"]))
    check("有 aiReason 的行：出现「采用 AI 说明」按钮", d and d["useAi"] is True, str(d))
    check("这一行没有已存理由 ⇒ 不出现「沿用」", d and d["reuse"] is False, str(d))
    check("此时理由仍为空、主按钮仍禁用（预设只是待选，不该替人先填一个）",
          d and d["taVal"] == "" and d["okDisabled"] is True, str(d))

    open_reject(pg, "驳回靶子A")
    pg.locator(VIS + " .bm-reject-preset", has_text="广告引流").first.click()
    pg.wait_for_timeout(250)
    d = dlg(pg)
    check("点「广告引流」⇒ 文本框的值变成该文案", d and d["taVal"] == "广告引流",
          str(d and d["taVal"]))
    check("填进预设后主按钮**变为可点**", d and d["okDisabled"] is False, str(d and d["okDisabled"]))
    check("点预设本身不发任何请求", write_calls(pg) == [], str(write_calls(pg)))

    open_reject(pg, "驳回靶子A")
    pg.locator(VIS + " .bm-reject-use-ai").click()
    pg.wait_for_timeout(250)
    d = dlg(pg)
    check("点「采用 AI 说明」⇒ 文本框的值变成这一行的 aiReason", d and d["taVal"] == AI_A,
          str(d and d["taVal"]))
    check("采用 AI 说明后主按钮可点", d and d["okDisabled"] is False, str(d and d["okDisabled"]))

    cancel_modal(pg)
    # 同一条路径的另一侧：aiReason 为 null 的行不该有这个按钮（只验一侧会被"永远显示"蒙过）
    d = open_reject(pg, "驳回靶子B")
    check("aiReason 为 null 的行：弹窗照常起来（下面那条不是空转）", d is not None, str(d))
    check("aiReason 为 null 的行：**不出现**「采用 AI 说明」按钮", d and d["useAi"] is False,
          str(d and d["useAi"]))
    # 同一条判据的第三侧：这一行虽然没 aiReason，但**预设那组照常有**（按钮缺的是"AI 说明"
    # 那一个，不是整块没了 —— 把整块按数据藏起来也是另一种实现偏差）
    check("同一行的预设按钮组照常都在（少的只是「采用 AI 说明」那一个）",
          d and d["presets"] == PRESETS, str(d and d["presets"]))
    cancel_modal(pg)
    check("第三节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 四、已有理由的回显 + 沿用 ─────────────────────────────────────────────
    print("\n【四】已有理由：弹窗里回显 + 「沿用」填回去")
    pg = mount(br)
    # 列表侧：已驳回的行把理由回显在正文下面；没写理由的那一行不许把 null 打出来
    g = pg.evaluate(GEO_LIST)
    bad = by_content(g, "已驳回甲")
    check("列表里已驳回的行回显理由是那一行的 rejectReason",
          bad and bad["reason"] and REASON_BAD in bad["reason"], str(bad and bad["reason"]))
    none_row = by_content(g, "已驳回乙")
    check("已驳回但没写理由的行：给的是占位元素，且**没把 null 打到界面上**",
          none_row and none_row["reasonNone"] and "null" not in none_row["text"],
          str(none_row and none_row["text"]))

    d = open_reject(pg, "驳回靶子C")    # approved=0 且已有 rejectReason
    check("这一行已有理由 ⇒ 弹窗里多一行回显", d and REASON_C in d["existing"],
          str(d and d["existing"]))
    check("回显那一行上有「沿用」按钮", d and d["reuse"] is True, str(d))
    check("回显出现时理由框仍是空的、主按钮仍禁用（回显≠已经填好）",
          d and d["taVal"] == "" and d["okDisabled"] is True, str(d))
    pg.locator(VIS + " .bm-reject-reuse").click()
    pg.wait_for_timeout(250)
    d = dlg(pg)
    check("点「沿用」⇒ 文本框的值变成那条已有理由", d and d["taVal"] == REASON_C,
          str(d and d["taVal"]))
    check("沿用后主按钮可点", d and d["okDisabled"] is False, str(d and d["okDisabled"]))
    cancel_modal(pg)
    check("第四节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 五、确认驳回：恰好一条 PUT，body 严格相等 ──────────────────────────────
    print("\n【五】确认驳回：恰好一条 PUT /api/protect/board/<id>/audit，body 严格相等")
    pg = mount(br)
    d = open_reject(pg, "驳回靶子A")
    pg.locator(VIS + " .bm-reject-preset", has_text="广告引流").first.click()
    pg.wait_for_timeout(250)
    pg.locator(VIS + " .bm-reject-ok").click()
    pg.wait_for_timeout(600)
    posts = audit_puts(pg)
    check("点「确认驳回」恰好发出**一条**审核请求", len(posts) == 1, str(posts))
    check("它是 PUT /api/protect/board/1000/audit",
          posts and posts[0]["method"] == "PUT" and posts[0]["url"] == "/api/protect/board/1000/audit",
          str(posts))
    b = posts[0]["body"] if posts else None
    check("body 的键集合恰好是 {approved, reason}（多传/少传都算红）",
          isinstance(b, dict) and sorted(b.keys()) == ["approved", "reason"], str(b))
    check("body 严格等于 {approved: 0, reason: '广告引流'}（预设真的进了请求体）",
          b == {"approved": 0, "reason": "广告引流"}, str(b))
    check("提交成功后弹窗关上", dlg(pg) is None, str(dlg(pg)))

    # 第二发：手填的值（不是预设）也必须原样进请求体，且只有这一条新的
    d = open_reject(pg, "驳回靶子B")
    check("重新打开弹窗时理由框是空的（上一发的值不许漏过来）", d and d["taVal"] == "", str(d))
    pg.locator(VIS + " textarea").fill("手写的理由：与灯无关")
    pg.wait_for_timeout(250)
    pg.locator(VIS + " .bm-reject-ok").click()
    pg.wait_for_timeout(600)
    posts = audit_puts(pg)
    check("第二发（手填）后共两条审核请求，且新的那条是这一行的 id",
          len(posts) == 2 and posts[-1]["url"] == "/api/protect/board/1001/audit",
          str([x["url"] for x in posts]))
    check("手填的值原样进请求体（approved 仍是 0 这个动作码）",
          posts and posts[-1]["body"] == {"approved": 0, "reason": "手写的理由：与灯无关"},
          str(posts[-1]["body"] if posts else None))
    check("两发之后没有第三条（禁用态那几次点击都没漏出去）", len(posts) == 2,
          str([x["url"] for x in posts]))
    check("第五节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 六、「AI 审核」列的 tooltip 含 aiReason 全文 ────────────────────────────
    # 取法说明（别假装它是 hover 出来的）：antd Tooltip 只在 hover 后把内容挂到 body 上的
    # portal（`.ant-tooltip-inner`）里，所以这里**真的 hover** 那一列标签，再读 portal
    # 里的文字；`>= 1` 那条是"hover 真的把 tooltip 挂出来了"的非空前置（否则下面的
    # 包含断言在一条空列表上永假/永真都无从分辨）。
    print("\n【六】「AI 审核」列的 tooltip：有 aiReason 的行含全文，null 的行没有那一块")
    pg = mount(br)
    row_loc(pg, "驳回靶子A").locator("td").nth(6).locator(".ant-tag").first.hover()
    pg.wait_for_timeout(500)
    tips = pg.evaluate("""() => [...document.querySelectorAll('.ant-tooltip-inner')]
        .map((e) => e.textContent.replace(/\\s+/g, ''))""")
    check("hover「AI 审核」列的标签后 tooltip 真的挂出来了（否则下一条是空转）",
          len(tips) >= 1, str(tips))
    check("tooltip 里含这一行的 aiReason **全文**（没被截断）",
          any(nz(AI_A) in t for t in tips), str([t[:80] for t in tips]))
    check("第六节①无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # aiReason 为 null 的行：tooltip 照常出现，但里面没有「AI 说明」那一块
    pg = mount(br)
    row_loc(pg, "驳回靶子B").locator("td").nth(6).locator(".ant-tag").first.hover()
    pg.wait_for_timeout(500)
    tips2 = pg.evaluate("""() => [...document.querySelectorAll('.ant-tooltip-inner')]
        .map((e) => e.textContent.replace(/\\s+/g, ''))""")
    check("aiReason 为 null 的行：tooltip 照常出现（不是「根本没弹」）", len(tips2) >= 1, str(tips2))
    check("aiReason 为 null 的行：tooltip 里**没有** .bm-ai-reason 那一块",
          pg.evaluate("() => document.querySelectorAll('.ant-tooltip-inner .bm-ai-reason').length") == 0,
          str(pg.evaluate("() => document.querySelectorAll('.ant-tooltip-inner .bm-ai-reason').length")))
    check("第六节②无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 七、裁决成功后**那一行当场变样**（本地写回，不靠 load() 重拉）──────────
    # 这一节是一个真实缺陷的回归锁（20260926 修）：`audit()` 把**入参**当落库值写回本地行，
    # 而入参 0 是"驳回"这个**动作码**、后端落的是 2「未通过」（src/routes/talks.rs::audit_board
    # 的 `Set(if reject { 2 } else { 1 })`）⇒ 驳回成功后那一行仍停在待审：标签还是金色「待审」、
    # 操作列还挂着「通过/驳回」（能再点一次驳回）、正文下面的驳回理由一个字都不显示
    # （那一段的渲染条件是 `approved === 2`）。**后端其实已经改完了**，是界面撒谎；
    # 而"只改本地那一行、不 load() 重拉全量"这个优化的全部意义就是不去重拉 ⇒ 一旦写回写错，
    # 没有任何后续请求能把它纠正过来（要等下次进页面）。桩只回成功、从不回写列表。
    #
    # 两个方向都锁：驳回（入参 0 → 落库 2）与通过（入参 1 → 落库 1，本来就同值）。
    print("\n【七】裁决成功后那一行当场变样（本地写回用的是落库值，不是动作码）")
    pg = mount(br)
    g0 = by_content(pg.evaluate(GEO_LIST), "驳回靶子B")
    check("前置：这一行初始是「待审」且挂着「驳回」入口（否则下面的翻转断言无从分辨）",
          g0 and g0["manualTag"] == "待审" and g0["reject"] == 1 and g0["reason"] is None,
          str(g0))
    d = open_reject(pg, "驳回靶子B")
    check("前置：驳回弹窗开了", d is not None, str(d))
    MY_REASON = "第七节：与灯的主题无关"
    pg.locator(VIS + " textarea").fill(MY_REASON)
    pg.wait_for_timeout(250)
    pg.locator(VIS + " .bm-reject-ok").click()
    pg.wait_for_timeout(600)
    g1 = by_content(pg.evaluate(GEO_LIST), "驳回靶子B")
    check("驳回成功后「人工审核」列当场变成「未通过」（写回的是落库值 2，不是入参 0）",
          g1 and g1["manualTag"] == "未通过", str(g1 and g1["manualTag"]))
    check("  「驳回」入口当场消失、换成「恢复通过」（还挂着驳回 = 能对同一条再驳一次）",
          g1 and g1["reject"] == 0 and g1["restore"] == 1,
          str(g1 and (g1["reject"], g1["restore"])))
    check("  正文下面的驳回理由当场显示本次填的那句（不是「未填写」）",
          g1 and g1["reason"] is not None and MY_REASON in g1["reason"] and not g1["reasonNone"],
          str(g1 and (g1["reason"], g1["reasonNone"])))
    check("  全程没有为了追上后端而重拉列表（GET 列表仍只有最初那一次）",
          get_urls(pg).count("/api/protect/board") == 1, str(get_urls(pg)))
    check("第七节①无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # 另一个方向：通过（入参 1 = 落库 1）
    pg = mount(br)
    row_loc(pg, "驳回靶子D").locator("button", has_text=re.compile(r"^通\s*过$")).first.click()
    pg.wait_for_timeout(600)
    g2 = by_content(pg.evaluate(GEO_LIST), "驳回靶子D")
    check("点「通过」后当场变「通过」：「通过」与「恢复通过」都收走，"
          "只剩「驳回」（已通过行仍可改判，20260930）",
          g2 and g2["manualTag"] == "通过" and g2["reject"] == 1 and g2["pass"] == 0
          and g2["restore"] == 0,
          str(g2 and (g2["manualTag"], g2["reject"], g2["pass"], g2["restore"])))
    check("  通过的行不显示驳回理由那一块（后端会清空理由）",
          g2 and g2["reason"] is None, str(g2 and g2["reason"]))
    check("第七节②无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # 第三个方向（20260930 新能力）：**已通过 → 驳回**（收回展示）。
    # 走的是同一条 `audit(id, 0, reason)`、同一个弹窗，但入口此前不存在：已通过的行
    # 操作区只有「删除」，点不到驳回 ⇒ 这一节存在的意义就是"入口真的挂上了、而且
    # 点完那一行当场翻面"。选「通过乙」（approved=1 且 ai_result='reject'）——它是
    # "AI 驳回被人改判放行"那一档，正是最可能被反悔的一条。
    print("\n【七③】已通过的留言也能驳回（收回展示）：入口挂得上、写完当场翻面")
    pg = mount(br)
    g3 = by_content(pg.evaluate(GEO_LIST), "通过乙")
    check("前置：这一行初始是「通过」且挂着「驳回」入口",
          g3 and g3["manualTag"] == "通过" and g3["reject"] == 1, str(g3))
    d = open_reject(pg, "通过乙")
    check("前置：已通过行的驳回弹窗开得出来（理由照旧必填）",
          d is not None and d.get("okDisabled") is True, str(d))
    MY_REASON_3 = "第七③节：已通过但又觉得不合适"
    pg.locator(VIS + " textarea").fill(MY_REASON_3)
    pg.wait_for_timeout(250)
    pg.locator(VIS + " .bm-reject-ok").click()
    pg.wait_for_timeout(600)
    g4 = by_content(pg.evaluate(GEO_LIST), "通过乙")
    check("确认后那一行当场变成「未通过」（写回落库值 2），理由显示本次填的那句",
          g4 and g4["manualTag"] == "未通过" and g4["reason"] is not None
          and MY_REASON_3 in g4["reason"],
          str(g4 and (g4["manualTag"], g4["reason"])))
    check("  「驳回」入口当场换成「恢复通过」（同一条能再改回来）",
          g4 and g4["reject"] == 0 and g4["restore"] == 1,
          str(g4 and (g4["reject"], g4["restore"])))
    _rev = audit_puts(pg)
    check("  请求体是**驳回**那一份契约（approved=0 这个动作码 + 本次填的理由；"
          "键集合也要对——多传少传都算红）",
          bool(_rev) and _rev[-1]["body"] == {"approved": 0, "reason": MY_REASON_3},
          str(_rev[-1:] if _rev else None))
    check("  全程没有为了追上后端而重拉列表",
          board_gets(pg) == 1, str(get_urls(pg)))
    check("第七③节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 八、跨端同步：看板娘改的那一笔，页面自己跟上 ────────────────────────────
    # 现场（用户报的）：后台开着这一页，让看板娘驳回一条留言 —— 页面不动，得刷新网页。
    # 这一页此前只在挂载时拉一次，agent 是从服务端改的账，浏览器没有任何理由知道。
    # 现在接 `utils/liveRefresh.ts`（`live-refresh.test.mjs` 在模块级锁它的四条纪律），
    # 这一节锁的是**这一页真的接了它、而且接对了**：
    #   · 看板娘收尾事件 ⇒ 多发一次 `GET /api/protect/board`；
    #   · 那一次是**背景式**的（在途时不亮表格 loading）——后台每 20 秒抖一下 spinner，
    #     会让人以为页面自己在动；而主人**手动**点「刷新」时必须照旧有反馈。两侧都要验：
    #     只验一侧的话，"永远 loading" 与 "永远不 loading" 都能蒙过一条。
    #   · 驳回弹窗开着 ⇒ 一次都不拉（弹窗认的是那一行对象，底下列表在它下面换掉很危险）。
    #     ⚠️ 这一条的判据必须是 `skip`，不能是节流窗口：所以派发前**先等过** MIN_GAP_MS
    #     （2000ms），否则它"通过"只是因为上一次刚拉完。反过来，弹窗关掉之后**不等**就
    #     派发 —— 那一次若被节流吃掉，说明 `skip` 把窗口也吃掉了（实现里刻意把 skip 判在
    #     节流之前，见 liveRefresh.ts 的注释），那时这一条会真红。
    print("\n【八】跨端同步：看板娘收尾事件 ⇒ 重拉；驳回弹窗开着 ⇒ 一次都不拉")
    pg = mount(br)
    base = board_gets(pg)
    check("前置：挂载时只拉了一次列表（否则下面的增量断言无从分辨）", base == 1, str(base))

    # ① 事件触发的重拉是背景式的：把响应扣住，看那一段在途时间里表格亮不亮 loading
    release = hold_next_board(pg)
    fire_agent_done(pg)
    pg.wait_for_timeout(300)
    check("收到看板娘收尾事件后确实发了请求（在途，响应被扣住）", board_gets(pg) == base + 1,
          str(board_gets(pg)))
    check("  且那一次是**背景式**的：请求在途时表格不亮 loading（不打断主人正在看的东西）",
          spinning(pg) == 0, str(spinning(pg)))
    release()
    pg.wait_for_timeout(400)
    check("  放行后列表照常刷新（没有卡在在途状态）", board_gets(pg) == base + 1,
          str(board_gets(pg)))

    # ② 弹窗开着：事件一次都不许拉。先等过节流窗口，确保"没拉"只能归因于 skip
    pg.wait_for_timeout(2100)
    d = open_reject(pg, "驳回靶子B")
    check("前置：驳回弹窗开着", d is not None, str(d))
    fire_agent_done(pg)
    pg.wait_for_timeout(500)
    check("弹窗开着（主人在写理由）收到事件 ⇒ **一次都不拉**，列表停在原地",
          board_gets(pg) == base + 1, str(board_gets(pg)))

    # ③ 关窗后**不等**就派发：`skip` 不该把节流窗口一起吃掉（否则关窗后还得干等 2 秒）
    cancel_modal(pg)
    fire_agent_done(pg)
    pg.wait_for_timeout(500)
    check("关掉弹窗后紧接着的事件立刻生效（skip 判在节流之前，没吃掉窗口）",
          board_gets(pg) == base + 2, str(board_gets(pg)))

    # ④ 手动「刷新」按钮：照旧有 loading 反馈（与背景式相对的那一侧）
    release2 = hold_next_board(pg)
    click_refresh(pg)
    pg.wait_for_timeout(300)
    check("工具栏「刷新」按钮真的发了请求", board_gets(pg) == base + 3, str(board_gets(pg)))
    check("  手动那一次**有** loading 反馈（表格清楚地在转，不是静默换数据）",
          spinning(pg) >= 1, str(spinning(pg)))
    release2()
    pg.wait_for_timeout(400)
    check("  放行后 loading 收掉、列表是新的一份", spinning(pg) == 0 and board_gets(pg) == base + 3,
          f'spin={spinning(pg)} gets={board_gets(pg)}')
    check("第八节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 评论管理页（20260926 那批改动）：全部通过")
