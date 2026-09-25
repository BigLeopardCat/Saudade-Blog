# -*- coding: utf-8 -*-
"""后台公告管理页"列表不刷新"的无头验收（20260925）：真组件 + 假后端 + 真事件。

为什么值得单起一个脚本：
  · 判据全是**事件与时序**（`visibilitychange` / `focus` 到没到、去抖有没有生效、
    页面藏起来时该不该拉）——读代码只能看出"注册了监听"，看不出"到底拉了几次"；
  · 两条路径**必须能分开验**：路由切进本页会重新挂载（`<Outlet/>` 的语义），这条路本来
    就是通的；漏掉的是"本页一直开着、agent 在别处发了公告"。所以第一段先证明"重新挂载
    会重拉"，第二段才验本轮新加的那条。

沿用 user-center.test.py / dashboard-sidebar.test.py 那套既定手段（本机不能 vite build，
见 CLAUDE.md §2）：esbuild 把**真组件**打成一个 bundle、只桩边界（axios），antd 与
react-dom 用真的。

用法：python3 frontend/tests/dashboard-announcement-refresh.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)。
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

# 边界：假后端。两件事——把每次请求记进 `window.__calls`，返回 `window.__rows` 里那一版
# 数据（测试中途换掉它，模拟"agent 在别处发了一条新公告"）。
FAKE_AXIOS = """\
const http: any = (cfg: any) => {
  const w = window as any;
  w.__calls.push({ url: cfg.url, method: (cfg.method || 'GET').toUpperCase() });
  return Promise.resolve({ status: 200, data: { code: 200, data: w.__rows || [] } });
};
export default http;
"""

# 装卸分开给：`__clear` 让组件真的卸载（effect 清理跑一遍），`__mountChild` 再挂一次。
# **不另建 root** —— 对同一个容器调两次 `createRoot` 会吃 React 的告警，而且那样验的是
# "新 root 会不会跑 effect"，不是路由切回来这件事。
ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import AnnouncementPage from './src/pages/Dashboard/Announcement/index.tsx';
const root = createRoot(document.getElementById('root')!);
(window as any).__mount = () => root.render(<AnnouncementPage />);
(window as any).__clear = () => root.render(null);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="ann-verify-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.css=text", "--jsx=automatic",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        # 宽容解码：esbuild 报错行可能落在中文上，严格 utf-8 解会先炸在解码、把真错盖掉。
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>'
        '<body><div id="root"></div><script src="bundle.js"></script>'
        '<script>window.__mount();</script></body></html>', encoding="utf-8")
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

ROWS_1 = ("[{id: 1, title: '旧公告：服务器维护', content: '第一版',"
          "  createdAt: '2026-09-25 10:00'}]")
ROWS_2 = ("[{id: 1, title: '旧公告：服务器维护', content: '第一版',"
          "  createdAt: '2026-09-25 10:00'},"
          " {id: 2, title: '新公告：agent 代发的那条', content: '第二版',"
          "  createdAt: '2026-09-25 11:00'}]")


def get_count(page):
    return page.evaluate(
        "() => (window.__calls || []).filter((c) => c.method === 'GET'"
        " && c.url === '/api/public/announcements').length")


def set_rows(page, js):
    page.evaluate(f"() => {{ window.__rows = {js}; }}")


def make_page(br):
    page = br.new_page(viewport={"width": 1280, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    # `document.hidden` 在无头里恒 false，用可切换的 getter 换掉，才验得了"藏起来时不拉"。
    page.add_init_script(
        "window.__calls = []; window.__rows = []; window.__hidden = false;"
        "Object.defineProperty(document, 'hidden',"
        "  { get: () => window.__hidden, configurable: true });")
    page.goto(URL)
    page.wait_for_selector(".ant-table", timeout=10000)
    page.wait_for_timeout(300)
    page.errs = errs
    return page


with sync_playwright() as p:
    br = p.chromium.launch()

    # ── 一、重新挂载本来就会重拉（路由切进本页走的就是这条） ────────────────────
    print("\n【一】重新挂载 ⇒ 重拉一次（路由 `<Outlet/>` 切进本页的语义）")
    pg = make_page(br)
    base = get_count(pg)
    check("首次挂载拉了一次", base == 1, str(base))
    set_rows(pg, ROWS_1)
    # ⚠️ 卸载与挂载**必须分两次 evaluate**：同一次里连着 render(null) + render(<C/>)，React 18
    # 会把它批量成一次更新，组件其实从没卸载过（本脚本首跑就踩了这个假象，见下"第一版没渲染"）。
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(250)
    check("组件真的卸载了（表格没了）", pg.locator(".ant-table").count() == 0,
          str(pg.locator(".ant-table").count()))
    pg.evaluate("() => window.__mount()")
    pg.wait_for_selector(".ant-table", timeout=10000)
    pg.wait_for_timeout(500)
    n1 = get_count(pg)
    check("卸载再挂载 ⇒ 又拉一次（路由切进本页会看到最新的，走的就是这条）",
          n1 == base + 1, str(n1))
    check("第一版公告渲染出来了",
          pg.locator(".ant-table", has_text="旧公告：服务器维护").count() == 1)

    # ── 二、本页一直开着：切回窗口/标签页 ⇒ 重拉（本轮新加的那条） ─────────────
    print("\n【二】窗口重新获得焦点 / 标签页重新可见 ⇒ 重拉（agent 在别处发的公告能看到了）")
    set_rows(pg, ROWS_2)                      # agent 在别处发了一条
    pg.wait_for_timeout(600)                  # 越过 500ms 去抖窗
    check("还没切回来之前，列表纹丝不动（只在要看的时刻才拉）", get_count(pg) == n1,
          str(get_count(pg)))
    check("新公告那时还不在表里",
          pg.locator(".ant-table", has_text="新公告：agent 代发的那条").count() == 0)

    pg.evaluate("() => window.dispatchEvent(new Event('focus'))")
    pg.wait_for_timeout(600)
    check("窗口获得焦点 ⇒ 拉了一次", get_count(pg) == n1 + 1, str(get_count(pg)))
    check("新公告当场出现在表里",
          pg.locator(".ant-table", has_text="新公告：agent 代发的那条").count() == 1)

    # ── 三、去抖 + "看不见就别拉" ──────────────────────────────────────────────
    print("\n【三】去抖 + 藏起来时不拉")
    pg.evaluate("() => { document.dispatchEvent(new Event('visibilitychange'));"
                "        window.dispatchEvent(new Event('focus')); }")
    pg.wait_for_timeout(300)
    check("切回来时两个信号一起到（visibilitychange + focus）⇒ 去抖成 1 次",
          get_count(pg) == n1 + 2, str(get_count(pg)))

    pg.wait_for_timeout(600)
    pg.evaluate("() => { window.__hidden = true;"
                "        document.dispatchEvent(new Event('visibilitychange')); }")
    pg.wait_for_timeout(300)
    check("页面藏起来时不做无用功", get_count(pg) == n1 + 2, str(get_count(pg)))
    pg.evaluate("() => { window.__hidden = false;"
                "        document.dispatchEvent(new Event('visibilitychange')); }")
    pg.wait_for_timeout(400)
    check("重新可见 ⇒ 又拉一次", get_count(pg) == n1 + 3, str(get_count(pg)))

    # ── 四、页内操作之后的立刻重拉没被改坏 ────────────────────────────────────
    print("\n【四】页内「删除选中」的老行为没被改坏")
    pg.wait_for_timeout(600)
    before = get_count(pg)
    pg.click("text=删除选中")           # 一行都没选 ⇒ message.warning 提前返回、不发请求
    pg.wait_for_timeout(400)
    check("没选行就点删除：不发请求（原行为）", get_count(pg) == before, str(get_count(pg)))

    check("全程没有页面错误", not pg.errs, " | ".join(pg.errs))
    pg.close()
    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 条失败：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 全部通过")
