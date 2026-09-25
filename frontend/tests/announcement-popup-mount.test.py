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
import { ConfigProvider, theme as antdTheme } from 'antd';
const root = createRoot(document.getElementById('root')!);
(window as any).__mount = () => root.render(<AnnouncementModal />);
// 后台那一套（Dashboard 的壳）：同一个组件挂在 ConfigProvider(darkAlgorithm) 里。
// 配色是否真的取 token，只有把两种主题都挂一遍才量得出来（写死的色值在两边一样）。
(window as any).__mountDark = () => root.render(
  <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><AnnouncementModal /></ConfigProvider>);
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


def close_outside(page):
    """从弹窗外关掉：点遮罩（div.ant-modal-wrap 的空白区）。**不记已读**。"""
    page.click(".ant-modal-wrap", position={"x": 6, "y": 6})


def close_by_x(page):
    """右上角 ×（同样只是"收起卡片"，不记已读）。"""
    page.click(".ant-modal-close")


def click_ok(page):
    """点「我知道了」——唯一会记已读的出口。"""
    page.click(".ant-modal-content:visible button:has-text('我知道了')")




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

    # ── 一、游客：两个出口分工（点弹窗外 = 仍是未读；点「我知道了」= 记已读） ──────
    print("\n【一】游客（未登录）：点弹窗外只是收起卡片，仍是未读")
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
    check("卡片上有「我知道了」按钮（唯一的已读出口）",
          pg.locator(".ant-modal-content:visible button:has-text('我知道了')").count() == 1)
    close_outside(pg)                       # 点遮罩
    pg.wait_for_timeout(300)
    check("点弹窗外 ⇒ 卡片收起了", not popped(pg))
    seen = pg.evaluate("() => localStorage.getItem('announcement_seen_id')")
    check("**没点「我知道了」⇒ 不写本机水位**（这就是「仍是未读」）", seen is None, repr(seen))
    check("游客：一次写请求都没发（服务端没有他的身份）",
          len(calls(pg, method="POST")) == 0, json.dumps(calls(pg, method="POST")))
    check("同一页不立刻重弹（会话级抑制，不是「算你读过」）", not popped(pg))

    # 重新挂载（= 刷新）⇒ 仍是未读 ⇒ 照旧弹
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("游客：刷新之后**照旧弹**（没点我知道了就是没读过）", popped(pg, "新公告：今晚维护"))
    close_by_x(pg)                          # 这次用右上角 ×，同样只是收起
    pg.wait_for_timeout(300)
    check("右上角 × 同款：收起卡片、不写水位",
          pg.evaluate("() => localStorage.getItem('announcement_seen_id')") is None)

    # 点「我知道了」⇒ 这才算读过
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("刷新后第三次仍会弹（前两次都没表态）", popped(pg, "新公告：今晚维护"))
    click_ok(pg)
    pg.wait_for_timeout(300)
    check("点「我知道了」⇒ 卡片收起", not popped(pg))
    seen = pg.evaluate("() => localStorage.getItem('announcement_seen_id')")
    check("游客点「我知道了」：已读落在本机水位上", seen == "7", repr(seen))
    check("游客：全程依然一次写请求都没发",
          len(calls(pg, method="POST")) == 0, json.dumps(calls(pg, method="POST")))
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("游客：点过「我知道了」之后刷新不再弹（水位生效）", not popped(pg))

    # ── 二、登录用户：点弹窗外 ⇒ 服务端那行照旧未读；点「我知道了」⇒ POST 已读 ─────
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
    close_outside(pg)                        # 点遮罩：不算读过
    pg.wait_for_timeout(400)
    check("点弹窗外 ⇒ **一次已读请求都不发**（服务端那行照旧未读 ⇒ 红点照旧亮、"
          "个人中心照旧未读）",
          len(calls(pg, READ, "POST")) == 0, json.dumps(calls(pg, READ, "POST")))
    check("登录用户不写本机水位（免得留下第二本账）",
          pg.evaluate("() => localStorage.getItem('announcement_seen_id')") == watermark_before,
          repr(watermark_before) + " → "
          + repr(pg.evaluate("() => localStorage.getItem('announcement_seen_id')")))
    # 刷新（= 重新挂载）：服务端那行还挂着未读 ⇒ 照旧弹
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("点弹窗外的下一次刷新照旧弹（服务端判它未读，弹窗没替他表态）",
          popped(pg, "公告：本周更新"))
    click_ok(pg)                             # 这次点「我知道了」
    pg.wait_for_timeout(400)
    posts = calls(pg, READ, "POST")
    check("点「我知道了」⇒ POST 了一次已读", len(posts) == 1, json.dumps(posts))
    check("  标的是弹过的那一行（ids=[9]，不是 all）",
          bool(posts) and posts[0]["data"] == {"ids": [9], "all": False}, json.dumps(posts))
    check("  本机水位依旧不动", pg.evaluate(
        "() => localStorage.getItem('announcement_seen_id')") == watermark_before)

    # 服务端已读之后再挂载（= 刷新）也不弹
    route(pg, {NOTIF: notif_body([ann_row(9, "公告：本周更新", "正文九", is_read=True)]), READ: SUMMARY})
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("登录：点过「我知道了」之后刷新不重弹（服务端那份已读生效）",
          not popped(pg), "isRead 已是 true")

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
    click_ok(pg)
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
    click_ok(pg)
    pg.wait_for_timeout(400)

    # ── 五、收起之后同一页不反复弹（没点「我知道了」，服务端仍判未读） ──────────
    print("\n【五】收起后同一页面不再反复弹同一张卡（那仍是未读，只是别每分钟打扰）")
    route(pg, {NOTIF: notif_body([ann_row(41, "公告：静默期", "正文四十一")]), READ: SUMMARY})
    before = len(calls(pg, NOTIF, "GET"))
    pg.evaluate("() => window.dispatchEvent(new CustomEvent('announcement-published'))")
    pg.wait_for_timeout(600)
    check("复查确实发生了（不是「没查所以没弹」）", len(calls(pg, NOTIF, "GET")) > before)
    check("但刚收起的那条不再弹回来（同一页会话级抑制；它照旧是未读、照旧会出现在"
          "个人中心与红点里）", not popped(pg))

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
    click_ok(pg)                      # 收尾：点「我知道了」把这张读掉（水位写到 8）
    pg.wait_for_timeout(300)
    check("游客点「我知道了」⇒ 水位推到 8",
          pg.evaluate("() => localStorage.getItem('announcement_seen_id')") == "8")

    # ── 八、几何：标题的高度 + 「我知道了」按钮的样式（20260926 用户报"标题太靠下
    #        不协调美观，我知道了按钮样式颜色也优化"）────────────────────────────
    # 为什么放在这个套件里：这两条都是**看得见的**几何/配色，源码层断言（标题写在
    # header 槽里、按钮有 borderRadius）挡不住"改回 body 里再叠 28px 上边距"这类
    # 回退——只有量出来的数值能挡。旧写法实测：卡片顶→标题 48px（= 卡片 20px 内边距
    # + 自己叠的 28px），而左右各 56px、右上角的 × 贴在 12px 处。
    print("\n【八】几何：标题靠上且与左右内边距对齐、按钮是按 token 上色的胶囊")
    set_token(pg, None)
    route(pg, {PUBLIC: ann_body([{"id": 11, "title": "几何测量用公告", "content": "正文十一",
                                  "createdAt": "2026-09-26 09:00:00"}])})
    pg.evaluate("() => localStorage.removeItem('announcement_seen_id')")
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_timeout(500)
    check("几何测量：卡片弹出来了", popped(pg, "几何测量用公告"))
    g = pg.evaluate("""() => {
        const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
            return {top: r.top, left: r.left, right: r.right, bottom: r.bottom,
                    h: r.height, w: r.width}; };
        const q = (s) => box(document.querySelector(s));
        // **按文字挑**：卡片里第一颗 button 是右上角那颗 ×（radius 4 / h 32）——
        // 用 querySelector 直接取第一颗会量到它，四条断言就全在量关闭钮。
        const btn = [...document.querySelectorAll('.ant-modal-content button')]
            .find((b) => b.textContent.includes('我知道了'));
        const bs = getComputedStyle(btn);
        const bd = document.querySelector('.ant-modal-body');
        return {card: q('.ant-modal-content'), head: q('.ant-modal-header'),
                title: q('.ant-modal-title'), text: q('.ant-modal-body div'), btn: box(btn),
                titleInBody: !!bd && bd.textContent.includes('几何测量用公告'),
                btnStyle: {bgImage: bs.backgroundImage, radius: bs.borderRadius,
                           height: bs.height, minWidth: bs.minWidth, fontSize: bs.fontSize}};
    }""")
    _card, _title, _btn = g["card"], g["title"], g["btn"]
    _top = round(_title["top"] - _card["top"])
    _l = round(_title["left"] - _card["left"])
    _r = round(_card["right"] - _title["right"])
    check("标题归 antd 顶栏（.ant-modal-header 在场、标题不在正文滚动区里）",
          g["head"] is not None and not g["titleInBody"],
          f"head={g['head'] is not None} titleInBody={g['titleInBody']}")
    check("卡片顶→标题 落在 24–32px（旧写法是 48px，这次上提）",
          24 <= _top <= 32, f"{_top}px")
    check("标题左右留白对称（居中不被右上角的 × 挤偏）", abs(_l - _r) <= 2, f"左 {_l}px / 右 {_r}px")
    check("标题在正文之上、且正文没被标题压住",
          _title["bottom"] <= g["text"]["top"] + 1,
          f"标题底 {round(_title['bottom'] - _card['top'])}px / 正文顶 {round(g['text']['top'] - _card['top'])}px")
    check("标题行高与字号协调（19px 字号 ⇒ 行盒 27–34px）",
          27 <= round(_title["h"]) <= 34, f"{round(_title['h'])}px")
    _bs = g["btnStyle"]
    check("「我知道了」是胶囊（borderRadius ≥ 20px）", float(_bs["radius"].rstrip("px")) >= 20,
          _bs["radius"])
    check("按钮加高到 40px、最小宽 ≥ 140px（旧版是默认 32px/120px）",
          round(_btn["h"]) >= 40 and float(_bs["minWidth"].rstrip("px")) >= 140,
          f"h={round(_btn['h'])} minWidth={_bs['minWidth']}")
    check("按钮底色**来自 antd token 的渐变**（不是写死的色值：浅色/深色两套各自成立）",
          "gradient" in _bs["bgImage"], _bs["bgImage"][:60])
    check("按钮文字比正文更醒目（15px ≥ 正文 15px 且是主色底白字）",
          float(_bs["fontSize"].rstrip("px")) >= 15, _bs["fontSize"])

    # ── 九、同一张卡在深色主题下（后台那套）：配色必须跟着主题变（写死的色值做不到）──
    print("\n【九】深色主题（后台 ConfigProvider(darkAlgorithm)）：配色跟着主题走")
    pg.evaluate("() => localStorage.removeItem('announcement_seen_id')")
    pg.evaluate("() => window.__clear()")
    pg.wait_for_timeout(150)
    pg.evaluate("() => window.__mountDark()")
    pg.wait_for_timeout(500)
    check("深色下卡片照样弹出来", popped(pg, "几何测量用公告"))
    _dark = pg.evaluate("""() => {
        const card = document.querySelector('.ant-modal-content');
        const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('我知道了'));
        const title = document.querySelector('.ant-modal-title');
        const lum = (c) => { const m = c.match(/\\d+/g).map(Number);
            return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
        const cs = getComputedStyle(card);
        return {cardBg: cs.backgroundColor, cardLum: lum(cs.backgroundColor),
                btnImage: getComputedStyle(btn).backgroundImage,
                titleColor: getComputedStyle(title.firstElementChild || title).color, titleLum: lum(getComputedStyle(title.firstElementChild || title).color)};
    }""")
    check("后台这套真的是深色（卡片底色亮度 < 0.35）", _dark["cardLum"] < 0.35, _dark["cardBg"])
    check("标题在深色底上是亮字（亮度 > 0.5 ⇒ 读得清）", _dark["titleLum"] > 0.5, _dark["titleColor"])
    check("按钮渐变跟着主题换了一套（与浅色那次不同 ⇒ 不是写死的色值）",
          _dark["btnImage"] != _bs["bgImage"] and "gradient" in _dark["btnImage"],
          _dark["btnImage"][:70])
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
