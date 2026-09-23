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
     前端 continue 继续读——真出现尾部帧时其中一端必然看不见，此前完全无声）；
  ⑥ **点下「确定」之后**（20260924 补）：请求真的发出去（看请求体、不看卡片上的字）、
     点下去写的是「确认中…」而非乐观的「已确认」、成功→已确认 / 失败→不确定（不放行
     重试）/ 忙时挡下→回滚成可重试；
  ⑦ 帧带 exp 时令牌到期自动结算成「已过期」，卡片不会永远停在乐观态；
  ⑧ **正常分支的逐跳埋点**（20260924）：frame→card→click→sent→settle 五跳同 id，
     取消/忙挡/竞态回滚/到期/改口打字（hideAsk）各自该缺哪一跳就缺哪一跳，
     且**任何上报都不含令牌**；
  ⑨ **卡片跨刷新**（20260924）：刷新后从存档接回（stage=card + restored=1）、
     已经结算过的卡片刷新后**不许**再回来（存档随结算作废）、过期的存档刷新后
     既不接回也不留在 localStorage 里；接回来的那张点下去撞上服务端的"令牌已用过"
     时，卡片如实写着「已经用过一次了」而不是「网络错误」也不是「已确认」。

★ 两类上报必须分开看（本文件的断言一律按类型过滤，不许写 `reports == []`）：
  `confirm_card` = **失败**（帧坏掉/点了没反应/轮次失败收尾），跨源对账按它数异常
  （eval/trace_reconcile.py 的 MON_FAILURE_TYPES）；`confirm_flow` = **正常链路的逐跳
  记录**。混用会把"用户点了一次确定"数成"一次异常"，判据当天就失准。所以"这条正常
  路径没有静默失败"的断言现在写成 `by_fail(reports) == []`，而"这条路径该有哪几跳"
  写成 `flow_stages(...)`。

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
import time

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
                  token="FAKE_TOKEN_FOR_TEST_ONLY", with_token=True, exp=0):
    """exp = 令牌失效时刻（UTC 秒）。0 = 帧里不带 exp（旧服务端形态，前端按无倒计时处理）。"""
    ask = {"q": q, "id": "c1", "summary": "收藏文章 23",
           "opts": [{"label": "确定", "value": "yes"}, {"label": "取消", "value": "no"}]}
    if with_token:
        ask["token"] = token
    if exp:
        ask["exp"] = exp
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
  //
  // ⚠️ 去重那一条**必须照抄**：autoload.js 的 report() 按 `type|message 前 80 字符|url`
  // 在页面生命周期内去重、重复的整条丢掉（且 seen 不随任何东西清空）。替身若不去重，
  // "同一枚待办被挂第二次"这类事件在沙箱里数得到、在真链上却早被吃掉——断言会在
  // 一个线上不存在的世界里变绿。dropped 计数暴露给断言，用来锁"埋点没被去重吃掉"。
  window.__reports = [];
  window.__reportsDropped = 0;
  window.__seenReports = {};
  window.__reportError = function (o) {
    var key = String(o.type || '') + '|' + String(o.message || '').slice(0, 80)
              + '|' + String(o.url || '');
    if (window.__seenReports[key]) { window.__reportsDropped++; return; }
    window.__seenReports[key] = 1;
    window.__reports.push(o);
  };
  // ── fetch 桩：/api/chat/stream 回放真帧；history 的延迟由 __stub 控制 ──
  window.__frames = [];
  // frameDelay：帧与帧之间的间隔（默认 0 = 一次读完，轮次瞬间收尾）。② 腿要靠它
  // 把轮次拉长到"派发 storage 事件时流还在跑"，才能走到 pendingPull 那条真路径。
  // cardShownAt / historyResolvedAt：两个时刻证人（② 腿据此断言 reconcile 真的落在
  // 弹卡之后——没有它们，那条腿可能因为时序不对而退化成永真）。
  // lastBody / streamCalls：点确定之后**请求到底发出去没有**的唯一证人（⑥ 腿）。
  // 光看卡片上的字是旧版本的病根——那句"已确认"从来不需要请求真的发出去。
  // streamStatus/streamBody：让 /api/chat/stream 回一个**非 200**（⑨ 腿要用 409
  // 「这张令牌已经被用掉了」——服务端如实拒绝时前端该怎么收场）。0 = 照旧回放帧。
  window.__stub = { historyDelay: 0, historyCalls: 0, frameDelay: 0,
                    cardShownAt: null, historyResolvedAt: null, pendingAtTrigger: false,
                    lastBody: null, streamCalls: 0, streamStatus: 0, streamBody: null };
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
        window.__stub.streamCalls++;
        // body 原样留一份：⑥ 腿据此断言"隐藏确认请求真的发出去了，且带着令牌"
        try { window.__stub.lastBody = init && init.body ? String(init.body) : null; } catch (e) {}
        if (window.__stub.streamStatus) {   // 非 200：真链在这里是 Rust 的 JSON 错误体
          return Promise.resolve(new Response(JSON.stringify(window.__stub.streamBody || {}),
            { status: window.__stub.streamStatus, headers: { 'Content-Type': 'application/json' } }));
        }
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
    // 只数**真按钮**（结算后 #chat-ask-btns 里是一个 .chat-ask-note 灰字 div，
    // 按 children 数会把结算文案当成按钮，断言就永远"还有按钮"）
    btns: box ? [...document.querySelectorAll('#chat-ask-btns button[data-ask-value]')]
                  .map(b => b.textContent) : [],
    // 结算行（.chat-ask-note）与卡片状态机（dataset.askState：live/pending/settled）
    note: box ? ((box.querySelector('.chat-ask-note') || {}).textContent || null) : null,
    askState: box ? (box.dataset.askState || null) : null,
    lastBody: window.__stub.lastBody,
    streamCalls: window.__stub.streamCalls,
    isLast: !!(box && last === box),
    pending: window.__ctx.state.pendingAsk ? 'SET' : null,
    isSending: window.__ctx.state.isSending,
    reports: window.__reports.slice(),
    reportsDropped: window.__reportsDropped,
    historyCalls: window.__stub.historyCalls,
    cardShownAt: window.__stub.cardShownAt,
    historyResolvedAt: window.__stub.historyResolvedAt,
    pendingAtTrigger: window.__stub.pendingAtTrigger,
    agentText: [...document.querySelectorAll('#chat-messages .chat-msg.agent .msg-text')]
                 .map(e => e.textContent).join('||'),
    // 整个消息流的文本（失败气泡是 renderFailed 就地改写 live 气泡的内容，未必带
    // .chat-msg.agent 那层结构；要断言"用户到底读到什么"，只有这一份是全的）
    allText: msgs ? msgs.textContent : '',
  };
}"""

SEND = """(text) => {
  const i = document.getElementById('chat-input');
  i.value = text;
  i.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chat-send').click();
}"""


CLICK = """(value) => {
  const btns = document.getElementById('chat-ask-btns');
  const b = btns.querySelector('button[data-ask-value="' + value + '"]');
  if (!b) return { ok: false, reason: 'no-button' };
  b.click();
  // 点击处理器是同步的：同一 tick 读到的就是"点下去那一刻"的界面（⑥ 腿要看的
  // 正是这一刻——旧版本在这里写的是「已确认」，而请求那时一步都没走）
  const box = document.getElementById('chat-ask');
  return {
    ok: true,
    note: (box.querySelector('.chat-ask-note') || {}).textContent || null,
    btns: [...btns.querySelectorAll('button[data-ask-value]')].map(x => x.textContent),
    askState: box.dataset.askState || null,
    q: document.getElementById('chat-ask-text').textContent,
    pending: window.__ctx.state.pendingAsk ? 'SET' : null,
    reports: window.__reports.slice(),
  };
}"""


def reset_evidence(pg):
    """清零上报与两个证人（弹卡那一轮自己也会发请求、也可能上报，会串进下一条断言）。"""
    pg.evaluate("""() => {
      window.__reports = [];
      window.__stub.lastBody = null;
      window.__stub.streamCalls = 0;
    }""")


ASK_ID = "c1"        # confirm_frame 里签发的待办标识（逐跳埋点靠它串成同一件事）


def by_fail(reports):
    """只看**失败**上报（confirm_card）。理由见文件头「两类上报必须分开看」。"""
    return [r for r in reports if r.get("type") == "confirm_card"]


def flow_stages(reports, ask_id=None):
    """正常链路埋点 → [(stage, 字段字典), ...]，按上报先后。

    ask_id 给了就只留同一次待办（同一件事的五跳才该串成一条链）；id 对不上/缺 id 的
    被滤掉 ⇒ 断言会以"少了一跳"的形式红，而不是悄悄放过（埋点里 id 若丢了，这里
    必然看得出）。
    """
    out = []
    for r in reports or []:
        if r.get("type") != "confirm_flow":
            continue
        kv = dict(p.split("=", 1) for p in (r.get("message") or "").split(" ") if "=" in p)
        if ask_id is not None and kv.get("id") != ask_id:
            continue
        out.append((kv.get("stage"), kv))
    return out


def flow_message(reports):
    return json.dumps([r.get("message") for r in (reports or [])], ensure_ascii=False)


def flow_monotone(seq):
    """这一串的序号是不是严格递增且步长 1。

    这就是"没被去重吃掉"的判据：序号只增不改 ⇒ 同一条消息不会出现两次（真链按
    `type|message|url` 去重，重复即整条丢失）。**不是"从 1 开始"**——沙箱的确认帧
    里 id 恒为 c1，所以序号是跨腿连续增长的（线上 id 每次弹窗新签，才会各自从 1 起）。
    """
    ns = [int(kv.get("n") or 0) for _, kv in seq]
    return bool(ns) and all(b - a == 1 for a, b in zip(ns, ns[1:]))


def settle_leftover(pg):
    """把上一条腿留下的**可点**卡片就地取消掉。

    不这么做，下一腿的 run_round 一按发送就会先撞上 sendMessage 的 hideAsk（用户改口
    打字 ⇒ 未点过的卡片作废），那条 settle(cancel) 会混进下一腿的序列里。清在
    run_round 之前，而 run_round 开头的清零会把这条记录一并抹掉。
    """
    pg.evaluate(CLICK, "no")


def set_frames(pg, frames):
    """只换帧、清上报与证人（不点发送）——给"点确定"那几条腿用。"""
    reset_evidence(pg)
    pg.evaluate("(f) => { window.__frames = f; }", frames)


def run_round(pg, frames, mid_stream=None, frame_delay=0, settle=500):
    """跑一轮：设帧 → 点发送 → （可选）流中回调 → 等收尾 + 收尾后的补拉/reconcile。"""
    pg.evaluate("""(f) => {
      window.__frames = f;
      window.__reports = [];
      window.__stub.cardShownAt = null;
      window.__stub.historyResolvedAt = null;
      window.__stub.pendingAtTrigger = false;
      window.__stub.lastBody = null;
      window.__stub.streamCalls = 0;
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


def reboot(pg):
    """刷新同一个页面（⑨ 腿的"刷新"就是这个动作）。

    不新开一页：新页拿不到同一份 localStorage 之外的东西——而跨刷新正是靠 localStorage
    活的，新页反而绕开了被测路径（真刷新会清掉内存态与 DOM，只剩存储里的东西）。
    """
    pg.reload(wait_until="load")
    pg.wait_for_function("() => !!window.__ctx && !!window.__ctx.dom.messages", timeout=5000)
    pg.wait_for_timeout(800)      # 让 boot 期间的会话决议/首拉/reconcile 跑完


ASK_STORE = """() => {
  const tk = localStorage.getItem('tokenKey');
  const conv = window.__ctx.state.conv;
  const key = 'chat_ask_' + tk + '_' + conv;
  let raw = null;
  try { raw = localStorage.getItem(key); } catch (e) {}
  let parsed = null;
  try { parsed = JSON.parse(raw || 'null'); } catch (e) {}
  // 前缀下还剩几个键（清理过期存档的判据）
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('chat_ask_' + tk + '_') === 0) n++;
    }
  } catch (e) {}
  return { key: key, conv: conv, raw: raw, parsed: parsed, count: n };
}"""


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
            check("渲染路径无**失败**上报（正常分支的 frame/card 两跳另算，见 ⑧）",
                  by_fail(st["reports"]) == [], flow_message(st["reports"]))
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
            check("全程无静默**失败**上报", by_fail(st2["reports"]) == [],
                  flow_message(st2["reports"]))
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
            check("自愈过程无**失败**上报（这是修复后的正常路径）", by_fail(st["reports"]) == [],
                  flow_message(st["reports"]))
            # 接回这件事本身要留痕（①那轮的 frame→card，加上这一跳接回的 card）：
            # 20260923 的形态是"卡片悄悄不见了"，只记首次挂载则事后只能看到"挂过"。
            # 第二次 card 的**序号必须与第一次不同**——真上报链按 `type|message|url`
            # 去重，序号相同就会被整条吃掉（沙箱绿、线上没有的那种假绿）。
            _seq3 = flow_stages(st["reports"], ASK_ID)
            check("自愈接回也进埋点（第二次 card，同一 id、序号递增没被去重吃掉）",
                  [s for s, _ in _seq3] == ["frame", "card", "card"]
                  and _seq3[1][1].get("n") != _seq3[2][1].get("n"), flow_message(st["reports"]))

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

            # ── ⑥ 点「确定」这条链路：请求真的发出去、卡片按轮次结果结算 ──
            # 20260924 事故本体：卡片写着「已确认」，而那条隐藏请求被忙守卫丢了
            # （跨窗远端轮期间必现），系统里零执行。旧断言全在"渲染"那一侧，点击
            # 之后发生了什么**一个字都没测**——这一腿补的就是这段空白。
            print("\n⑥ 点「确定」：请求真的发出去、卡片按轮次结果结算")
            pg6, errs6 = open_page(b, url)
            run_round(pg6, ROUND)
            st = pg6.evaluate(ASK_STATE)
            check("前置：卡片可点（askState=live，两枚按钮）",
                  st["askState"] == "live" and st["btns"] == ["确定", "取消"], str(st))

            # ⑥a 忙守卫：跨窗远端轮期间点确定（此前**必现**丢包）
            reset_evidence(pg6)            # 弹卡那一轮自己也发过请求，先清零
            pg6.evaluate("() => { window.__ctx.state.remoteRounds = { other: 1 }; }")
            st = pg6.evaluate(CLICK, "yes")
            check("忙时点击：按钮**保持**（这一次点击没有被兑现，还能再点）",
                  st["btns"] == ["确定", "取消"], str(st))
            check("忙时点击：待办仍在（没有被一次性核销掉）", st["pending"] == "SET", str(st))
            check("忙时点击：没有发出任何请求", pg6.evaluate("() => window.__stub.streamCalls") == 0,
                  str(pg6.evaluate("() => window.__stub.lastBody")))
            check("忙时点击：留痕（上报点名'有轮次在跑'）",
                  any("轮次在跑" in r.get("message", "") for r in st["reports"]),
                  json.dumps(st["reports"], ensure_ascii=False))
            pg6.evaluate("() => { window.__ctx.state.remoteRounds = {}; }")

            # ⑥b 正常点击：点下去是「确认中…」，请求带令牌出去，收尾才写「已确认」
            set_frames(pg6, [text_frame("已经把《Python asyncio 异步并发》加进收藏了。"),
                             "__END__"])
            st = pg6.evaluate(CLICK, "yes")
            check("点下去那一刻写的是「确认中…」（**不是**「已确认」——请求还没回）",
                  st["note"] == "确认中…", repr(st["note"]))
            check("点下去那一刻按钮已落地（一次点击只兑现一次）", st["btns"] == [], str(st))
            check("点下去那一刻待办已清（不会被第二次点击重复兑现）", st["pending"] is None, str(st))
            pg6.wait_for_function("() => !window.__ctx.state.isSending", timeout=10000)
            pg6.wait_for_timeout(400)
            st = pg6.evaluate(ASK_STATE)
            check("隐藏确认请求真的发出去了（stream 被调了一次）", st["streamCalls"] >= 1,
                  f"lastBody={st['lastBody']}")
            check("请求体里带着令牌（confirm_token）",
                  bool(st["lastBody"]) and "confirm_token" in st["lastBody"]
                  and "FAKE_TOKEN_FOR_TEST_ONLY" in st["lastBody"], str(st["lastBody"])[:200])
            check("轮次成功后卡片结算为「已确认，结果见下方回复」",
                  st["note"] == "已确认，结果见下方回复", repr(st["note"]))
            check("结算后按钮不再放行（askState=settled，无按钮）",
                  st["askState"] == "settled" and st["btns"] == [], str(st))
            check("成功路径无**失败**上报（这不是失败）", by_fail(st["reports"]) == [],
                  flow_message(st["reports"]))

            # ⑥c 轮次失败：请求发出去过 ⇒ 按"不确定"结算，**不放行重试**
            run_round(pg6, ROUND)          # 重新弹一张卡
            set_frames(pg6, [text_frame("好的"),
                             "__ERROR__:" + json.dumps({"msg": "上游炸了"}, ensure_ascii=False)])
            st = pg6.evaluate(CLICK, "yes")
            check("失败轮：点下去同样是「确认中…」", st["note"] == "确认中…", repr(st["note"]))
            pg6.wait_for_function("() => !window.__ctx.state.isSending", timeout=10000)
            pg6.wait_for_timeout(400)
            st = pg6.evaluate(ASK_STATE)
            check("失败轮结算为「不确定有没有生效」", bool(st["note"]) and "不确定" in st["note"],
                  repr(st["note"]))
            check("失败轮**不放行重试**（请求发出去过，重签一次字可能造成第二次执行）",
                  st["btns"] == [] and st["pending"] is None, str(st))
            check("失败轮留痕（上报点名本轮以失败收尾）",
                  any("以失败收尾" in r.get("message", "") for r in st["reports"]),
                  json.dumps(st["reports"], ensure_ascii=False))

            # ⑥d 竞态窗口：点击时守卫放行、请求起飞前才变忙 ⇒ 回滚成可重试
            # 这一支从外面点不出来（忙态要在两步之间翻面），用"给 ensureConversation
            # 塞一个慢 Promise"把这个窗口撑开——它是 sendMessage 里 onDropped 那三个
            # 出口唯一的触发方式，而这三个出口此前正是**静默 return**。
            run_round(pg6, ROUND)
            reset_evidence(pg6)
            pg6.evaluate("""() => {
              window.__origEnsure = window.__engine.ensureConversation;
              window.__engine.ensureConversation = () => Promise.resolve(true).then(() => {
                window.__ctx.state.isSending = true;   // 请求起飞前那一刻变忙
                return true;
              });
            }""")
            st = pg6.evaluate(CLICK, "yes")
            pg6.wait_for_timeout(300)
            st = pg6.evaluate(ASK_STATE)
            check("竞态丢包：卡片**回滚**成可重试（按钮回来了）",
                  st["btns"] == ["确定", "取消"] and st["askState"] == "live", str(st))
            check("竞态丢包：问句下面写明「没发出去」（不是一句乐观的已确认）",
                  "没发出去" in (st["q"] or "") and "可以再点一次" in (st["q"] or ""), repr(st["q"]))
            check("竞态丢包：待办被放回（用户还有一次机会）", st["pending"] == "SET", str(st))
            check("竞态丢包：request 一次都没发", st["streamCalls"] == 0, str(st["lastBody"]))
            pg6.evaluate("""() => {
              window.__engine.ensureConversation = window.__origEnsure;
              window.__ctx.state.isSending = false;
            }""")
            check("⑥腿页面无未捕获异常", errs6 == [], " | ".join(errs6[:4]))

            # ── ⑦ 到期：卡片不会永远停在乐观态（帧带 exp）───────────────────
            print("\n⑦ 令牌到期：卡片自动结算（此前那张卡会永远写着乐观结论）")
            pg7, errs7 = open_page(b, url)
            exp_future = int(time.time()) + 2
            run_round(pg7, [text_frame("好的。"),
                            confirm_frame(exp=exp_future), "__END__"])
            st = pg7.evaluate(ASK_STATE)
            check("前置：带 exp 的帧照样渲染成可点卡片",
                  st["askState"] == "live" and st["btns"] == ["确定", "取消"], str(st))
            pg7.wait_for_timeout(2600)
            st = pg7.evaluate(ASK_STATE)
            check("到期后自动结算为「已过期」（不再保持可点）",
                  bool(st["note"]) and "已过期" in st["note"], repr(st["note"]))
            check("到期后按钮落地、待办清空（点了也不会再发请求）",
                  st["btns"] == [] and st["pending"] is None, str(st))
            check("没点过的卡片到期不上报**失败**（这不是失败，是设计好的失效）",
                  by_fail(st["reports"]) == [], flow_message(st["reports"]))
            # 已经过期的 exp（时钟漂移/长睡）要当场上账，不能等到下一次 tick
            st = pg7.evaluate(CLICK, "yes")   # 此时按钮已没了 ⇒ 点不动，确认前置
            check("到期后按钮点不动（前置确认：按钮真没了）", st["ok"] is False, str(st))
            run_round(pg7, [text_frame("好的。"),
                            confirm_frame(exp=int(time.time()) - 30), "__END__"])
            st = pg7.evaluate(ASK_STATE)
            check("帧里的 exp 已经是过去时刻 ⇒ 当场上账为「已过期」",
                  bool(st["note"]) and "已过期" in st["note"] and st["btns"] == [], repr(st["note"]))
            # 定时器被节流（后台标签页真实会发生）⇒ 按钮还在、令牌却已经过期。
            # 真场景复现法：把长 timeout 吞掉，卡片就一直停在"可点"，然后在过期
            # 之后点它——不挡这一下，服务端必拒、回一句失效文案，而卡片写着"已确认"。
            # 吞定时器必须在**卡片渲染之前**装上：卡片是渲染那一刻起倒计时的，
            # 装晚了（渲染完再吞）真定时器已经登记在案，照样会按时把卡片结算掉。
            pg7.evaluate("""() => {
              window.__origST = window.setTimeout;
              window.setTimeout = (fn, ms) => (ms > 500 ? 0 : window.__origST(fn, ms));
            }""")
            run_round(pg7, [text_frame("好的。"),
                            confirm_frame(exp=int(time.time()) + 600), "__END__"])
            st = pg7.evaluate(ASK_STATE)
            check("前置：长定时器被吞掉后卡片停在可点（节流后它就是不会自己结算）",
                  st["askState"] == "live" and st["btns"] == ["确定", "取消"], str(st))
            # 合成节流的后果：这段时间里令牌真的过期了（把待办里的 exp 拨到过去——
            # 服务端验签比较的正是这个数，前端这里读的也是同一个字段）
            pg7.evaluate("""() => {
              window.__ctx.state.pendingAsk.exp = Math.floor(Date.now() / 1000) - 5;
            }""")
            reset_evidence(pg7)
            set_frames(pg7, [text_frame("（这一轮不该被请求）"), "__END__"])
            st = pg7.evaluate(CLICK, "yes")
            check("过期后点击：本地就上账为「已过期」（不写乐观的已确认）",
                  bool(st["note"]) and "已过期" in st["note"], repr(st["note"]))
            check("过期后点击：**不发那一跳**（服务端必拒，发了只会得到一句自相矛盾的回复）",
                  pg7.evaluate("() => window.__stub.streamCalls") == 0,
                  str(pg7.evaluate("() => window.__stub.lastBody")))
            check("过期后点击：待办清空、按钮落地",
                  pg7.evaluate(ASK_STATE)["pending"] is None and st["btns"] == [], str(st))
            pg7.evaluate("() => { window.setTimeout = window.__origST; }")
            check("⑦腿页面无未捕获异常", errs7 == [], " | ".join(errs7[:4]))

            # ── ⑧ 正常分支的逐跳埋点（20260924）：这条链的失败形态全在屏幕上 ——
            # 帧到了卡片没挂上、点了没发出去、发出去了没有任何结论。只报失败分支
            # 等于**只在事后取证**（用户不截图就无据可查）；有了逐跳记录，跨源对账
            # 能直接看出"点了几次 / 发出去几次 / 结算几次"该相等而不等的那一次。
            # 这一节锁的就是"该有哪几跳、该缺哪几跳"——埋点漂了（少报一跳、id 丢了、
            # 把正常链路混进 confirm_card）在这里全会红。
            print("\n⑧ 正常分支埋点：五跳同 id，不该有的跳不出现（且全程不带令牌）")
            pg8, errs8 = open_page(b, url)

            # 前置自检：替身照抄的那条去重规则**是活的**。少了这一条，"⑧整节零丢报"
            # 在替身被改回"来者不拒"之后会退化成永真（假绿——正是本节要防的东西）。
            probe = pg8.evaluate("""() => {
              const o = { type: 'confirm_flow', message: 'stage=probe n=0', url: location.href };
              window.__reportError(o); window.__reportError(o);
              return { dropped: window.__reportsDropped, kept: window.__reports.length };
            }""")
            check("⑧前置：同一条上报两次只留一条（替身的去重与真链同规则）",
                  probe["dropped"] == 1 and probe["kept"] == 1, json.dumps(probe))
            reset_evidence(pg8)
            pg8.evaluate("() => { window.__reportsDropped = 0; }")

            # ⑧a 完整链路：点「确定」成功 = frame→card→click→sent→settle(ok)
            run_round(pg8, ROUND)
            st = pg8.evaluate(ASK_STATE)
            check("⑧a 弹卡两跳 frame→card（同一 id：帧到的时刻 / 卡片就位的时刻）",
                  [s for s, _ in flow_stages(st["reports"], ASK_ID)] == ["frame", "card"],
                  flow_message(st["reports"]))
            pg8.evaluate("(f) => { window.__frames = f; }",
                         [text_frame("已经把《Python asyncio 异步并发》加进收藏了。"), "__END__"])
            pg8.evaluate(CLICK, "yes")
            pg8.wait_for_function("() => !window.__ctx.state.isSending", timeout=10000)
            pg8.wait_for_timeout(400)
            st = pg8.evaluate(ASK_STATE)
            seq = flow_stages(st["reports"], ASK_ID)
            check("⑧a 点确定一轮 = frame→card→click→sent→settle 五跳同一 id",
                  [s for s, _ in seq] == ["frame", "card", "click", "sent", "settle"], str(seq))
            check("⑧a 跳上的取值对得上（点的 yes、结论 ok）",
                  len(seq) == 5 and seq[2][1].get("value") == "yes"
                  and seq[4][1].get("result") == "ok", str(seq))
            check("⑧a 序号严格递增（同一秒内的多跳靠它定序，也对账时判少了哪一跳）",
                  flow_monotone(seq), str(seq))
            check("⑧a 正常链路不混用失败类型（confirm_card 只由失败分支发）",
                  by_fail(st["reports"]) == [], flow_message(st["reports"]))
            check("⑧a 上报里**不含令牌**（它是一次同意的唯一凭据，任何一跳都不许带）",
                  all("FAKE_TOKEN" not in json.dumps(r, ensure_ascii=False)
                      for r in st["reports"]),
                  flow_message(st["reports"]))

            # ⑧b 取消 = 有 click、无 sent、settle(cancel)（零请求零副作用）
            run_round(pg8, ROUND)          # 弹卡那一轮自己发过一次请求 ⇒ 基准取此刻
            calls_before = pg8.evaluate("() => window.__stub.streamCalls")
            pg8.evaluate(CLICK, "no")
            pg8.wait_for_timeout(250)
            st = pg8.evaluate(ASK_STATE)
            seq = flow_stages(st["reports"], ASK_ID)
            check("⑧b 取消 = frame→card→click→settle(cancel)，**没有 sent**",
                  [s for s, _ in seq] == ["frame", "card", "click", "settle"]
                  and seq[3][1].get("result") == "cancel", str(seq))
            check("⑧b 取消之后请求数没变（零请求）",
                  st["streamCalls"] == calls_before,
                  f"{calls_before} → {st['streamCalls']}")

            # ⑧c 忙守卫挡下：click 在案、**没有 sent**——对账正是按这个不配对找现场
            run_round(pg8, ROUND)
            pg8.evaluate("() => { window.__ctx.state.remoteRounds = { other: 1 }; }")
            pg8.evaluate(CLICK, "yes")
            pg8.wait_for_timeout(250)
            st = pg8.evaluate(ASK_STATE)
            check("⑧c 忙时点击：只有 click，没有 sent（这一跳确实没出去）",
                  [s for s, _ in flow_stages(st["reports"], ASK_ID)]
                  == ["frame", "card", "click"], flow_message(st["reports"]))
            check("⑧c 忙时点击另有一条**失败**上报（与正常链路分开计数）",
                  len(by_fail(st["reports"])) == 1, flow_message(st["reports"]))
            pg8.evaluate("() => { window.__ctx.state.remoteRounds = {}; }")
            settle_leftover(pg8)           # 这一腿留了一张还活着的卡片（见函数注释）

            # ⑧d 竞态丢包（请求起飞前才变忙）⇒ 回滚：click 有、sent 无、settle(rollback)
            # 这一支是"点了且**确知没发出去**"的唯一出口（另一种失败是"发出去了、
            # 结论未知"，走 settle(unknown)）——两者在卡片上长得像，在埋点里必须分开。
            run_round(pg8, ROUND)
            pg8.evaluate("""() => {
              window.__origEnsure8 = window.__engine.ensureConversation;
              window.__engine.ensureConversation = () => Promise.resolve(true).then(() => {
                window.__ctx.state.isSending = true;   // 请求起飞前那一刻变忙
                return true;
              });
            }""")
            pg8.evaluate(CLICK, "yes")
            pg8.wait_for_timeout(350)
            st = pg8.evaluate(ASK_STATE)
            seq = flow_stages(st["reports"], ASK_ID)
            # 末尾那条 card 是回滚自己重挂的（askRollback ⇒ syncAsk 重建按钮并放回末位）：
            # "回滚"与其他终点在埋点里的分野正在这里——卡片被放回可点，与 unknown/expired
            # 那种"结算完就落地"长得完全不同（少写这条就等于把回滚记成了普通结算）。
            check("⑧d 竞态丢包 = frame→card→click→settle(rollback)→card（放回可点），中间**没有 sent**",
                  [s for s, _ in seq] == ["frame", "card", "click", "settle", "card"]
                  and seq[3][1].get("result") == "rollback", str(seq))
            check("⑧d 那一跳没被去重吃掉（序号连续，缺一条这里就会红）",
                  flow_monotone(seq), str(seq))
            pg8.evaluate("""() => {
              window.__engine.ensureConversation = window.__origEnsure8;
              window.__ctx.state.isSending = false;
            }""")
            settle_leftover(pg8)           # 回滚把卡片放回了可点态（同上）

            # ⑧e 帧里 exp 已是过去时刻 ⇒ 当场上账：出现一个**没有 click** 的 settle
            # （用户没点、系统自己失效——对账时它与"点了没结论"是完全不同的两件事）
            run_round(pg8, [text_frame("好的。"),
                            confirm_frame(exp=int(time.time()) - 30), "__END__"])
            st = pg8.evaluate(ASK_STATE)
            seq = flow_stages(st["reports"], ASK_ID)
            check("⑧e 过期卡片 = frame→card→settle(expired)，没有 click",
                  [s for s, _ in seq] == ["frame", "card", "settle"]
                  and seq[2][1].get("result") == "expired", str(seq))

            # ⑧f 幂等不刷屏：卡片已在位时重复 reconcile 不再报一条 card
            # （否则每次 DOM 重建都刷一条，"卡片就位"会被刷成噪声，对账数不清跳数）
            run_round(pg8, ROUND)
            check("⑧f 前置：卡片就位时是 frame→card 两条",
                  [s for s, _ in flow_stages(pg8.evaluate(ASK_STATE)["reports"], ASK_ID)]
                  == ["frame", "card"])
            pg8.evaluate("""() => { for (let i = 0; i < 3; i++) window.__engine.pullHistory(); }""")
            pg8.wait_for_timeout(700)
            st = pg8.evaluate(ASK_STATE)
            check("⑧f 三次 reconcile 之后仍是 frame→card（在位不重报）",
                  [s for s, _ in flow_stages(st["reports"], ASK_ID)] == ["frame", "card"],
                  flow_message(st["reports"]))
            check("⑧f 期间无失败上报", by_fail(st["reports"]) == [], flow_message(st["reports"]))

            # ⑧g 未点击的收场：用户改口打字（没说"确定"，说了别的）⇒ 卡片作废
            # 这是五个 chain 终点里唯一既不来自点击、也不来自到期的一条，此前**零覆盖**
            # （本轮补埋点时才撞见它：上一腿留下的卡片被下一轮的输入事件取消了）
            set_frames(pg8, [text_frame("好，那我换个说法。"), "__END__"])
            pg8.evaluate(SEND, MSG)
            pg8.wait_for_function("() => !window.__ctx.state.isSending", timeout=10000)
            pg8.wait_for_timeout(300)
            st = pg8.evaluate(ASK_STATE)
            seq = flow_stages(st["reports"], ASK_ID)
            check("⑧g 改口打字：卡片按 settle(cancel) 作废、**没有 click**（用户没点它）",
                  bool(seq) and seq[0][0] == "settle" and seq[0][1].get("result") == "cancel"
                  and "click" not in [s for s, _ in seq], str(seq))
            check("⑧g 卡片上写着「已取消」、待办已清",
                  st["note"] == "已取消" and st["pending"] is None, repr(st["note"]))
            check("⑧g 那一跳是用户新打的那句话，不是确认请求（请求体里没有令牌）",
                  "confirm_token" not in (st["lastBody"] or ""), str(st["lastBody"])[:200])
            # 整节下来**一条都不许被真链的去重规则吃掉**（替身照抄了 autoload.js 的
            # `type|message 前 80 字符|url`）——被吃掉就是线上少了这条记录，沙箱却还在自说自话
            check("⑧整节零丢报（埋点带的序号让重复跳在真链上也活得下来）",
                  pg8.evaluate("() => window.__reportsDropped") == 0,
                  str(pg8.evaluate("() => window.__reportsDropped")))
            check("⑧腿页面无未捕获异常", errs8 == [], " | ".join(errs8[:4]))

            # ── ⑨ 卡片跨刷新：接回来 / 结算过的不回来 / 过期的清掉 ──────────
            # 这张卡此前只活在**当轮的那条 SSE 流**里：刷新、断流、切会话回来，
            # 卡片就永远消失了——而令牌其实还在有效期内（600 秒），主人手里那张
            # "同意问句"被浏览器吃掉了。存档放在主人自己的 localStorage（与登录
            # JWT 同一处，访客连键都建不出来），服务端依旧零状态。
            print("\n⑨ 卡片跨刷新")
            pg9, errs9 = open_page(b, url)
            run_round(pg9, ROUND)
            st = pg9.evaluate(ASK_STATE)
            check("⑨a 前置：卡片可点", st["askState"] == "live" and st["btns"] == ["确定", "取消"],
                  str(st))
            store = pg9.evaluate(ASK_STORE)
            check("⑨a 弹卡那一刻就把卡片存进了 localStorage（按 tokenKey + 会话分桶）",
                  bool(store["conv"]) and bool(store["parsed"]) and store["count"] == 1
                  and store["parsed"].get("token") == "FAKE_TOKEN_FOR_TEST_ONLY"
                  and store["parsed"].get("q") == "要把《Python asyncio 异步并发》加进收藏吗？"
                  and len(store["parsed"].get("opts") or []) == 2
                  and store["key"].endswith("_" + str(store["conv"])),
                  json.dumps(store, ensure_ascii=False)[:400])
            reboot(pg9)
            st = pg9.evaluate(ASK_STATE)
            check("⑨a 刷新后卡片自己回来了（问句/按钮与刷新前逐字一致）",
                  st["inMessages"] and st["active"] and st["askState"] == "live"
                  and st["q"] == "要把《Python asyncio 异步并发》加进收藏吗？"
                  and st["btns"] == ["确定", "取消"] and st["isLast"], str(st))
            check("⑨a 接回来的待办是**活的**（能再点一次，不是一张看着像的静态卡）",
                  st["pending"] == "SET", str(st))
            seq = flow_stages(st["reports"], ASK_ID)
            check("⑨a 接回在埋点里标成 restored=1（对账分得出「刷新接回来」与「帧弹的」，"
                  "且不新造阶段名——FLOW_STAGES 是封闭表）",
                  [s for s, _ in seq] == ["card"] and seq[0][1].get("restored") == "1",
                  flow_message(st["reports"]))
            check("⑨a 接回全程无失败上报（这不是异常路径）", by_fail(st["reports"]) == [],
                  flow_message(st["reports"]))

            # ⑨b 接回来的那张点下去，服务端说"这张令牌已经用过了"（另一个标签页先点了、
            # 或者有人在重放）——第一个点的人真执行了，第二个什么都没做。这不是网络
            # 故障，卡片必须如实收场：不写「已确认」（那是假的），也不许放行重试。
            reset_evidence(pg9)
            pg9.evaluate("""() => {
              window.__stub.streamStatus = 409;
              window.__stub.streamBody = { reply: '', success: false, error: 'confirm_already_used' };
            }""")
            st = pg9.evaluate(CLICK, "yes")
            check("⑨b 点下去那一刻写的是「确认中…」（请求还在路上，结论未知）",
                  st["note"] == "确认中…", repr(st["note"]))
            pg9.wait_for_function("() => !window.__ctx.state.isSending", timeout=10000)
            pg9.wait_for_timeout(400)
            st = pg9.evaluate(ASK_STATE)
            check("⑨b 卡片如实写成「已经用过一次了」（既不是已确认，也不是网络错误）",
                  st["note"] == "这张卡片已经用过一次了（同一张只兑现一次），这次没有重复执行",
                  repr(st["note"]))
            check("⑨b 按钮落地、待办清空（这张卡到此为止，不给再点一次的错觉）",
                  st["btns"] == [] and st["pending"] is None and st["askState"] == "settled", str(st))
            check("⑨b 提示文案不套「网络错误: 」前缀（它不是连接故障，加了前缀就把一句准话读成故障）",
                  "网络错误" not in st["allText"] and "已经用过一次" in st["allText"],
                  repr(st["allText"][-200:]))
            seq = flow_stages(st["reports"], ASK_ID)
            check("⑨b 埋点 = click→sent→settle(used)：确实发出去了、被如实拒绝"
                  "（有 sent 才叫发出去过；used 与 unknown/rollback 是三件不同的事）",
                  [s for s, _ in seq] == ["click", "sent", "settle"]
                  and seq[2][1].get("result") == "used", str(seq))
            check("⑨b 请求体里带着令牌（这一跳是确认请求，不是一句普通发言）",
                  "confirm_token" in (st["lastBody"] or ""), str(st["lastBody"])[:200])
            store = pg9.evaluate(ASK_STORE)
            check("⑨b 结算过就作废存档（少了这一句，刷新后一张已用过的卡会原样回来、又是可点的）",
                  store["raw"] is None and store["count"] == 0,
                  json.dumps(store, ensure_ascii=False)[:300])
            reboot(pg9)
            st = pg9.evaluate(ASK_STATE)
            check("⑨b 刷新之后它没有回来（存档没了 ⇒ 没有可接的卡，也不该编一张出来）",
                  not st["active"] and st["pending"] is None and not st["btns"], str(st))
            check("⑨b 腿页面无未捕获异常", errs9 == [], " | ".join(errs9[:4]))

            # ⑨c/⑨d 不值得接回来的两种存档：过期的、缺件的。这两条都要求会话已决议
            # （未决议时 askKey 直接返回 null——代码刻意不碰存储，而不是去猜一个桶），
            # 所以接着同一个页面跑：此时 conv 已由上面那轮决议成 1。
            store = pg9.evaluate(ASK_STORE)
            check("⑨c 前置：会话已决议（未决议的页面连键都不该建，不是本腿要测的形态）",
                  bool(store["conv"]), json.dumps(store, ensure_ascii=False)[:200])
            pg9.evaluate("""() => {
              const tk = localStorage.getItem('tokenKey');
              localStorage.setItem('chat_ask_' + tk + '_' + window.__ctx.state.conv,
                JSON.stringify({ id: 'c1', q: '过期的问句',
                  opts: [{label: '确定', value: 'yes'}], token: 'FAKE_TOKEN_FOR_TEST_ONLY',
                  exp: Math.floor(Date.now() / 1000) - 60 }));
            }""")
            reboot(pg9)
            st = pg9.evaluate(ASK_STATE)
            store = pg9.evaluate(ASK_STORE)
            check("⑨c 过期的存档：不接回（接回来就是一张点了必被服务端拒的卡）",
                  not st["active"] and st["pending"] is None, str(st))
            check("⑨c 过期存档顺手被清掉（没有读取路径的键不该一直堆在 localStorage 里）",
                  store["raw"] is None and store["count"] == 0,
                  json.dumps(store, ensure_ascii=False)[:300])
            check("⑨c 不接回这件事不算失败（设计好的失效，不是把卡悄悄丢了）",
                  by_fail(st["reports"]) == [], flow_message(st["reports"]))
            pg9.evaluate("""() => {
              const tk = localStorage.getItem('tokenKey');
              localStorage.setItem('chat_ask_' + tk + '_' + window.__ctx.state.conv,
                JSON.stringify({ id: 'c1', q: '问句在但没有令牌', opts: [], token: '', exp: 0 }));
            }""")
            pg9.evaluate("() => window.__engine.pullHistory()")
            pg9.wait_for_timeout(700)
            st = pg9.evaluate(ASK_STATE)
            store = pg9.evaluate(ASK_STORE)
            check("⑨d 缺令牌/缺按钮的存档：不接回（接回来也是一张点不动的卡）",
                  not st["active"] and st["pending"] is None, str(st))
            check("⑨d 缺件存档同样被清掉", store["raw"] is None,
                  json.dumps(store, ensure_ascii=False)[:300])

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
