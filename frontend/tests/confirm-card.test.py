# -*- coding: utf-8 -*-
"""写操作确认卡片（#chat-ask）的**真模块 + 真帧**回归台。

为什么必须单起一层（而不是再加一条静态断言）：
  20260923 的事故是"**三跳全绿、UI 上什么都没有**"——agent 侧确认帧签发正常
  （trace 里 consent_popup 在案）、Rust 真转发了（nginx 记的 body_bytes 与按帧重算
  的字节数只差 1）、真前端模块也能把真帧渲染成卡片，**唯一的问题出在时序**：
  卡片挂上去之后几十毫秒，另一次 `reconcileDOM()`（别的窗口写了会话缓存 ⇒ 本轮
  收尾补拉历史）把它当成"无 data-mid 的孤儿"删掉了。这类洞静态读代码看不出来
  （两段代码各自都对），HTTP 探针也看不见（探针不发浏览器点击、不看 DOM），
  只有"真模块 + 真帧 + 真时序"这一层能抓住。

本脚本因此不做断言层，做**行为层**：把真帧喂进真 widget（public/live2d-widgets/
下的五个文件，不打包不转译，浏览器直接跑），然后在浏览器里问 DOM 与 ctx.state。

断言（每条都对应一个具体的失败形态）：
  ① 渲染：确认帧 ⇒ 卡片在 .chat-messages 内、末位、可见、按钮/文案与帧一致；
  ② **收尾补拉之后卡片仍在场**——20260923 那个洞的回归锁（触发路径用真路径：
     流式中收到 storage 事件 ⇒ pendingPull ⇒ 收尾补拉 → reconcileDOM）；
  ③ 卡片被摘掉后，下一次 reconcile 自动接回（自愈钩子 onAskResync）；
  ④ 缺 q/token 的确认帧：**上报**（此前静默丢弃）且不弹卡；
  ⑤ 终止帧之后又收到帧：**上报**（三端语义不同：Rust 收 __END__ 即 break，
     前端 continue 继续读——真出现尾部帧时其中一端必然看不见，此前完全无声）。

用法：python3 frontend/tests/confirm-card.test.py
依赖：playwright(python)。不需要 node_modules（widget 是 ES5 风格的 IIFE）。
"""
import functools
import http.server
import json
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "frontend" / "public"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# ── 真帧（形状与线上一致：JSON 编码的文本帧 / __ 前缀的协议帧 / 终止帧）──
def text_frame(s):
    return json.dumps(s, ensure_ascii=False)


def confirm_frame(q="要把《Python asyncio 异步并发》加进收藏吗？",
                  token="FAKE_TOKEN_FOR_TEST_ONLY", with_token=True):
    ask = {"q": q, "id": "c1", "summary": "收藏文章 23",
           "opts": [{"label": "确定", "value": "yes"}, {"label": "取消", "value": "no"}]}
    if with_token:
        ask["token"] = token
    return "__CONFIRM__:" + json.dumps(ask, ensure_ascii=False)


ROUND = [text_frame("好的，我来帮你收藏这篇。"), "__PROCESS__:正在准备操作…",
         confirm_frame(), "__END__"]


def round_with(frames):
    return frames


HARNESS = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>确认卡片回归台</title>
<link rel="stylesheet" href="/live2d-widgets/waifu.css">
<style>
  body { margin: 0; height: 100vh; background: #eef2f6; font-family: system-ui; }
  #waifu { position: fixed; right: 20px; bottom: 0; width: 420px; height: 620px; }
</style></head>
<body>
<div id="waifu"></div>
<script>
  // 上报链替身：真链是 autoload.js 里的 window.__reportError → POST /api/monitor/log
  // （看板娘面板持有上报入口）。这里只收不发，供单测断言"静默失败有没有变响亮"。
  window.__reports = [];
  window.__reportError = function (o) { window.__reports.push(o); };
  // ── fetch 桩：/api/chat/stream 回放真帧；history 的延迟由 __stub 控制 ──
  window.__frames = [];
  // frameDelay：帧与帧之间的间隔（默认 0 = 一次读完，轮次瞬间收尾）。② 腿要靠它
  // 把轮次拉长到"派发 storage 事件时流还在跑"，才能走到 pendingPull 那条真路径。
  // cardShownAt / historyResolvedAt：两个时刻证人（② 腿据此断言 reconcile 真的落在
  // 弹卡之后——没有它们，那条腿可能因为时序不对而退化成永真）。
  window.__stub = { historyDelay: 0, historyCalls: 0, frameDelay: 0,
                    cardShownAt: null, historyResolvedAt: null, pendingAtTrigger: false };
  (function () {
    var enc = new TextEncoder();
    var j = function (obj) {
      return new Response(JSON.stringify(obj), { status: 200,
        headers: { 'Content-Type': 'application/json' } });
    };
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    window.fetch = function (url, init) {
      var u = String((url && url.url) || url);
      if (u.indexOf('/api/chat/stream') >= 0) {
        var raw = window.__frames || [];
        // 用 start + 顺序泵出（而不是 pull）：pull 会在上一个 enqueue 还挂着的
        // setTimeout 里被再次调用，流关闭后那些迟到的 enqueue 会抛
        // "Cannot enqueue into a closed stream"（假警报，非被测代码的问题）
        return Promise.resolve(new Response(new ReadableStream({
          start: async function (c) {
            for (var k = 0; k < raw.length; k++) {
              if (window.__stub.frameDelay) await wait(window.__stub.frameDelay);
              c.enqueue(enc.encode('data: ' + raw[k] + '\\n\\n'));
            }
            c.close();
          }
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      }
      if (u.indexOf('/api/chat/history') >= 0) {
        window.__stub.historyCalls++;
        var d = window.__stub.historyDelay;
        return (d ? wait(d) : Promise.resolve()).then(function () {
          window.__stub.historyResolvedAt = performance.now();
          // DB 行形状（chat-engine 的 mapDbItems 认 role/content/time）
          return j({ items: [{ id: 1, role: 'assistant', time: Date.now(),
                               content: '好的，我来帮你收藏这篇。' }] });
        });
      }
      if (u.indexOf('/api/chat/conversations') >= 0) return Promise.resolve(j({ items: [], id: 1 }));
      return Promise.resolve(j({}));
    };
  })();
  try { localStorage.setItem('tokenKey', 'confirmharness'); } catch (e) {}
</script>
<script src="/live2d-widgets/chat-core.js"></script>
<script src="/live2d-widgets/chat-render.js"></script>
<script src="/live2d-widgets/chat-engine.js"></script>
<script src="/live2d-widgets/chat-stream.js"></script>
<script src="/live2d-widgets/chat-session.js"></script>
<script>
  (function () {
    var ctx = { ver: 'harness', core: window.__waifuChatCore, render: {}, dom: {}, state: {}, ui: {} };
    window.__waifuRender(ctx);
    var engine = window.__waifuEngine(ctx);
    engine.init();
    // 次序照 autoload.js：工厂必须在 engine.init() 之后调用（chat-stream 在工厂层
    // 就把 ctx.dom 解构进闭包，早调 = 拿到空 dom，永不绑定）
    window.__waifuStream(ctx, engine).init();
    try { window.__waifuSession(ctx, engine).init(); } catch (e) {}
    window.__ctx = ctx; window.__engine = engine;
    // 打开面板：卡片在未展开的面板里是 display:none（几何断言要它真可见）
    document.getElementById('waifu-chat').classList.add('active');
    // 时刻证人①：卡片第一次变成 active 的时刻（面板里那张卡是模板节点，永远在）
    var box = document.getElementById('chat-ask');
    new MutationObserver(function () {
      if (window.__stub.cardShownAt === null && box.classList.contains('active')) {
        window.__stub.cardShownAt = performance.now();
      }
    }).observe(box, { attributes: true, attributeFilter: ['class'] });
  })();
</script>
</body></html>
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/__harness.html"):
            body = HARNESS.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, *a):
        pass


def start_server():
    handler = functools.partial(Handler, directory=str(PUBLIC))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


MSG = "小猫咪把我当前在读的文章收藏了"

ASK_STATE = """() => {
  const box = document.getElementById('chat-ask');
  const msgs = document.getElementById('chat-messages');
  const cs = box ? getComputedStyle(box) : null;
  const last = msgs ? msgs.lastElementChild : null;
  return {
    exists: !!box,
    inMessages: !!(box && msgs && box.parentNode === msgs),
    active: !!(box && box.classList.contains('active')),
    keep: !!(box && box.classList.contains('chat-keep')),
    display: cs ? cs.display : null,
    height: box ? Math.round(box.getBoundingClientRect().height) : 0,
    q: box ? document.getElementById('chat-ask-text').textContent : null,
    btns: box ? [...document.getElementById('chat-ask-btns').children].map(b => b.textContent) : [],
    isLast: !!(box && last === box),
    pending: window.__ctx.state.pendingAsk ? 'SET' : null,
    isSending: window.__ctx.state.isSending,
    reports: window.__reports.slice(),
    historyCalls: window.__stub.historyCalls,
    cardShownAt: window.__stub.cardShownAt,
    historyResolvedAt: window.__stub.historyResolvedAt,
    pendingAtTrigger: window.__stub.pendingAtTrigger,
    agentText: [...document.querySelectorAll('#chat-messages .chat-msg.agent .msg-text')]
                 .map(e => e.textContent).join('||'),
  };
}"""

SEND = """(text) => {
  const i = document.getElementById('chat-input');
  i.value = text;
  i.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chat-send').click();
}"""


def run_round(pg, frames, mid_stream=None, frame_delay=0, settle=500):
    """跑一轮：设帧 → 点发送 → （可选）流中回调 → 等收尾 + 收尾后的补拉/reconcile。"""
    pg.evaluate("""(f) => {
      window.__frames = f;
      window.__reports = [];
      window.__stub.cardShownAt = null;
      window.__stub.historyResolvedAt = null;
      window.__stub.pendingAtTrigger = false;
    }""", frames)
    pg.evaluate("(d) => { window.__stub.frameDelay = d; }", frame_delay)
    pg.evaluate(SEND, MSG)
    if mid_stream:
        mid_stream(pg)
    pg.wait_for_function("() => !window.__ctx.state.isSending", timeout=10000)
    pg.wait_for_timeout(settle)


def open_page(b, url):
    """每条腿一个干净页面：boot 期间的会话决议/首拉、上一腿的待办与卡片都不串场。"""
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append("console.error: " + m.text)
          if m.type == "error" else None)
    pg.goto(url, wait_until="load")
    pg.wait_for_function("() => !!window.__ctx && !!window.__ctx.dom.messages", timeout=5000)
    pg.wait_for_timeout(600)      # 让 boot 期间的会话决议/首拉跑完
    return pg, errs


def main():
    httpd, port = start_server()
    url = f"http://127.0.0.1:{port}/"
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()

            # ── ① 渲染：真确认帧 ⇒ 真卡片 ────────────────────────────────
            # （③ 复用同一个页面：它要在"① 刚弹出来的卡片"上做自愈实验）
            print("\n① 确认帧 → 卡片（在对话流内、末位、可见）")
            pg, errs = open_page(b, url)
            run_round(pg, ROUND)
            st = pg.evaluate(ASK_STATE)
            check("卡片存在且在 #chat-messages 内", st["exists"] and st["inMessages"], str(st))
            check("卡片可见（active + 高度 > 0）", st["active"] and st["height"] > 0,
                  f"display={st['display']} height={st['height']}")
            check("问句文本 = 帧里的 q", st["q"] == "要把《Python asyncio 异步并发》加进收藏吗？", repr(st["q"]))
            check("按钮 = 帧里的 opts（确定/取消）", st["btns"] == ["确定", "取消"], str(st["btns"]))
            check("待办仍在（未点击不该被清）", st["pending"] == "SET", str(st["pending"]))
            check("卡片是消息流末位子节点", st["isLast"], f"last={st['isLast']}")
            check("渲染路径无上报", st["reports"] == [], json.dumps(st["reports"], ensure_ascii=False))
            check("本轮回复文本渲染进了气泡", "好的，我来帮你收藏这篇。" in st["agentText"],
                  repr(st["agentText"]))

            # ── ② 收尾补拉（reconcile）之后卡片仍在场 ← 20260923 那个洞 ──
            # 真触发路径：流式中收到 storage 事件（另一窗口写了会话缓存）⇒ 置
            # pendingPull ⇒ 收尾 finally 补拉 → reconcileDOM。补拉响应延迟 150ms，
            # 帧间隔 150ms 让轮次长到"派发时还在流里"。两条时刻证人（cardShownAt /
            # historyResolvedAt）用来证明 reconcile 真的落在弹卡之后——否则这条腿
            # 可能因为时序不对而变成永真（事故当时卡片与 reconcile 相差约 70ms）。
            print("\n② 收尾补拉之后卡片仍在场（本次事故的回归锁）")
            pg2, errs2 = open_page(b, url)
            pg2.evaluate("() => { window.__stub.historyDelay = 150; window.__stub.historyCalls = 0; }")

            def storage_mid_stream(page):
                # key 与 chat-engine 的 historyKey() 同构：tokenKey + conv
                page.evaluate("""() => {
                  const tk = localStorage.getItem('tokenKey');
                  const conv = window.__ctx.state.conv;
                  const key = 'chat_history_' + tk + (conv === null ? '_auto' : '_' + conv);
                  window.dispatchEvent(new StorageEvent('storage', { key: key }));
                  window.__stub.pendingAtTrigger = window.__ctx.state.pendingPull;
                }""")

            run_round(pg2, ROUND, mid_stream=storage_mid_stream, frame_delay=150, settle=900)
            st2 = pg2.evaluate(ASK_STATE)
            check("触发有效（流式中置上了 pendingPull）", st2["pendingAtTrigger"],
                  "未触发 ⇒ 本腿会变成永真，必须红")
            check("补拉真的发生了（收尾补拉是 history 的又一次调用）", st2["historyCalls"] >= 1,
                  str(st2["historyCalls"]))
            check("时序成立：补拉响应落在弹卡之后（reconcile 真的跟在卡片后面）",
                  st2["cardShownAt"] is not None and st2["historyResolvedAt"] is not None
                  and st2["historyResolvedAt"] > st2["cardShownAt"],
                  f"cardShownAt={st2['cardShownAt']} historyResolvedAt={st2['historyResolvedAt']}")
            check("补拉（reconcile）之后卡片仍在消息流内", st2["inMessages"], str(st2))
            check("补拉之后卡片仍可见（active + 高度 > 0）",
                  st2["active"] and st2["height"] > 0, str(st2))
            check("补拉之后待办未被清", st2["pending"] == "SET", str(st2["pending"]))
            check("全程无静默失败上报", st2["reports"] == [], json.dumps(st2["reports"], ensure_ascii=False))
            check("②腿页面无未捕获异常", errs2 == [], " | ".join(errs2[:4]))

            # ── ③ 卡片被摘掉 ⇒ 下一次 reconcile 自动接回（自愈钩子）────
            print("\n③ 卡片被摘掉后自动接回（onAskResync 自愈）")
            pg.evaluate("""() => {
              const box = document.getElementById('chat-ask');
              box.parentNode.removeChild(box);
            }""")
            st0 = pg.evaluate(ASK_STATE)
            check("摘掉后确实不在流里（前置条件）", not st0["inMessages"], str(st0["inMessages"]))
            pg.evaluate("() => window.__engine.pullHistory()")
            # 固定等待而不是 wait_for_function：卡片回不来时这里要给一条红的断言，
            # 不是超时异常（崩了就看不到"哪一条判据说它没回来"）
            pg.wait_for_timeout(800)
            st = pg.evaluate(ASK_STATE)
            check("reconcile 后卡片自己回来了", st["inMessages"] and st["active"], str(st))
            check("回来时仍在末位", st["isLast"], str(st["isLast"]))
            check("自愈过程无上报（这是修复后的正常路径）", st["reports"] == [],
                  json.dumps(st["reports"], ensure_ascii=False))

            # ── ④ 缺 token 的确认帧：上报而不是静默丢弃 ────────────────
            print("\n④ 缺 token 的确认帧 → 上报（此前静默丢弃）")
            pg4, errs4 = open_page(b, url)
            run_round(pg4, [text_frame("好的。"), "__PROCESS__:准备中…",
                            confirm_frame(with_token=False), "__END__"])
            st4 = pg4.evaluate(ASK_STATE)
            rep = [r for r in st4["reports"] if r.get("type") == "confirm_card"]
            check("有 confirm_card 上报", len(rep) == 1, json.dumps(st4["reports"], ensure_ascii=False))
            check("上报里点名缺的是 token（不记令牌内容）",
                  bool(rep) and "token" in rep[0].get("message", "")
                  and "FAKE" not in rep[0].get("message", ""),
                  json.dumps(rep, ensure_ascii=False))
            check("坏帧不弹卡（待办仍为空）", st4["pending"] is None and not st4["active"], str(st4))
            check("④腿页面无未捕获异常", errs4 == [], " | ".join(errs4[:4]))

            # ── ⑤ 终止帧之后又收到帧：上报（行为不变）──────────────────
            print("\n⑤ 终止帧之后再收到帧 → 上报（三端语义漂移的探照灯）")
            pg5, errs5 = open_page(b, url)
            run_round(pg5, [text_frame("第一段。"), "__END__", text_frame("终止帧之后的尾巴。")])
            st5 = pg5.evaluate(ASK_STATE)
            rep = [r for r in st5["reports"] if r.get("type") == "confirm_card"]
            check("有 confirm_card 上报", len(rep) == 1, json.dumps(st5["reports"], ensure_ascii=False))
            check("上报点名'终止帧之后'", bool(rep) and "终止帧之后" in rep[0].get("message", ""),
                  json.dumps(rep, ensure_ascii=False))
            check("尾部帧照常渲染（行为不变，只是响亮）", "尾巴" in st5["agentText"], repr(st5["agentText"]))
            check("⑤腿页面无未捕获异常", errs5 == [], " | ".join(errs5[:4]))

            check("①③腿页面无未捕获异常", errs == [], " | ".join(errs[:4]))
            b.close()
    finally:
        httpd.shutdown()

    print()
    if FAILS:
        print(f"✗ confirm-card：{len(FAILS)} 条失败")
        for f in FAILS:
            print("  - " + f)
        return 1
    print("✓ confirm-card：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
