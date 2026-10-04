# -*- coding: utf-8 -*-
"""SPA 侧错误上报的**真链路**沙箱（20261004）：真浏览器、真
`src/utils/report.ts`、真事件（不桩 fetch、不桩监听器），网络那一层被 Playwright 拦住。

为什么必须有一条这样的：`tests/monitor-report.test.mjs` 验的是纯函数与源码接线，
**它证明不了"事件真的会走到上报"**——而这恰好是这次要修的东西。用户原话是
"前端日志覆盖不够吧，甚至是无效状态"，而"无效"的成因之一就是：以前那套全局捕获
（boot.js）包的是 `fetch`、`error` 监听又没带 capture，于是**资源加载失败从来没进过日志**。
"没进过"这件事，只有让浏览器真的加载一张 404 的图才能验。

六条判据：
  ① ★ 资源加载失败 ⇒ 真的发出一条 `resource_error`（含 url 与 webgl 标记）——这次修的主洞；
  ② ★ **运行时 JS 异常不许被这里再报一遍**（负空间：那归 boot.js 的 `js_error` 管，
     重复上报会把 `dup` 的语义糊掉）；
  ③ 同一处失败重复触发 ⇒ **只发一条**（页内去重，别把一个坏图刷成一百行）；
  ④ 上报端点自己挂掉 ⇒ 不报（否则 401/500 时是自激循环）；
  ⑤ 非资源标签（比如 div 上的 error）不误报；
  ⑥ 请求体形状：`type/message/stack/url/webgl` 四个字段，且 body 里没有换行。

用法：python3 frontend/tests/monitor-client.test.py
依赖：frontend/node_modules（esbuild）、playwright(python)。**低内存机器上串行跑**
（这条与其它沙箱同款要求：无头 Chrome 一次只起一个）。
"""
import functools
import http.server
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse

FE = pathlib.Path(__file__).resolve().parent.parent
FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# `import.meta.env` 是 Vite 注入的，esbuild 不认识 ⇒ 给它一份等价物
# （与 tests/axios-auth.test.py 同一行 DEFINE；`runtimeBaseURL` 走 "" 这一支）
DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# 入口：import 那个副作用模块（之后页面里所有失败都由真事件触发），再把
# **真的 ErrorBoundary** 挂在另一个容器上——渲染期抛错只有 React 能接住，
# 而"接住了并上报了"这件事，源码断言（.mjs 那条）证明不了：它只证明"文件里写了"。
ENTRY = """\
import './src/utils/report';
import React from 'react';
import { createRoot } from 'react-dom/client';
import ErrorBoundary from './src/components/ErrorBoundary';

(window as any).__ready = true;
(window as any).__crash = () => {
  const Boom = () => { throw new Error('sandbox-react-boom'); };
  createRoot(document.getElementById('crash')!).render(
    React.createElement(ErrorBoundary, { scope: 'page' }, React.createElement(Boom))
  );
};
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="monitor-client-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    (sb / "entry.ts").write_text(ENTRY, encoding="utf-8")
    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.ts",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>'
        '<body><div id="root"></div><div id="crash"></div>'
        '<script src="bundle.js"></script></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静音静态服务器：每次请求的访问日志会落进夜间的 ~/sandbox_regression.log，
    那是给人看断言的地方，不该被 `GET /bundle.js 200` 淹掉。**必须靠子类覆写**——
    给 partial 打实例属性不影响它转发的那个类（本仓踩过）。"""

    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

REPORTS = []   # [(path, headers, body_dict_or_None)]


def route_report(route):
    """拦住上报请求，把请求体记下来（**不转发**给真后端：这条套件不依赖服务在跑）。"""
    body = None
    try:
        body = json.loads(route.request.post_data or "null")
    except Exception:
        body = None
    REPORTS.append((urllib.parse.urlparse(route.request.url).path,
                    route.request.headers, body))
    route.fulfill(status=200, content_type="application/json", body='{"ok":true}')


def new_page(browser):
    ctx = browser.new_context()
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("**/api/monitor/log", route_report)
    pg.goto(URL)
    pg.wait_for_function("() => window.__ready === true", timeout=10000)
    return ctx, pg, errs


def posted():
    """只数**真正的上报**（带着 JSON 体的 POST）。

    ④ 那条会拿上报端点当图片地址用，于是同一个路由也会收到一次 **GET**（浏览器的图片
    请求，`body=None`）——把它算进"上报条数"的话，判据就成了"图片请求本身"，不是"有没有
    上报"。区分靠 body 在不在：上报必带 JSON 体。"""
    return [r for r in REPORTS if r[2] is not None]


def fire_resource_error(pg, src):
    """插一张真会 404 的图——`error` 在元素上派发、不冒泡，只有捕获阶段能收到。"""
    pg.evaluate("(s) => { const i = document.createElement('img'); i.src = s;"
                " document.body.appendChild(i); }", src)
    pg.wait_for_timeout(400)


with sync_playwright() as p:
    br = p.chromium.launch()

    print("\n【一】资源加载失败 ⇒ 一条 resource_error（这次修的主洞）")
    ctx, pg, errs = new_page(br)
    fire_resource_error(pg, "/definitely-missing.png?v=1")
    check("真的发出了上报（boot.js 那套在这里一个字都不会发）", len(REPORTS) == 1, str(REPORTS))
    if REPORTS:
        path, headers, body = REPORTS[0]
        check("打的是上报端点", path == "/api/monitor/log", path)
        check("type = resource_error", body and body.get("type") == "resource_error", str(body))
        check("url 带上了那个失败的资源", body and body.get("url", "").endswith("/definitely-missing.png?v=1"),
              str(body and body.get("url")))
        check("message 里说得出是哪种标签挂了（img 还是 script）",
              body and "img" in (body.get("message") or ""), str(body and body.get("message")))
        check("webgl 标记随载荷出去了（yes/no/unknown 三态之一）",
              body and body.get("webgl") in ("yes", "no", "unknown"), str(body and body.get("webgl")))
        check("body 里没有裸换行（一行一记录是对账侧的前提）",
              all("\n" not in str(v) for v in (body or {}).values()), str(body))
        check("Content-Type 是 JSON", "application/json" in (headers.get("content-type") or ""),
              str(headers.get("content-type")))

    print("\n【二】运行时 JS 异常**不**由这里上报（负空间：那归 boot.js 的 js_error）")
    before = len(REPORTS)
    pg.evaluate("() => { setTimeout(() => { throw new Error('sandbox-runtime-boom'); }, 0); }")
    pg.wait_for_timeout(400)
    check("抛了一个真异常，但上报条数没变（target 是 window ⇒ 不是资源失败）",
          len(REPORTS) == before, f"{before} → {len(REPORTS)}")
    check("异常确实发生了（否则上一条是假绿）", any("sandbox-runtime-boom" in e for e in errs),
          "; ".join(errs[:2]))
    ctx.close()

    print("\n【三】同一处失败重复触发 ⇒ 只发一条")
    REPORTS.clear()   # ★ 每条用例自己清账：不清的话数到的是上一节的遗留
    ctx, pg, errs = new_page(br)
    for i in range(3):
        fire_resource_error(pg, "/missing-dedupe.png")
    check("同一个坏资源触发 3 次，只上报 1 条（页内去重）",
          len(posted()) == 1, json.dumps([r[2] for r in posted()], ensure_ascii=False))
    ctx.close()

    print("\n【四】上报端点自己挂掉 ⇒ 不报（自激循环的闸）")
    REPORTS.clear()
    ctx, pg, errs = new_page(br)
    fire_resource_error(pg, "/api/monitor/log")   # 拿上报端点当图片地址：它当然不是图
    check("失败的是上报端点自己 ⇒ 一条上报都没有", posted() == [],
          json.dumps([r[2] for r in posted()], ensure_ascii=False))
    check("（那条 GET 是浏览器取图片本身，不是上报——它没有 JSON 体）",
          all(r[2] is None for r in REPORTS), str(len(REPORTS)))
    ctx.close()

    print("\n【五】非资源标签上的 error 不误报")
    REPORTS.clear()
    ctx, pg, errs = new_page(br)
    pg.evaluate("""() => {
        const d = document.createElement('div');
        document.body.appendChild(d);
        d.addEventListener('error', () => {});           // 让它有个监听器，更有"像是会响"的错觉
        d.dispatchEvent(new Event('error', { bubbles: false }));
    }""")
    pg.wait_for_timeout(300)
    check("div 上派发的 error ⇒ 不报（target 没有 tagName）", posted() == [],
          json.dumps([r[2] for r in posted()], ensure_ascii=False))
    check("五节无页面异常", not errs, "; ".join(errs[:2]))
    ctx.close()

    print("\n【六】React 渲染期抛错：兜底卡挂上、同时上报一条 react_error")
    REPORTS.clear()
    ctx, pg, errs = new_page(br)
    pg.evaluate("() => window.__crash()")
    pg.wait_for_timeout(800)
    _r = posted()
    check("上报了一条 react_error", len(_r) == 1 and _r[0][2].get("type") == "react_error",
          json.dumps([x[2] for x in _r], ensure_ascii=False))
    if _r:
        body = _r[0][2]
        check("message 带上了 scope（知道崩在哪一层）",
              (body.get("message") or "").startswith("page: "), str(body.get("message")))
        check("message 带上了原始异常文本（否则只知道「崩了」）",
              "sandbox-react-boom" in (body.get("message") or ""), str(body.get("message")))
        check("stack 里带 componentStack（指出是哪个组件抛的）",
              "componentStack" in (body.get("stack") or ""), str(body.get("stack")))
        check("url 是当前页", (body.get("url") or "").endswith("/index.html"), str(body.get("url")))
    # 兜底 UI：**用户看见的**那半边（判据不能只落在日志上）
    card = pg.evaluate("() => !!document.querySelector('.errorBoundary__card')")
    check("兜底卡真的渲染出来了（不是白屏）", card is True, str(card))
    _t = pg.evaluate("() => (document.querySelector('.errorBoundary__title') || {}).textContent || ''")
    check("卡上有给用户看的标题", "页面出了点小问题" in _t, str(_t))
    _err = pg.evaluate("() => (document.querySelector('.errorBoundary__msg') || {}).textContent || ''")
    check("卡上写得出原始错误（用户截图就能报上来）", "sandbox-react-boom" in _err, str(_err))
    _btns = pg.evaluate("() => document.querySelectorAll('.errorBoundary__btn').length")
    check("两个出口按钮都在（重试 / 回到首页）", _btns == 2, str(_btns))
    ctx.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ SPA 错误上报真链路：资源失败被捕获、运行时异常不重复、去重与自激闸都在")
