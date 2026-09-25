# -*- coding: utf-8 -*-
"""后台「用户管理」页（账号管理 + 评论管理）的无头验收：真组件 + 真 antd + 假后端。

20260926 这一轮四件事，每件都只有真跑一遍才看得见：

  · **筛选/检索的头不再滚走** —— 这是用户报的症状（"向下滚动会丢失筛选检索的头"）。
    判据是几何：滚列表前后，工具栏那一条的 `rect.top` 一动不动，而行/表头的 top 变了。
    光读 CSS 看不出这个（少写 `min-height: 0`，flex 项的自动最小高度按内容算，
    整块会被内容撑高、自己永远不出滚动条，反而退回"整页滚"——那时两条断言都假过）。
  · **账号列表的角色筛选/检索** —— 判据是**行数**：筛"管理员账号"后留下的行必须
    恰好是 role=admin 的那些，且管理员行不给"删除"按钮。
  · **新建账号框不再被浏览器回填** —— 根因不在缺 `autocomplete`（Chrome 对判定为
    凭据的字段忽略 `off`），而在**页面里常驻着一个密码框**：没有 `<form>` 时 Chrome
    把整页散落的输入框当成一个合成表单，"页面上有密码框"就等于"本页是登录页"。
    所以判据是**页面上密码框的条数**：常态 1 个（新建表单那个）、打开改密弹窗 2 个、
    关掉回到 1 个。这条同时锁住了 `forceRender`（关窗时 children 不更新那个坑）。
  · **评论管理同款内滚动 + 分页条钉底 + 表头吸顶** —— 与文章列表同一套做法。
  · **冻结 / 解冻账号**（同日晚些，第 5 件）—— 判据分三层：行上的「已冻结」标签、
    按钮的**极性**（冻结行上写着"解冻"、未冻结行上写着"冻结"）与**配色**（danger 只给
    "冻结"那一侧）、以及筛"冻结账号"这一档时行的归属会**跟着状态走**。请求侧锁三件事：
    POST 到 `/api/temp-users/<id>/status`、body 传的是**目标状态**而非"切换一下"、
    成功后会重新拉一次列表。另有两条刻意锁住的语义：`status` 缺失按 0 算（部署顺序
    兜底），而 `status = 2` 这种**未登记取值按冻结处理**（与后端 `is_frozen` 同一条）。
    同日晚些再加一层（用户点名「把 OK 换成对应具体事务」）：**冻结/解冻要先弹确认框，
    且确认按钮上的字是这一下的动作词**（「冻结」/「解冻」，不是「确定/OK」；标题、正文
    里的后果说明、danger 极性都跟着方向走）。三条不变量跟着一起锁：弹窗开着时**零请求**、
    点取消**零请求**、只有点确认才发出那一条 POST。
    两个坑写在下面的探针里：antd 的 `autoInsertSpace` 会在两个汉字之间插空格
    （拿到的是「解 冻」——**弹窗确认按钮上同样会**，所以认定文案前一律抹空白），
    以及假响应每次 GET 必须返回**深拷贝**——返回同一个数组
    引用会让 React 的 `Object.is` 直接跳过重渲染，症状是"POST 成功了但行没动"。
  · **账号管理改走共享 axios 客户端**（同日晚些的第 6 件）——六处 `fetch` + 手拼
    `'Bearer ' + token` 全部撤掉。判据是运行时的：`window.__fetchCalls` 恒空
    （`zero_bare_fetch`），而账号请求出现在 `__calls` 里且**请求头**由客户端的
    请求拦截器补（桩只记 url/method/body，头不在记录里——本页锁的是"走没走那条
    通道"，头的事归 `src/apis/axios.tsx` 自己的测试管）。桩的形状也照真后端改：
    GET 回**裸数组**、写接口回 `{code,message,data}`——两半不一致时"把 `res.data`
    写成 `res.data.data`"这类缺陷会被桩掩盖成"没有账号"。

沿用既定手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把真组件打成 bundle，
只桩两个边界（`src/apis/axios.tsx` 与 `window.fetch`——20260926 起这一页**整页都走
axios**：账号管理原来六处自拼 `fetch` + `'Bearer ' + token`，已迁到共享客户端，于是
令牌失效时才有那条"清 token + 跳登录"的全局处理）；`window.fetch` 那个桩留着当**哨兵**：
它一旦非空就说明有人把某处改回了裸 fetch（判据见 zero_bare_fetch）。
sass 用 programmatic API 单独编译后用 `--loader:.sass=text` 收下。
本机无中文字体（汉字渲染成豆腐块），断言全走数值与条数。

用法：python3 frontend/tests/users-page.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/react-router-dom）、playwright(python)。
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

# ── 假后端之一：axios（评论管理用的那个）──────────────────────────────────────
FAKE_AXIOS = r"""
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;

// 40 条留言 = 4 页（每页 10）⇒ 分页条真的有多页可翻，"切页"才有意义
const BOARD = Array.from({ length: 40 }, (_, i) => ({
  talkKey: 1000 + i,
  content: '留言 ' + (i + 1),
  cat: ['愿', '寄', '忆', '诉'][i % 4],
  v: i % 3,
  author: '留名人' + (i + 1),
  createTime: '2026-09-2' + (i % 9) + ' 10:00:00',
  userId: 700 + (i % 5),
  username: 'u' + (i % 5),
  nickname: '昵称' + (i % 5),
  approved: i % 3,
  ai_result: i % 2 ? 'pass' : null,
  rejectReason: null,
}));

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
// 裸响应：响应的 body 本身就是 `{code,message,data}` 那一层（账号管理的写接口是
// `utils::ApiResponse`，读接口是裸数组——两种形状都在这一页上，别混）
const env0 = (body: any) => ({ status: 200, data: body });
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ⚠️ 一定要是**带方法的对象**，不能是裸函数：真实 `src/apis/axios.tsx` 导出的是
// `axios.create()` 出来的实例，调用方写的是 `http.get(...)`/`http.put(...)`。
// 做成裸函数时 `http.get` 是 undefined ⇒ 组件里 `try{ await http.get() }catch{}`
// 把 TypeError 静静吃掉（只弹一条 message.error），**桩里一条记录都没有**，
// 症状是"表格空着、零异常"——20260926 就在这个坑上耗了一轮。
const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: wire(cfg.data) });
  await delay(20);
  if (url === '/api/protect/board') return env(BOARD);
  if (url === '/api/protected/websetting') return env({ aiReviewEnabled: false, manualReviewEnabled: false });
  // ── 账号管理（20260926 起也走这个客户端；此前它走 window.fetch）────────────
  // ⚠️ GET 回的是**裸数组**，不是 env() 那层 {code,message,data} 壳：真后端
  // `src/routes/temp_user.rs::list_temp_users` 返回的就是 `Json<Vec<TempUserInfo>>`。
  // 桩在这里必须跟真后端一致——否则组件里把 `res.data` 误写成 `res.data.data`
  // 这种缺陷会被桩掩盖成"没有账号"（axios 不报错、页面不红）。
  if (url === '/api/temp-users' && method === 'GET') {
    return { status: 200, data: wire((window as any).__users) };
  }
  // status 这一条要**真改内存里那一行**（同 fetch 桩）：于是"点冻结 ⇒ 它出现在
  // 冻结筛选里"是端到端成立的，而不是靠断言自己骗自己。
  if (/^\/api\/temp-users\/\d+\/status$/.test(url) && method === 'POST') {
    const id = Number(url.split('/')[3]);
    const u = ((window as any).__users as any[]).find((x) => x.id === id);
    const frozen = (cfg.data || {}).frozen === true;
    if (u) u.status = frozen ? 1 : 0;
    return env0({ code: 200, message: frozen ? '账号已冻结，其登录状态已全部失效'
                                           : '账号已解冻，请让对方重新登录', data: null });
  }
  return env0({ code: 200, message: 'ok', data: null });
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
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Users from './src/pages/Dashboard/Users/index.tsx';

localStorage.setItem('tokenKey', 'x.y.z');

// 账号列表 20260926 起走共享 axios 客户端（桩在 FAKE_AXIOS 里，GET 回裸数组）。
// 下面这个 fetch 桩是**残留的哨兵**：这一页现在一条 fetch 都不该发，桩留着只为
// 「谁把某一处改回裸 fetch」时留下证据（见 zero_bare_fetch）。
// 30 行 ⇒ 账号列表在 700 高的窗口里必然溢出，"只有列表滚"那条断言才不是空转。
// status 与后端 `user.status` 同口径：0=正常 / 1=冻结（取值域见 src/authz.rs）。
// 预置两行冻结（guest27/guest28 = id 126/127）——两行**一个是普通用户**，
// 于是"角色筛选不排除冻结账号"与"冻结筛选只按状态"这两条才验得出来。
const USERS = [
  { id: 1, username: 'root_admin', role: 'admin', status: 0 },
  ...Array.from({ length: 28 }, (_, i) => ({
    id: 100 + i, username: 'guest' + (i + 1), role: 'user', status: i >= 26 ? 1 : 0 })),
  { id: 200, username: 'sec_zhang', role: 'secretary', status: 0 },
];
(window as any).__users = USERS;
(window as any).__fetchCalls = [];

window.fetch = (async (input: any, init: any) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  const method = String((init && init.method) || 'GET').toUpperCase();
  (window as any).__fetchCalls.push({
    url, method, body: (init && init.body) ? JSON.parse(init.body) : null });
  await new Promise((r) => setTimeout(r, 20));
  let body: any = { code: 200, message: 'ok', data: null };
  // ⚠️ 必须回**深拷贝**，不能把 USERS 本体丢回去：真 HTTP 每次都反序列化出一个新对象，
  // 而这里的 USERS 是同一个数组引用 ⇒ `setTempUsers(data)` 会被 React 的 Object.is
  // 判等拦下、**不触发重渲染**，症状是"改了状态但界面纹丝不动"——20260926 就在这个
  // 坑上误判过一次（同族的坑见上面 axios 桩那条注释）。
  if (url === '/api/temp-users' && method === 'GET') body = JSON.parse(JSON.stringify(USERS));
  else if (/^\/api\/temp-users\/\d+\/status$/.test(url) && method === 'POST') {
    // 真按请求体改内存里那一行 —— 于是"点冻结 ⇒ 它出现在冻结筛选里"是
    // 端到端成立的，而不是靠断言自己骗自己
    const id = Number(url.split('/')[3]);
    const u = USERS.find((x) => x.id === id);
    const frozen = (init && init.body) ? JSON.parse(init.body).frozen === true : false;
    if (u) u.status = frozen ? 1 : 0;
    body = { code: 200, message: frozen ? '账号已冻结，其登录状态已全部失效'
                                      : '账号已解冻，请让对方重新登录', data: null };
  }
  return { ok: true, status: 200, json: async () => body } as any;
}) as any;

(window as any).__mount = (path: string) => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/dashboard/users" element={<Users />} />
    </Routes>
  </MemoryRouter>
);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="users-ui-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    sass_files = ["src/pages/Dashboard/Users/index.sass",
                  "src/pages/Dashboard/BoardManage/index.sass"]
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
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    # 给页面一个真实的高度上下文：这页的内滚动全靠 height:100% 那条链
    # （真实环境里那一 100% 来自后台壳的 .Card 95% → .ant-card-body 100%），
    # 沙箱只挂一个裸组件、没有父高度可继承 ⇒ 内滚动退化成内容高，断言全空转。
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body,#root{height:100%;margin:0}'
        # 真站在 frontend/src/frontHome/main.css 里有一条全局 `*{box-sizing:border-box}`，
        # 后台页面同样吃它。沙箱**必须**照搬：少了它，`.tu-section{height:100%;padding:12px}`
        # 会按 content-box 算（内容高 100% + 上下 padding 溢出容器 24px），
        # "列表区铺到卡片底部"那条断言就会在沙箱里假红——那是沙箱失真，不是页面缺陷。
        '*{box-sizing:border-box;margin:0;padding:0}</style>'
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


def mount(br, path="/dashboard/users", size=(1440, 700), wait=".tu-row"):
    page = br.new_page(viewport={"width": size[0], "height": size[1]})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL)
    page.evaluate("(p) => window.__mount(p)", path)
    try:
        page.wait_for_selector(wait, timeout=10000)
    except Exception:
        # 等不到就别只说"超时"——把关键节点、几何、请求记录和页面异常一起打出来
        print("  ⚠ 等不到 " + wait + "，现场：")
        print("    " + page.evaluate("""() => {
            const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
                return [Math.round(b.width), Math.round(b.height)]; };
            return JSON.stringify({
                board: R(document.querySelector('.BoardManage')),
                scroll: R(document.querySelector('.bm-scroll')),
                table: R(document.querySelector('.ant-table')),
                rows: document.querySelectorAll('.ant-table-row').length,
                empty: !!document.querySelector('.ant-empty'),
                activePane: (document.querySelector('.ant-tabs-tabpane-active') || {}).className || '',
                axios: (window.__calls || []).map((c) => c.url),
                axiosStub: window.__axiosStub === true,
                // 20260926 起账号管理也走 axios ⇒ 这一栏正常是空的（唯一用途是
                // "谁又偷偷用回裸 fetch 了"）——留着正是为了等不到元素时能一眼看出
                fetch: (window.__fetchCalls || []).map((c) => c.url + '/' + c.method),
            }); }"""))
        print("    页面异常：" + ("; ".join(errs[:3]) or "（无）"))
        raise
    # 页面里 loadTempUsers 是 setTimeout 500ms 后才发的
    page.wait_for_timeout(800)
    page.errs = errs
    return page


GEO = """() => {
    const R = (el) => { const b = el.getBoundingClientRect();
        return {t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1)}; };
    const q = (s) => document.querySelector(s);
    const pw = [...document.querySelectorAll('input')].filter((i) => i.type === 'password');
    return {
        root: R(document.getElementById('root')),
        section: q('.tu-section') ? R(q('.tu-section')) : null,
        head: q('.tu-head') ? R(q('.tu-head')) : null,
        filter: q('.tu-filter') ? R(q('.tu-filter')) : null,
        wrap: q('.tu-list-wrap') ? R(q('.tu-list-wrap')) : null,
        sectionOverflow: q('.tu-section') ? getComputedStyle(q('.tu-section')).overflowY : '',
        wrapOverflow: q('.tu-list-wrap') ? getComputedStyle(q('.tu-list-wrap')).overflowY : '',
        wrapScroll: q('.tu-list-wrap') ? {sh: q('.tu-list-wrap').scrollHeight, ch: q('.tu-list-wrap').clientHeight} : null,
        rows: document.querySelectorAll('.tu-row').length,
        // 密码框条数：只数**可见**的没意义（关闭的弹窗是 display:none 但仍在 DOM 里，
        // 而"留在 DOM 里"正是浏览器判定本页为登录页的充分条件）
        pwCount: pw.length,
        pwInCreate: pw.filter((i) => i.closest('.tu-create')).length,
        pwElsewhere: pw.filter((i) => !i.closest('.tu-create')).length,
        modalWrap: document.querySelectorAll('.ant-modal-wrap').length,
        count: q('.tu-count') ? q('.tu-count').textContent : '',
        // 每行的按钮按**类名**取，不按 .ant-btn-dangerous 取（20260926）：
        // 「冻结」在未冻结行上也是 danger，按危险色取会把它当成删除按钮。
        delBtns: [...document.querySelectorAll('.tu-row')].map(
            (r) => ({ u: r.querySelector('strong').textContent, del: !!r.querySelector('.tu-del-btn') })),
        freezeBtns: [...document.querySelectorAll('.tu-row')].map((r) => {
            const b = r.querySelector('.tu-freeze-btn');
            // antd 会在两个汉字之间插一个空格（autoInsertSpace）⇒ "解 冻"。
            // 断言前把空白抹掉，否则判的是 antd 的排版而不是我们的文案。
            return { u: r.querySelector('strong').textContent,
                     label: b ? b.textContent.replace(/\s+/g, '') : '',
                     danger: b ? b.classList.contains('ant-btn-dangerous') : false,
                     tag: r.textContent.includes('已冻结') };
        }),
    };
}"""


# 冻结/解冻的确认框（20260926 用户点名：「把 OK 换成对应具体事务」）。
# 取的是**弹窗页脚**那个按钮，不是行上那个同名的——两者文案一样（冻结/解冻），
# 只有作用域能区分（行上 `.tu-freeze-btn` / 弹窗 `.tu-status-ok`）。
# 按类名认弹窗而不是按 `title` 认：这一页同时挂着三个 `.ant-modal-wrap`
# （改密码、恢复码、本框），关着的那些是 display:none 但仍在 DOM 里。
STATUS_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.tu-status-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.tu-status-ok');
    return {
        title: q('.ant-modal-title'),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDanger: ok.classList.contains('ant-btn-dangerous'),
        body: q('.ant-modal-body'),
    };
}"""


def status_posts(pg):
    """本页发出的状态请求条数（POST …/status）。断言"确认之前一个都不许发"用它。

    20260926 起账号管理走共享 axios 客户端 ⇒ 记录在 `__calls`（原来在 `__fetchCalls`）。
    记录里请求体那一栏两个桩叫法不同（fetch 桩叫 `body`、axios 桩叫 `data`），这里
    统一成 `body`——断言只该关心"发了什么"，不该关心它走的是哪个桩。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'POST' && /\\/status$/.test(c.url))
        .map((c) => ({ url: c.url, body: c.data }))""")


def zero_bare_fetch(pg):
    """这一页**一条裸 `fetch` 都不该有**（20260926 迁移的回归锁）。

    `window.fetch` 的桩还在（见 ENTRY），但它现在只该是空的：账号管理原来六处都
    自己 fetch + 手拼 `'Bearer ' + token`，于是绕过了共享客户端的 401 处理。
    谁把某一处改回 fetch，这条立刻红——而不是等到"令牌过期时后台不跳登录"那天。"""
    return pg.evaluate("() => window.__fetchCalls.map((c) => c.method + ' ' + c.url)")


with sync_playwright() as p:
    br = p.chromium.launch()
    # ── 一、账号管理：固定壳 + 只有列表滚 ─────────────────────────────────────
    # 用户报的原始症状就在这里（"文章列表的逻辑"）。判据取"头不动、行动"这一对：
    # 只看"列表能滚"是假绿——整页滚的时候列表**也**能滚。
    print("\n【一】账号管理：筛选检索的头固定，只有账号列表在窗口内滚")
    pg = mount(br)
    g0 = pg.evaluate(GEO)
    check("账号列表渲染出来了（30 个账号）", g0["rows"] == 30, f'rows={g0["rows"]}')
    check("前置：列表内容真的溢出了（否则下面两条是空转）",
          g0["wrapScroll"]["sh"] > g0["wrapScroll"]["ch"] + 40,
          f'{g0["wrapScroll"]["sh"]} vs {g0["wrapScroll"]["ch"]}')
    check("整块不再自己滚（.tu-section overflow-y: hidden）",
          g0["sectionOverflow"] == "hidden", g0["sectionOverflow"])
    check("滚动落在列表区上（.tu-list-wrap overflow-y: auto）",
          g0["wrapOverflow"] == "auto", g0["wrapOverflow"])
    # 判"下方没有多余的空白"而不是"完全贴合"：`.tu-section` 自己有 12px 下内边距
    # （收尾的呼吸位，刻意留的），所以列表底比卡片底高 12px 是**设计**。
    # 要紧的是那个差不能更大——差到几十上百 px 就是内容没铺满。
    gap = g0["root"]["b"] - g0["wrap"]["b"]
    check("列表区铺到卡片底部（下方只留容器那 12px 内边距，没有多余空白）",
          0 <= gap <= 16, f'列表底 {g0["wrap"]["b"]} / 卡片底 {g0["root"]["b"]}（差 {gap:.1f}px）')

    # 结构判据（比"滚一下看看头动没动"更硬）：从账号行往上，可滚祖先**只能有一个**，
    # 而且必须是列表区。老代码是整块 .tu-section 自己滚 —— 那时"滚一下头会不会动"
    # 取决于**滚的是谁**（滚列表区它当然不动），所以光靠上面那对断言拦不住回退；
    # 这一条是"筛选那一条在结构上就滚不走"，不依赖测试脚本滚哪个元素。
    scrollers = pg.evaluate("""() => {
        const row = document.querySelector('.tu-row');
        const out = [];
        for (let el = row.parentElement; el; el = el.parentElement) {
            const oy = getComputedStyle(el).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
                out.push(el.className || el.tagName);
            }
        }
        return out;
    }""")
    check("从账号行往上只有 .tu-list-wrap 一个可滚祖先（筛选那一条结构上就滚不走）",
          len(scrollers) == 1 and 'tu-list-wrap' in scrollers[0], str(scrollers))

    moved = pg.evaluate("""() => {
        const wrap = document.querySelector('.tu-list-wrap');
        const head = document.querySelector('.tu-head');
        const row0 = document.querySelector('.tu-row');
        const before = { headTop: head.getBoundingClientRect().top, rowTop: row0.getBoundingClientRect().top };
        wrap.scrollTop = wrap.scrollHeight;
        const after = { headTop: head.getBoundingClientRect().top, rowTop: row0.getBoundingClientRect().top,
                        scrolled: wrap.scrollTop };
        return { before, after };
    }""")
    check("滚到底：筛选/检索那一条**一动不动**",
          abs(moved["after"]["headTop"] - moved["before"]["headTop"]) < 1,
          f'{moved["before"]["headTop"]} → {moved["after"]["headTop"]}')
    check("滚到底：账号行确实滚上去了（说明上一条不是「没滚成」）",
          moved["after"]["rowTop"] < moved["before"]["rowTop"] - 100,
          f'{moved["before"]["rowTop"]} → {moved["after"]["rowTop"]}（scrollTop={moved["after"]["scrolled"]}）')
    check("第一节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 二、角色筛选 + 用户名检索 ─────────────────────────────────────────────
    print("\n【二】账号管理的角色筛选与检索")
    pg = mount(br)
    n_all = pg.evaluate("() => document.querySelectorAll('.tu-row').length")
    check("默认「全部」= 30 个账号（管理员也在里面，不再只列普通账号）",
          n_all == 30 and "共 30 个账号" in pg.evaluate(GEO)["count"], f'{n_all} / {pg.evaluate(GEO)["count"]}')

    pg.locator(".tu-tabs button", has_text="管理员账号").first.click()
    pg.wait_for_timeout(200)
    g = pg.evaluate(GEO)
    admins = [r["u"] for r in g["delBtns"]]
    check("筛「管理员账号」：只剩 admin 那一行", admins == ["root_admin"], str(admins))
    check("计数跟着筛（共 1 个账号）", "共 1 个账号" in g["count"], g["count"])
    check("管理员行**没有**删除按钮（后端也拒，见 delete_temp_user）",
          all(not r["del"] for r in g["delBtns"]), str(g["delBtns"]))

    pg.locator(".tu-tabs button", has_text="普通用户账号").first.click()
    pg.wait_for_timeout(200)
    g = pg.evaluate(GEO)
    names = [r["u"] for r in g["delBtns"]]
    check("筛「普通用户账号」：管理员被排除、秘书也在这一档（非管理员）",
          "root_admin" not in names and "sec_zhang" in names and len(names) == 29,
          f'{len(names)} 行，含秘书={"sec_zhang" in names}')
    check("普通账号行**有**删除按钮（秘书也不是普通用户，同样没有）",
          all(r["del"] for r in g["delBtns"] if r["u"] != "sec_zhang")
          and not [r for r in g["delBtns"] if r["u"] == "sec_zhang"][0]["del"],
          str([r for r in g["delBtns"] if not r["del"]]))

    pg.locator(".tu-tabs button", has_text="全部").first.click()
    pg.wait_for_timeout(200)
    pg.locator(".tu-filter .ant-input").first.fill("guest1")
    pg.wait_for_timeout(300)
    g = pg.evaluate(GEO)
    names = [r["u"] for r in g["delBtns"]]
    # guest1 / guest10..guest19 —— 前缀匹配，共 11 个
    check("检索 guest1：命中 11 个（guest1 + guest10..19）", len(names) == 11, str(names))
    check("检索结果里没有不匹配的账号", all(n.startswith("guest1") for n in names), str(names[:5]))
    check("筛不到时显示「没有匹配的账号」而不是「暂无账号」",
          pg.evaluate("""() => { const f = document.querySelector('.tu-filter .ant-input');
                        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        set.call(f, 'zzz-nobody'); f.dispatchEvent(new Event('input', {bubbles: true}));
                        return document.querySelector('.tu-empty') ? document.querySelector('.tu-empty').textContent : ''; }""")
          .find("没有匹配") >= 0)
    check("检索/筛选**不发新请求**（只筛本地已有的那份）",
          pg.evaluate("() => window.__calls.filter(c => c.method === 'GET').length") == 1,
          str(pg.evaluate("() => window.__calls")))
    # 迁移锁（20260926）：这一页从"六处裸 fetch + 手拼 Bearer"改成走共享 axios 客户端，
    # 判据不是"代码里没有 fetch 这个词"，而是**运行时一条都没发出去**。
    check("账号管理不再走裸 fetch（一条都没有）", zero_bare_fetch(pg) == [],
          str(zero_bare_fetch(pg)))
    check("第二节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 三、密码框摘挂（浏览器回填的根因）──────────────────────────────────────
    # Chrome 的规则：判定为凭据的字段忽略 `autocomplete="off"`；页面没有 `<form>` 时
    # 它把整页散落的输入框当成一个**合成表单**——于是"页面上常驻一个密码框"就等于
    # "本页是登录页"，它便去回填页面上最裸的文本框（这里就是新建账号那两格）。
    # 触发器只有一个：那个常驻的改密弹窗。这条锁的就是它。
    print("\n【三】新建账号框不再被浏览器回填（根因：常驻密码框已摘挂）")
    pg = mount(br)
    g = pg.evaluate(GEO)
    check("前置：改密弹窗是常驻挂载的（forceRender 生效，wrap 在 DOM 里）",
          g["modalWrap"] >= 1, f'modalWrap={g["modalWrap"]}')
    check("常态：全页只有 1 个密码框（新建账号那一个）",
          g["pwCount"] == 1 and g["pwInCreate"] == 1,
          f'全页={g["pwCount"]} 新建表单内={g["pwInCreate"]} 别处={g["pwElsewhere"]}')

    pg.locator(".tu-row .ant-btn", has_text="修改密码").first.click()
    pg.wait_for_timeout(300)
    g_open = pg.evaluate(GEO)
    check("开「修改密码」：页面上多出 1 个密码框（共 2 个）", g_open["pwCount"] == 2,
          f'全页={g_open["pwCount"]} 别处={g_open["pwElsewhere"]}')

    # antd 会给两个汉字的按钮插一个空格（渲染成「取 消」）⇒ 不能按整词匹配，按序取第一个
    pg.locator(".ant-modal-footer .ant-btn").first.click()
    pg.wait_for_timeout(400)
    g_closed = pg.evaluate(GEO)
    check("关窗后回到 1 个密码框（改密框已从 DOM 摘掉）",
          g_closed["pwCount"] == 1 and g_closed["pwElsewhere"] == 0,
          f'全页={g_closed["pwCount"]} 别处={g_closed["pwElsewhere"]}')
    check("关窗后弹窗壳仍在 DOM 里（说明摘的是框、不是整个弹窗——符合 forceRender 的形态）",
          g_closed["modalWrap"] >= 1, f'modalWrap={g_closed["modalWrap"]}')
    check("新建账号框声明为新建凭据（autocomplete=new-password）",
          pg.evaluate("""() => { const i = [...document.querySelectorAll('.tu-create input')]
                                  .find((x) => x.type === 'password'); return i ? i.autocomplete : ''; }""")
          == "new-password")
    check("第三节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 四、评论管理：同款内滚动 + 表头吸顶 + 分页条钉底 ────────────────────────
    print("\n【四】评论管理：工具栏固定、表头吸顶、分页条钉底")
    pg = mount(br, path="/dashboard/users?tab=review", wait=".BoardManage .ant-table-row")
    pg.wait_for_timeout(400)
    g = pg.evaluate("""() => {
        const R = (el) => { const b = el.getBoundingClientRect();
            return {t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1)}; };
        const q = (s) => document.querySelector(s);
        const sc = q('.bm-scroll');
        return {
            root: R(document.getElementById('root')),
            bm: R(q('.BoardManage')), bar: R(q('.bm-toolbar')), review: R(q('.bm-review')),
            sc: R(sc), foot: R(q('.bm-foot')),
            overflow: getComputedStyle(q('.BoardManage')).overflowY,
            scroll: {sh: sc.scrollHeight, ch: sc.clientHeight},
            rows: document.querySelectorAll('.bm-scroll .ant-table-row').length,
            pagers: document.querySelectorAll('.bm-foot .ant-pagination-item').length,
            paginationInTable: document.querySelectorAll('.bm-scroll .ant-pagination').length,
            tabs: q('.bm-tabs .sel') ? q('.bm-tabs .sel').textContent : '',
        };
    }""")
    check("评论管理真的挂上了（默认落在 ?tab=review）", g["rows"] == 10, f'rows={g["rows"]}')
    check("前置：表格内容真的溢出了（否则滚动断言是空转）",
          g["scroll"]["sh"] > g["scroll"]["ch"] + 40, f'{g["scroll"]["sh"]} vs {g["scroll"]["ch"]}')
    check("整块不再自己滚（.BoardManage overflow-y: hidden）", g["overflow"] == "hidden", g["overflow"])
    check("滚动落在表格区上（.bm-scroll overflow-y: auto）",
          pg.evaluate("() => getComputedStyle(document.querySelector('.bm-scroll')).overflowY") == "auto",
          pg.evaluate("() => getComputedStyle(document.querySelector('.bm-scroll')).overflowY"))
    check("分页条移出了滚动区（表格里没有 .ant-pagination）", g["paginationInTable"] == 0,
          f'in-table={g["paginationInTable"]}')
    # 同账号那一条：`.BoardManage` 有 20px 下内边距，分页条落在那之内就算钉住了
    foot_gap = g["bm"]["b"] - g["foot"]["b"]
    check("分页条钉在卡片底部（下方只留容器那 20px 内边距）",
          0 <= foot_gap <= 24, f'分页底 {g["foot"]["b"]} / 块底 {g["bm"]["b"]}（差 {foot_gap:.1f}px）')
    # 真正的判据是"它在滚动区**之外**"（在下面、只隔一个 flex gap），不是"贴着某条线"：
    # 贴着线是巧合，而在滚动区之外是"滚多远都看得见"的全部理由
    gap_f = g["foot"]["t"] - g["sc"]["b"]
    check("分页条在滚动区之外（下方只隔一个 flex gap，滚多远都看得见）",
          0 <= gap_f <= 20, f'分页顶 {g["foot"]["t"]} / 滚动区底 {g["sc"]["b"]}（差 {gap_f:.1f}px）')
    check("4 页留言都在（共 40 条 / 每页 10）", g["pagers"] == 4, f'pagers={g["pagers"]}')

    bm_scrollers = pg.evaluate("""() => {
        const row = document.querySelector('.bm-scroll .ant-table-row');
        const out = [];
        for (let el = row.parentElement; el; el = el.parentElement) {
            const oy = getComputedStyle(el).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
                out.push(el.className || el.tagName);
            }
        }
        return out;
    }""")
    check("从留言行往上只有 .bm-scroll 一个可滚祖先（工具栏/审核开关结构上就滚不走）",
          len(bm_scrollers) == 1 and 'bm-scroll' in bm_scrollers[0], str(bm_scrollers))

    stuck = pg.evaluate("""() => {
        const sc = document.querySelector('.bm-scroll');
        const bar = document.querySelector('.bm-toolbar');
        const rev = document.querySelector('.bm-review');
        const th = document.querySelector('.bm-scroll .ant-table-thead th');
        const row0 = document.querySelector('.bm-scroll .ant-table-row');
        const before = { barTop: bar.getBoundingClientRect().top,
                         revTop: rev.getBoundingClientRect().top,
                         rowTop: row0.getBoundingClientRect().top };
        sc.scrollTop = sc.scrollHeight;
        return { before,
                 barTop: bar.getBoundingClientRect().top,
                 revTop: rev.getBoundingClientRect().top,
                 rowTop: row0.getBoundingClientRect().top,
                 thTop: th.getBoundingClientRect().top,
                 scTop: sc.getBoundingClientRect().top,
                 scrolled: sc.scrollTop };
    }""")
    check("滚到底：筛选栏一动不动", abs(stuck["barTop"] - stuck["before"]["barTop"]) < 1,
          f'{stuck["before"]["barTop"]} → {stuck["barTop"]}')
    check("滚到底：审核开关那一行也一动不动", abs(stuck["revTop"] - stuck["before"]["revTop"]) < 1,
          f'{stuck["before"]["revTop"]} → {stuck["revTop"]}')
    check("滚到底：表头吸在滚动区顶沿（sticky 生效）",
          stuck["scrolled"] > 20 and abs(stuck["thTop"] - stuck["scTop"]) < 2,
          f'th={stuck["thTop"]} 区顶={stuck["scTop"]} scrollTop={stuck["scrolled"]}')
    check("滚到底：留言行确实滚上去了",
          stuck["rowTop"] < stuck["before"]["rowTop"] - 100,
          f'{stuck["before"]["rowTop"]} → {stuck["rowTop"]}')

    # 筛选条件一变就回第一页：否则会停在"第 3 页"而结果只剩 1 页，表格空着
    p1_rows = pg.evaluate("() => [...document.querySelectorAll('.bm-scroll .bm-content')].map((e) => e.textContent)")
    pg.locator(".bm-foot .ant-pagination-item-2").first.click()
    pg.wait_for_timeout(300)
    check("翻到第 2 页", pg.evaluate(
        "() => document.querySelector('.bm-foot .ant-pagination-item-active').textContent") == "2")
    # 判"切片真的换了一批"而不是"第 11 条"：假数据是按 createTime 排的（测试里没有
    # 真实时序保证），盯死某一条等于把假数据的排序当成契约
    p2_rows = pg.evaluate("() => [...document.querySelectorAll('.bm-scroll .bm-content')].map((e) => e.textContent)")
    check("第 2 页换了一批行（与第 1 页无重叠、条数仍为 10）",
          len(p2_rows) == 10 and not (set(p2_rows) & set(p1_rows)),
          f'第1页首行={p1_rows[0]} 第2页首行={p2_rows[0]} 重叠={sorted(set(p2_rows) & set(p1_rows))}')
    pg.locator(".bm-tabs button", has_text="愿").first.click()
    pg.wait_for_timeout(300)
    check("换筛选条件后回到第 1 页（不停在结果之外的空页）",
          pg.evaluate("() => document.querySelector('.bm-foot .ant-pagination-item-active').textContent") == "1",
          pg.evaluate("() => document.querySelector('.bm-foot').textContent"))
    check("换筛选后计数与行数一致（只有「愿」这一档 = 10 条）",
          "共 10 条留言" in pg.evaluate("() => document.querySelector('.bm-count').textContent")
          and pg.evaluate("() => document.querySelectorAll('.bm-scroll .ant-table-row').length") == 10,
          pg.evaluate("() => document.querySelector('.bm-count').textContent"))
    check("第四节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 五、冻结账号（20260926）────────────────────────────────────────────────
    # 这一节要证明的是一条**端到端**的事：点「冻结」真的会让那一行从"正常"变成
    # "冻结"，而这件事在页面上看得见、在库里（这里是桩）也真的改了。
    # 只断言"按钮文案变成解冻"是不够的——文案可以由本地 state 翻转出来，
    # 而后端一个字节都没收到。
    print("\n【五】账号管理的冻结账号筛选与冻结/解冻")
    pg = mount(br)

    # ① 冻结筛选只按状态（不看角色）
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    g = pg.evaluate(GEO)
    frozen_names = sorted(r["u"] for r in g["freezeBtns"])
    check("筛「冻结账号」：恰好是预置冻结的那两行（guest27/guest28）",
          frozen_names == ["guest27", "guest28"], str(frozen_names))
    check("冻结行上都带「已冻结」标签", all(r["tag"] for r in g["freezeBtns"]), str(g["freezeBtns"]))
    check("冻结行上的按钮是「解冻」且不套 danger 色",
          all(r["label"] == "解冻" and not r["danger"] for r in g["freezeBtns"]), str(g["freezeBtns"]))
    check("计数跟着筛（共 2 个账号）", "共 2 个账号" in g["count"], g["count"])

    # ② 角色筛选**不**排除冻结账号（"他是普通用户"与"他现在不能用"同时为真）
    pg.locator(".tu-tabs button", has_text="普通用户账号").first.click()
    pg.wait_for_timeout(250)
    g = pg.evaluate(GEO)
    names = [r["u"] for r in g["delBtns"]]
    check("筛「普通用户账号」时冻结行**仍在**（角色筛选不吞掉状态信息）",
          "guest27" in names and "guest28" in names and len(names) == 29, f'{len(names)} 行')

    # ③ 未冻结行上是「冻结」、套 danger
    normal = [r for r in g["freezeBtns"] if r["u"] == "guest1"][0]
    check("未冻结行上的按钮是「冻结」且套 danger 色",
          normal["label"] == "冻结" and normal["danger"], str(normal))

    # ④ 点一下 ⇒ **先弹确认框**；取消不许下手，确认之后请求体是 {frozen:false}
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    before = pg.evaluate("() => window.__calls.length")
    pg.locator(".tu-row", has_text="guest27").locator(".tu-freeze-btn").click()
    pg.wait_for_timeout(300)
    dlg = pg.evaluate(STATUS_DIALOG)
    check("点「解冻」是先弹确认框，不是直接下手", dlg is not None, str(dlg))
    check("确认框标题是「解冻账号」（按这一下的方向取，不是一句笼统标题）",
          dlg and dlg["title"] == "解冻账号", str(dlg and dlg["title"]))
    check("确认按钮上的字是动作词「解冻」，不是「确定/OK」",
          dlg and dlg["ok"] == "解冻", str(dlg and dlg["ok"]))
    check("确认框里点了名（写清是哪个账号）", dlg and "guest27" in dlg["body"],
          str(dlg and dlg["body"]))
    check("解冻那一侧的确认按钮不套 danger（与行上按钮同一套极性）",
          dlg and not dlg["okDanger"], str(dlg and dlg["okDanger"]))
    check("**弹窗开着的时候一个状态请求都没发**（动作必须等那一下确认）",
          status_posts(pg) == [], str(status_posts(pg)))

    # ④b 取消 ⇒ 什么都不该发生（"取消也要真的取消"是最容易写成样子货的一条）
    # 按类名取取消按钮，不按 `.ant-btn-default` 取：改密码那个弹窗是 forceRender 的，
    # 它的取消按钮此刻也在 DOM 里（display:none），按类名取会命中两个。
    pg.locator(".tu-status-cancel").click()
    pg.wait_for_timeout(300)
    check("点取消：弹窗关掉且**零请求**（没有偷偷把动作做掉）",
          pg.evaluate(STATUS_DIALOG) is None and status_posts(pg) == [],
          f'dlg={pg.evaluate(STATUS_DIALOG)} posts={status_posts(pg)}')

    # ④c 再来一次并确认 ⇒ 这才是唯一会发请求的路径
    pg.locator(".tu-row", has_text="guest27").locator(".tu-freeze-btn").click()
    pg.wait_for_timeout(300)
    pg.locator(".ant-modal-wrap .tu-status-ok").click()
    pg.wait_for_timeout(600)
    posts = status_posts(pg)
    check("点「解冻」发出 POST /api/temp-users/126/status", len(posts) == 1
          and posts[0]["url"] == "/api/temp-users/126/status", str(posts))
    check("请求体是 {frozen:false}（传目标状态，不是让后端自己取反）",
          posts and posts[0]["body"] == {"frozen": False}, str(posts[0]["body"] if posts else None))
    check("改完重新拉了一次列表（不是只在本地翻转 state）",
          pg.evaluate("() => window.__calls.length") > before + 1,
          f'before={before} after={pg.evaluate("() => window.__calls.length")}')
    check("解冻后它离开「冻结账号」这一档（桩真按请求体改了那一行）",
          [r["u"] for r in pg.evaluate(GEO)["freezeBtns"]] == ["guest28"],
          str([r["u"] for r in pg.evaluate(GEO)["freezeBtns"]]))

    # ⑤ 反向再来一次：冻结一个正常账号 ⇒ 它进冻结档。
    # 行定位用 `:text-is("guest1")` 精确匹配——`has_text` 是包含匹配，
    # 会同时命中 guest1/guest10../guest19（本文件第二节也踩过同一个坑）。
    pg.locator(".tu-tabs button", has_text="全部").first.click()
    pg.wait_for_timeout(250)
    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-freeze-btn').click()
    pg.wait_for_timeout(300)
    dlg2 = pg.evaluate(STATUS_DIALOG)
    check("冻结这一侧：标题「冻结账号」、按钮上是「冻结」",
          dlg2 and dlg2["title"] == "冻结账号" and dlg2["ok"] == "冻结", str(dlg2))
    check("冻结那一侧的确认按钮套 danger（红按钮 = 会让对方下线的那一下）",
          dlg2 and dlg2["okDanger"], str(dlg2 and dlg2["okDanger"]))
    check("冻结的后果写在弹窗里（含「登录状态立即失效」这层意思）",
          dlg2 and "立即失效" in dlg2["body"], str(dlg2 and dlg2["body"]))
    pg.locator(".ant-modal-wrap .tu-status-ok").click()
    pg.wait_for_timeout(600)
    last = status_posts(pg)[-1] if status_posts(pg) else None
    check("点「冻结」发出 {frozen:true}（与解冻走同一个接口、只换请求体）",
          last and last["body"] == {"frozen": True}, str(last))
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    check("冻结后 guest1 出现在冻结档（预置只剩 guest28，加它就是两行）",
          sorted(r["u"] for r in pg.evaluate(GEO)["freezeBtns"]) == ["guest1", "guest28"],
          str(sorted(r["u"] for r in pg.evaluate(GEO)["freezeBtns"])))

    # ⑥ 未登记的状态值也按冻结处理 —— 前端那句"与后端 is_frozen 同口径"是要**验**的。
    # 后端判的是 `status != 0`（不是 `== 1`），库里出现第三种值时两边必须一起往
    # "不能用"倒。判据差一个字符（`!== 0` 写成 `=== 1`）时，这条正好变红。
    pg.evaluate("() => { window.__users.find((u) => u.id === 101).status = 2 }")
    # 顺手点一下解冻（会把 guest1 解掉）：这一下必然重新拉列表，正好把上面改的值带进来
    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-freeze-btn').click()
    pg.wait_for_timeout(300)
    pg.locator(".ant-modal-wrap .tu-status-ok").click()
    pg.wait_for_timeout(600)
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    names = [r["u"] for r in pg.evaluate(GEO)["freezeBtns"]]
    check("未登记的状态值（2）也按冻结处理（与后端 is_frozen 同口径）",
          "guest2" in names and "guest1" not in names, str(names))
    check("第五节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 用户管理页（账号管理 + 评论管理）：全部通过")
