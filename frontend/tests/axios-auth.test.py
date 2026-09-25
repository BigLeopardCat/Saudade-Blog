# -*- coding: utf-8 -*-
"""共享 axios 客户端的**令牌失效通道**（`src/apis/axios.tsx`）：本仓 `frontend/tests/`
里的**第一条 401/403 断言**（20260926）。

**为什么要有它。** `src/apis/axios.tsx` 的响应拦截器里有这样一段：401 ⇒ 清 `tokenKey`
+ 弹「登录状态已过期，请重新登录」+ 1 秒后跳 `/login`；403 ⇒ **什么都不做**（注释里
写着理由：令牌本身有效、只是角色不够，清令牌会让人陷入"登录→被踢→重新登录"的循环）。
这段代码此前**一行覆盖都没有**——测试里所有走 axios 的沙箱都把
`src/apis/axios.tsx` 整个换成桩（`FAKE_AXIOS`），于是"桩里的 http"永远 200，
真客户端那两个分支只存在于"读起来对"这个层面。

它值得单独一条沙箱的理由是：这段代码错了**也不会红**。
  · 401 那条要是没接上（或者调用方绕开客户端自己 `fetch`），管理员令牌失效时看到的
    是一句无信息的「请求失败」，而不是登录页——用户只能自己猜；
  · 403 那条要是"顺手也清令牌"，普通用户一进后台就被踢回登录页，且**每次重登都被踢**
    （他的令牌一直是有效的，403 会一直来）；
  · 跳转延时的 1000ms 要是变成 0，提示语一闪而过等于没提示。

**手段**：这一条与其它沙箱相反，**不桩 axios 模块**——用的是真
`src/apis/axios.tsx`、真 axios（1.20.0）、真 XHR，只在 Playwright 那一层拦住网络
（`page.route`）。所以它验的正是那两个 if 分支本身。判据全在 DOM/localStorage/URL 上，
不看源码（源码扫描锁不住"到底哪个分支被执行了"）。

用法：python3 frontend/tests/axios-auth.test.py
依赖：frontend/node_modules（esbuild/antd/axios）、playwright(python)。
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

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# 入口直接调客户端，不挂 React：这条测试要验的是客户端模块本身，不是某个页面。
# 结果（成功值 / 失败状态码）落在 window 上，由断言侧读。
ENTRY = """\
import http from './src/apis/axios.tsx';

(window as any).__outcome = null;
(window as any).__call = (url: string) => {
  (window as any).__outcome = null;
  http.get(url)
    .then((r: any) => { (window as any).__outcome = { ok: true, status: r.status, data: r.data }; })
    .catch((e: any) => {
      (window as any).__outcome = { ok: false, status: (e && e.response && e.response.status) || null };
    });
  return true;
};
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="axios-auth-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")
    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>'
        '<body><div id="root"></div><script src="bundle.js"></script></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静态沙箱的服务器（**静音**：每次请求的访问日志会落进夜间的
    ~/sandbox_regression.log，那是给人看断言的地方）。

    静音必须靠**子类覆写**，不能写成 `_handler.log_message = lambda *a, **k: None`
    ——`functools.partial` 的实例属性不影响它转发的那个类，那行等于没写（本仓另有
    7 个沙箱就是这么写的，日志里的 `"GET /bundle.js" 200` 噪音即由此而来）。"""

    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

# 被拦截的假后端：路径 → 状态码。真后端在这三种情形下都是 HTTP 状态码层面的事
# （401/403 由 `src/middleware.rs::auth_guard` 直接回，不是 body 里的 code）。
ROUTES = {
    "/api/ok": 200,
    "/api/expired": 401,
    "/api/denied": 403,
}
SEEN = []   # 每次拦截到的 (path, Authorization 头) —— 用来验请求拦截器那条前缀归一


def route_api(route):
    path = urllib.parse.urlparse(route.request.url).path
    auth = route.request.headers.get("authorization")
    SEEN.append((path, auth))
    status = ROUTES.get(path, 404)
    body = json.dumps({"code": 200 if status == 200 else 500, "path": path, "auth": auth})
    route.fulfill(status=status, content_type="application/json", body=body)


def open_page(browser, token=None, url="/api/ok"):
    """新上下文 + 新页面（每个用例一个干净 origin 里的 localStorage），装上路由拦截。"""
    ctx = browser.new_context()
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("**/api/**", route_api)
    pg.goto(URL)
    if token is not None:
        pg.evaluate("(t) => localStorage.setItem('tokenKey', t)", token)
    pg.evaluate("(u) => window.__call(u)", url)
    pg.wait_for_timeout(600)
    return ctx, pg, errs


def outcome(pg):
    return pg.evaluate("() => window.__outcome")


def token_now(pg):
    return pg.evaluate("() => localStorage.getItem('tokenKey')")


def notices(pg):
    """当前屏上的 antd message 文案（抹空白——antd 会在两个汉字间插空格）。"""
    return pg.evaluate("""() => [...document.querySelectorAll('.ant-message-notice-content')]
        .map((e) => e.textContent.replace(/\\s+/g, ''))""")


with sync_playwright() as p:
    br = p.chromium.launch()

    # ── 一、200：正常路径（下面两条 401/403 的对照，也是"桩没把它焊死"的证明）──
    print("\n【一】200：正常放行（拦截器不该吃掉正常响应）")
    ctx, pg, errs = open_page(br, token="x.y.z", url="/api/ok")
    o = outcome(pg)
    check("请求成功且拿到响应体（拦截器原样放行）",
          o and o["ok"] and o["status"] == 200 and o["data"]["path"] == "/api/ok", str(o))
    check("200 不动令牌", token_now(pg) == "x.y.z", str(token_now(pg)))
    check("200 不弹过期提示（提示只在 401 那条分支里）", notices(pg) == [], str(notices(pg)))
    check("一节无页面异常", not errs, "; ".join(errs[:3]))
    ctx.close()

    # ── 二、401：清令牌 + 提示 + 延时跳登录 ────────────────────────────────────
    print("\n【二】401：清本地令牌、弹提示、延时跳 /login")
    ctx, pg, errs = open_page(br, token="x.y.z", url="/api/expired")
    o = outcome(pg)
    check("调用方拿到的是**失败**（拦截器仍 reject，没有把 401 吞成成功）",
          o and not o["ok"] and o["status"] == 401, str(o))
    check("401 立刻清掉 localStorage 的 tokenKey", token_now(pg) is None, str(token_now(pg)))
    _n = notices(pg)
    check("弹出「登录状态已过期，请重新登录」", any("登录状态已过期" in x for x in _n), str(_n))
    # 跳转是**延时**的：提示语得先被看见。这条同时锁住"别把 1000 改成 0"。
    check("此刻**还没**跳走（提示要留得住，不是一闪而过）",
          not pg.url.endswith("/login"), pg.url)
    try:
        pg.wait_for_url("**/login", timeout=5000)
        _jumped = True
    except Exception:
        _jumped = False
    check("约 1 秒后跳到 /login（用户被送到能重新登录的地方）", _jumped, pg.url)
    check("二节无页面异常", not errs, "; ".join(errs[:3]))
    ctx.close()

    # ── 三、403：**刻意什么都不做**（这段不对称是注释里写明的设计，得有人守着）──
    print("\n【三】403：不清令牌、不跳登录（否则普通用户陷入「登录→被踢」循环）")
    ctx, pg, errs = open_page(br, token="x.y.z", url="/api/denied")
    o = outcome(pg)
    check("调用方同样拿到失败（403 仍 reject 给调用方，只是没有全局副作用）",
          o and not o["ok"] and o["status"] == 403, str(o))
    check("403 **不**清令牌（令牌本身是有效的，清的代价是让人反复重登）",
          token_now(pg) == "x.y.z", str(token_now(pg)))
    check("403 不弹「登录状态已过期」（角色不够不是登录过期）",
          not any("登录状态已过期" in x for x in notices(pg)), str(notices(pg)))
    pg.wait_for_timeout(1500)
    check("403 之后 1.5 秒仍停在本页（没有偷偷跳登录）",
          not pg.url.endswith("/login"), pg.url)
    check("三节无页面异常", not errs, "; ".join(errs[:3]))
    ctx.close()

    # ── 四、请求拦截器：Bearer 前缀归一（后端 strip_prefix("Bearer ")，裸 token 会鉴权失败）──
    print("\n【四】请求拦截器：Authorization 形态")
    SEEN.clear()
    ctx, pg, errs = open_page(br, token="bare-token", url="/api/ok")
    check("裸 token 被补成 `Bearer bare-token`（不补的话后端 strip 不掉、鉴权失败）",
          any(a == "Bearer bare-token" for _, a in SEEN), str(SEEN))
    ctx.close()
    SEEN.clear()
    ctx, pg, errs = open_page(br, token="Bearer already", url="/api/ok")
    check("已经是 `Bearer …` 的不重复叠加（不会出现 `Bearer Bearer …`）",
          any(a == "Bearer already" for _, a in SEEN), str(SEEN))
    ctx.close()
    SEEN.clear()
    ctx, pg, errs = open_page(br, token=None, url="/api/ok")
    check("没有令牌时不带 Authorization 头（后台会被 401 挡，但不该发一个 `Bearer null`）",
          all(a is None for _, a in SEEN), str(SEEN))
    check("四节无页面异常", not errs, "; ".join(errs[:3]))
    ctx.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 共享 axios 客户端：令牌失效通道（401/403）全部通过")
