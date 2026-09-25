# -*- coding: utf-8 -*-
"""公告弹窗"发出来当场收到"的无头验收（20260926）：真组件 + 假后端 + 真事件。

为什么值得单起一个脚本（而不是只靠 tests/announcement-popup.test.mjs）：
  · mjs 套件锁的是 pending.ts 那层**判据**（该不该弹、已读记哪、什么时候查）；
    而用户报的是**看得见的行为**——"弹不出来""只有刷新才弹"。这两件事之间隔着组件：
    重入守卫（已弹着就不再换正文）、关窗后的抑制、以及 antd Modal 真的开没开。
  · 本脚本验的就是那一段：**不刷新、不重新挂载**，只把后台发布这个事件送进来，
    弹窗自己出现。

沿用 dashboard-announcement-refresh.test.py / user-center.test.py 那套既定手段
（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把**真组件**打成一个 bundle、
只桩边界（axios），antd 与 react-dom 用真的。

用法：python3 frontend/tests/announcement-popup-mount.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)。
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

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# 边界：假后端。按 URL 查 `window.__routes` 里那一版响应（测试中途换掉它 = 服务端那边变了），
# 每次请求记进 `window.__calls`。
FAKE_AXIOS = """\
const http: any = (cfg: any) => {
  const w = window as any;
  w.__calls.push({ url: cfg.url, method: (cfg.method || 'GET').toUpperCase(), data: cfg.data });
  const r = (w.__routes || {})[cfg.url];
  if (!r) return Promise.resolve({ status: 200, data: { code: 404, message: '没有这个接口' } });
  return Promise.resolve(JSON.parse(JSON.stringify(r)));
};
export default http;
"""

# 装卸分开给（理由同 dashboard-announcement-refresh.test.py：同一次 evaluate 里连着
# render(null) + render(<C/>) 会被 React 18 批量成一次更新，组件其实从没卸载过）。
ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import AnnouncementModal from './src/components/AnnouncementModal/index.tsx';
const root = createRoot(document.getElementById('root')!);
(window as any).__mount = () => root.render(<AnnouncementModal />);
(window as any).__clear = () => root.render(null);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="annpop-verify-"))
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
_handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SANDBOX))
_handler.log_message = lambda *a, **k: None
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

NOTIF = "/api/protected/notifications"
READ = "/api/protected/notifications/read"
PUBLIC = "/api/public/announcements"

SUMMARY = {"status": 200, "data": {"code": 200,
                                   "data": {"notifications": 1, "messages": 0, "total": 1, "pendingReview": 0}}}


def ann_row(rid, title, content, is_read=False, created="2026-09-26 10:00:00"):
    return {"id": rid, "type": "announcement", "title": title, "content": content,
            "link": None, "isRead": is_read, "createdAt": created}


def notif_body(items):
    return {"status": 200, "data": {"code": 200,
                                    "data": {"unread": len([i for i in items if not i["isRead"]]),
                                             "items": items}}}


def ann_body(rows):
    return {"status": 200, "data": {"code": 200, "data": rows}}


def route(page, mapping):
    page.evaluate("(m) => { window.__routes = m; }", mapping)


def calls(page, url=None, method=None):
    return page.evaluate(
        "([u, m]) => window.__calls.filter((c) => (!u || c.url === u) && (!m || c.method === m))",
        [url, method])


def popped(page, text=None):
    """弹窗**可见**（不是"DOM 里有"）：antd 关掉之后 wrapper 仍在，只看 count 会假通过。"""
    loc = page.locator(".ant-modal-content:visible")
    if text:
        loc = page.locator(".ant-modal-content:visible", has_text=text)
    return loc.count() > 0


def set_token(page, token):
    page.evaluate("(t) => { if (t) localStorage.setItem('tokenKey', t);"
                  "        else localStorage.removeItem('tokenKey'); }", token)


def make_page(br):
    page = br.new_page(viewport={"width": 1280, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.add_init_script("window.__calls = []; window.__routes = {};")
    page.goto(URL)
    page.wait_for_timeout(300)
    page.errs = errs
    return page


with sync_playwright() as p:
    br = p.chromium.launch()

    # ── 一、游客：本机水位还是老规矩（键名沿用，老访客不重弹） ──────────────────
    print("\n【一】游客（未登录）：按本机水位 announcement_seen_id")
    pg = make_page(br)
    route(pg, {PUBLIC: ann_body([{"id": 7, "title": "新公告：今晚维护", "content": "正文七",
                                  "createdAt": "2026-09-26 09:00:00",
                                  "updatedAt": "2026-09-26 09:30:00"}])})
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("游客：有新公告 ⇒ 弹窗弹出来了", popped(pg, "新公告：今晚维护"), str(popped(pg)))
    check("游客：弹的是公开接口那份正文", popped(pg, "正文七"))
    pg.click(".ant-modal-close")
    pg.wait_for_timeout(300)
    check("关窗后不在了", not popped(pg))
    seen = pg.evaluate("() => localStorage.getItem('announcement_seen_id')")
    check("游客关窗：已读落在本机水位上", seen == "7", repr(seen))
    check("游客：一次写请求都没发（服务端没有他的身份）",
          len(calls(pg, method="POST")) == 0, json.dumps(calls(pg, method="POST")))

    # 重新挂载（= 刷新）也不该再弹
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("游客：刷新之后不再弹（水位生效）", not popped(pg))

    # ── 二、登录用户：读服务端通知行，关窗即 POST 已读 ─────────────────────────
    print("\n【二】登录用户：判据在服务端（个人中心那份已读与弹窗是同一批行）")
    row = ann_row(9, "公告：本周更新", "正文九")
    route(pg, {NOTIF: notif_body([row]), READ: SUMMARY})
    set_token(pg, "x.y.z")
    # 清空请求记录与上一段留下的水位：本段要独立判"登录的人走哪条接口、已读记在哪"
    watermark_before = pg.evaluate("() => localStorage.getItem('announcement_seen_id')")
    pg.evaluate("() => { window.__calls = []; }")
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("登录：有未读公告行 ⇒ 弹", popped(pg, "公告：本周更新"))
    check("登录：走通知接口，不打公开公告接口",
          len(calls(pg, PUBLIC)) == 0 and len(calls(pg, NOTIF, "GET")) >= 1, json.dumps(calls(pg)))
    pg.click(".ant-modal-close")
    pg.wait_for_timeout(400)
    posts = calls(pg, READ, "POST")
    check("关窗：POST 了一次已读", len(posts) == 1, json.dumps(posts))
    check("关窗：标的是弹过的那一行（ids=[9]，不是 all）",
          bool(posts) and posts[0]["data"] == {"ids": [9], "all": False}, json.dumps(posts))
    watermark_after = pg.evaluate("() => localStorage.getItem('announcement_seen_id')")
    check("登录用户不写本机水位（免得留下第二本账）", watermark_after == watermark_before,
          repr(watermark_before) + " → " + repr(watermark_after))

    # 服务端已读之后再挂载（= 刷新）也不弹
    route(pg, {NOTIF: notif_body([ann_row(9, "公告：本周更新", "正文九", is_read=True)]), READ: SUMMARY})
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("登录：改过（编辑公告不产生新行）之后刷新不重弹",
          not popped(pg), "id/createdAt 没变、isRead 已是 true")

    # ── 三、本轮改动的本体：不刷新，发出来当场收到 ────────────────────────────
    print("\n【三】后台发布 ⇒ 不刷新、不重新挂载，弹窗自己弹出来")
    route(pg, {NOTIF: notif_body([ann_row(9, "公告：本周更新", "正文九", is_read=True)]), READ: SUMMARY})
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("挂载时没有可弹的（最新那条已读）", not popped(pg))
    # 后台公告页发了一条（服务端多了一行未读），紧接着派发发布事件 —— 页面不动
    route(pg, {NOTIF: notif_body([ann_row(31, "公告：新上线的图库", "正文三十一"),
                                 ann_row(9, "公告：本周更新", "正文九", is_read=True)]), READ: SUMMARY})
    pg.evaluate("() => window.dispatchEvent(new CustomEvent('announcement-published'))")
    pg.wait_for_timeout(600)
    check("派发 announcement-published ⇒ 当场弹出来（这就是「发出来用户当时就能收到」）",
          popped(pg, "公告：新上线的图库"))
    check("弹的是新的那条，不是旧的那条",
          not popped(pg, "公告：本周更新 正文九"), "旧卡没被拿来顶替")
    pg.click(".ant-modal-close")
    pg.wait_for_timeout(400)

    print("\n【四】没有信号时不查（不是「每次渲染都查一遍」）")
    route(pg, {NOTIF: notif_body([ann_row(41, "公告：静默期", "正文四十一")]), READ: SUMMARY})
    before = len(calls(pg, NOTIF, "GET"))
    pg.wait_for_timeout(800)          # 60 秒那一拍远没到
    check("不发事件、不切标签页 ⇒ 不查（列表还是旧的那份）",
          len(calls(pg, NOTIF, "GET")) == before, f"{before} → {len(calls(pg, NOTIF, 'GET'))}")
    check("因此也没有弹", not popped(pg, "公告：静默期"))
    pg.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    pg.wait_for_timeout(600)
    check("切回标签页 ⇒ 查一次并弹出来（切回来的那一刻就是想要的时刻）",
          popped(pg, "公告：静默期"))
    pg.click(".ant-modal-close")
    pg.wait_for_timeout(400)

    # ── 五、关掉之后同一页不反复弹（服务端那次已读写失败时也不打扰） ───────────
    print("\n【五】关窗后同一页面不再反复弹同一张卡")
    route(pg, {NOTIF: notif_body([ann_row(41, "公告：静默期", "正文四十一")]), READ: SUMMARY})
    before = len(calls(pg, NOTIF, "GET"))
    pg.evaluate("() => window.dispatchEvent(new CustomEvent('announcement-published'))")
    pg.wait_for_timeout(600)
    check("复查确实发生了（不是「没查所以没弹」）", len(calls(pg, NOTIF, "GET")) > before)
    check("但刚关掉的那条不再弹回来（服务端若写失败，也不该每分钟打扰一次）",
          not popped(pg))

    # ── 六、读不到 ≠ 没有 ────────────────────────────────────────────────────
    print("\n【六】读不到就不弹（不把「读不到」演成「你没读过」）")
    route(pg, {NOTIF: {"status": 200, "data": {"code": 500, "message": "未登录"}}, READ: SUMMARY})
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(600)
    check("通知接口 code=500 ⇒ 不弹", not popped(pg))
    # 失败信封里**带着**一份能弹的内容（token 过期时正文里带不带旧数据不由前端决定）
    route(pg, {NOTIF: {"status": 200, "data": {"code": 500, "message": "未登录",
                                               "data": {"unread": 1, "items": [ann_row(55, "不该弹的公告", "X")]}}},
                READ: SUMMARY})
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(600)
    check("失败信封里带着未读公告也不弹（code ≠ 200 就是读不到）", not popped(pg, "不该弹的公告"))

    # ── 七、游客那条腿也要"当场收到"（访客才是主要读者） ────────────────────────
    print("\n【七】游客：页面开着时发出来也当场收到（本机水位那条腿）")
    set_token(pg, None)
    route(pg, {PUBLIC: ann_body([{"id": 7, "title": "在看的那条公告", "content": "C7",
                                  "createdAt": "2026-09-26 08:00:00"}])})
    pg.evaluate("() => localStorage.setItem('announcement_seen_id', '7')")
    pg.evaluate("() => { window.__calls = []; }")
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("挂载时没有可弹的（水位已到 7）", not popped(pg))
    route(pg, {PUBLIC: ann_body([{"id": 8, "title": "刚发的公告", "content": "C8",
                                  "createdAt": "2026-09-26 09:00:00"},
                                 {"id": 7, "title": "在看的那条公告", "content": "C7",
                                  "createdAt": "2026-09-26 08:00:00"}])})
    pg.evaluate("() => window.dispatchEvent(new CustomEvent('announcement-published'))")
    pg.wait_for_timeout(600)
    check("派发发布事件 ⇒ 游客也当场弹出来（不刷新、不重新挂载）", popped(pg, "刚发的公告"))

    check("全程没有页面错误", not pg.errs, " | ".join(pg.errs))
    pg.close()
    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 条未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 全部通过")
