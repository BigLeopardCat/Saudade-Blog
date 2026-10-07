# -*- coding: utf-8 -*-
"""对话面板「新消息来了窗口不跟着往下滚」的回归台（20261008）。

为什么必须单起一层：这条缺陷**不是**某段代码写错了，而是两个各自都对的机制撞在一起——
  · `chat-engine.js` 用 scroll 事件反推「主人在不在底部」（`userAtBottom`，阈值 60px）；
  · 回底靠「写 `scrollTop = scrollHeight`」（`scrollToBottom` 的双 rAF 与 `pin`）。
而 **scroll 事件不是写完就派发的**（要等下一个渲染机会），它送到时读到的 `scrollHeight`
可能已经被新内容顶高了远不止 60px ⇒ 一次**自己招来的**事件被读成「主人翻上去读历史了」
⇒ `userAtBottom` 翻成 false 并且**再也不翻回来**（真人滚一下才有新的 scroll 事件），
于是 `pin()` 静默早退、`scrollToBottom` 只亮提示条 ⇒ 症状就是"新消息不滚了"，
而且**没有别的信号**（提示条那一路也没亮，见下）。

线上探针（20261008，访客身份、只读）逐帧记到的原话：
    t=2530 写入 261  写前 5   scrollH=261 clientH=183     ← pin 钉底（此刻确在底部）
    t=2553 scroll 事件送达：scrollTop=78 scrollH=335 距底 74 ≥ 60 ⇒ userAtBottom=false
    此后：scrollTop 写入 0 次、scroll 事件 0 次、提示条一直不亮
（261 被浏览器夹成 78 = 261-183 的 max；事件晚到 23ms，期间内容从 261 涨到 335。）

★ **为什么第一条腿（真流式）不是这条缺陷的判据**：帧率快的时候「写入 → 事件送达」
只隔几毫秒，下一次内容长高往往落在窗口**外**，于是真流式跑十次也不红——本脚本第一版
就是这样（真流式全绿、缺陷还在）。所以缺陷本体由第②③腿判：**把「内容长高」按帧序
钉死在「写入之后、事件送达之前」**（见 __pumpStep 的注释，靠 rAF 注册次序而非计时），
这一步在生产里对应"网络分片 / 贴纸图片晚 900ms 到位 / markdown 增强长高"，只是不再靠运气。

（静态断言看不见这类洞——两段代码各自看都对；HTTP 探针也看不见——没有真时序就没有真事件。
所以照 confirm-card 的老规矩：**真模块 + 真时序**，浏览器里问 DOM。）

六条腿：
  ① 真流式（在底部）⇒ 收尾钉底——不是缺陷判据，是"没把正常路径修坏"的对照
  ② 竞态（在底部）⇒ 收尾**仍钉底**：缺陷本体
  ③ 竞态（主人在历史区）⇒ 不拽回**且提示条亮**（20260828f 契约；同时是负控：修法若是
     "把 userAtBottom 那道闸删了"，②会过而这条当场红）
  ④ 主人自己滚回底部 ⇒ 跟随恢复
  ⑤ 提示条点一下 ⇒ 回底且收起（修法若只亮不灭，这条红）

用法：python3 frontend/tests/chat-scroll-follow.test.py
依赖：playwright(python)。不需要 node_modules（widget 是 ES5 风格的 IIFE）。

★ 为什么住在**父仓**（源码在 agent 仓 `frontend/public/live2d-widgets/`）：本套件读的是
`frontend/public/` 里那份**按 `widget.lock.json` 的 pin 取来的**副本——也就是真会发到浏览器
的那一份 ⇒ 它顺带判「pin 没换」（改了 agent 仓却没换 pin，②③腿当场红）。换成读 agent 仓
那份就把这个判据丢了。
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


# ── 真帧：一段段**增量**正文（chat-stream 是 `displayText += text`，帧即 delta）──
CHUNK = ("看板娘把这一段接着往上摞，用来模拟流式回复里一次到达一大段正文的情形，"
         "这一段大约一百二十个字，落在面板里就是八九行的高度。") * 2
ROUND = [json.dumps(CHUNK, ensure_ascii=False) for _ in range(8)] + ["__END__"]

HARNESS = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>滚动跟随回归台</title>
<link rel="stylesheet" href="/live2d-widgets/widget.css">
<style>
  body { margin: 0; height: 100vh; background: #eef2f6; font-family: system-ui; }
  #waifu { position: fixed; right: 20px; bottom: 0; width: 420px; height: 620px; }
</style></head>
<body>
<div id="waifu"></div>
<script>
  window.__reports = [];
  window.__reportError = function (o) { window.__reports.push(o); };
  // ── 采样器：把「距底多少 / 提示条亮没亮」按 20ms 记下来 ──
  // 只读不写（不碰 scrollTop），所以它不会自己制造 scroll 事件、也就不会掩盖被测的竞态。
  // 缺陷最要命的一半是"停摆**且不亮提示条**"（主人连"有新消息"都看不到），而静止状态
  // 在收尾读数里看不见——要把它变成可判的读数，只有全程采样一条路。
  window.__samples = [];
  setInterval(function () {
    var m = document.getElementById('chat-messages');
    if (!m) return;
    var note = document.getElementById('chat-new-msg-note');
    window.__samples.push({
      t: Math.round(performance.now()),
      d: m.scrollHeight - Math.round(m.scrollTop) - m.clientHeight,
      n: !!(note && note.classList.contains('active'))
    });
  }, 20);

  // ── 竞态泵：把「内容长高」钉在「程序化写入之后 / scroll 事件送达之前」的窗口里 ──
  // 时序（不是计时，是**帧序**，所以不看运气）：
  //   本任务：插一条小的 ⇒ MutationObserver 的复合同步微任务**当场**入队（spec：记录
  //           第一笔变异时就把 "notify mutation observers" 挂上）
  //   同任务稍后：Promise 微任务 ⇒ **排在 MO 之后**注册我的 rAF（谁先注册谁先跑）
  //   本帧 rAF：① pin 先跑，写 scrollTop = scrollHeight  ⇒ 事件入队
  //             ② 我这条后跑，插一条高的 ⇒ scrollHeight 当场长高 ~150px
  //   下一帧 scroll 步：事件送到，读到的已经是长高后的高度 ⇒ 距底 ≫ 60
  // ⚠️ 这两条 rAF 的**注册次序**是本脚本的命门：第一版把 rAF 直接写在任务体里，
  //    MO 的微任务还没跑 ⇒ 我的 rAF 反而排在 pin **前**面 ⇒ 长高先发生、pin 后写、
  //    事件读到距底 0 —— 缺陷在测，读数却全绿（"判据永真"的典型形态）。
  var PROBE = 0;
  window.__pumpStep = function (px) {
    var m = document.getElementById('chat-messages');
    var mk = function (h) {
      var d = document.createElement('div');
      d.className = 'chat-msg agent';
      d.dataset.mtype = 'agent';
      d.dataset.mid = 'probe' + (PROBE++);
      var c = document.createElement('span');
      c.className = 'msg-text';
      c.textContent = '探针正文：' + '把这一段堆到足够高。'.repeat(4);
      c.style.display = 'block';
      c.style.minHeight = h + 'px';
      d.appendChild(c);
      return d;
    };
    m.appendChild(mk(20));
    Promise.resolve().then(function () {
      requestAnimationFrame(function () { m.appendChild(mk(px)); });
    });
  };
  window.__pump = function (steps, px) {
    return new Promise(function (res) {
      var i = 0;
      (function next() {
        if (i++ >= steps) return res(true);
        window.__pumpStep(px);
        setTimeout(next, 60);
      })();
    });
  };

  window.__frames = [];
  window.__stub = { frameDelay: 0, historyItems: null, streamCalls: 0 };
  (function () {
    var enc = new TextEncoder();
    var j = function (obj) {
      return new Response(JSON.stringify(obj), { status: 200,
        headers: { 'Content-Type': 'application/json' } });
    };
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    window.fetch = function (url) {
      var u = String((url && url.url) || url);
      if (u.indexOf('/api/chat/stream') >= 0) {
        window.__stub.streamCalls++;
        var raw = window.__frames || [];
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
        return Promise.resolve().then(function () {
          var rows = window.__stub.historyItems
            || [{ id: 1, role: 'assistant', time: Date.now(), content: '在的喵。' }];
          return j({ items: rows });
        });
      }
      if (u.indexOf('/api/chat/conversations') >= 0) return Promise.resolve(j({ items: [], id: 1 }));
      return Promise.resolve(j({}));
    };
  })();
  try { localStorage.setItem('tokenKey', 'scrollharness'); } catch (e) {}
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
    // 次序照 boot.js：工厂必须在 engine.init() 之后调用（chat-stream 在工厂层就把
    // ctx.dom 解构进闭包，早调 = 拿到空 dom，永不绑定）
    window.__waifuStream(ctx, engine).init();
    try { window.__waifuSession(ctx, engine).init(); } catch (e) {}
    window.__ctx = ctx; window.__engine = engine;
    document.getElementById('waifu-chat').classList.add('active');
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


SEND = """(text) => {
  const i = document.getElementById('chat-input');
  i.value = text;
  i.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chat-send').click();
}"""

# 面板读数。`noteDisp`/`noteOpa` 读的是**计算样式**：判据若是"有没有 .active 类"就只是
# 同义反复，提示条最容易坏的方式恰恰是"类加上了、屏幕上没显形"。
STATE = """() => {
  const m = document.getElementById('chat-messages');
  const note = document.getElementById('chat-new-msg-note');
  return {
    top: Math.round(m.scrollTop),
    max: m.scrollHeight - m.clientHeight,
    dist: m.scrollHeight - Math.round(m.scrollTop) - m.clientHeight,
    clientH: m.clientHeight,
    noteActive: !!(note && note.classList.contains('active')),
    noteDisp: note ? getComputedStyle(note).display : null,
    noteOpa: note ? getComputedStyle(note).opacity : null,
    msgs: m.children.length,
    isSending: !!window.__ctx.state.isSending,
    streamCalls: window.__stub.streamCalls,
    nSamples: window.__samples.length,
  };
}"""

SET_TOP = """(v) => {
  const m = document.getElementById('chat-messages');
  m.scrollTop = (v === null) ? m.scrollHeight : v;
  return Math.round(m.scrollTop);
}"""

# 采样窗口内的「静默停摆」：连续出现"距底 > 60 且提示条不亮"的采样。
# 单帧内的瞬时值不算（内容刚长高、pin 的 rAF 还没跑时本就是这个读数）；
# 门槛取 300ms —— 主人能看见的"卡住不动"远长于此，而瞬时值只有 ~16ms。
STALL = """(from) => {
  const s = window.__samples.slice(from);
  let run = 0, worst = 0, silent = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i].d > 60 && !s[i].n) { run++; if (run > worst) worst = run; }
    else run = 0;
    if (s[i].d > 60 && !s[i].n) silent += 1;
  }
  return { maxRunMs: worst * 20, silentMs: silent * 20, samples: s.length };
}"""


def snapshot(pg):
    from_idx = pg.evaluate("() => window.__samples.length")
    return from_idx, pg.evaluate(STATE), pg.evaluate(STALL, from_idx)


def stream_round(pg, text, frames):
    """真流式一轮：等它自然收尾（不看固定 sleep——收尾后的 150ms 兜底 rAF 也要跑完）。"""
    from_idx = pg.evaluate("() => window.__samples.length")
    pg.evaluate("(f) => { window.__frames = f; }", frames)
    pg.evaluate(SEND, text)
    pg.wait_for_function("() => !window.__ctx.state.isSending", timeout=20000)
    pg.wait_for_timeout(700)
    return from_idx, pg.evaluate(STATE), pg.evaluate(STALL, from_idx)


def pump(pg, steps=8, px=150):
    """竞态泵：真时序（见 __pumpStep 注释），不碰 widget 内部、不碰 scrollTop。"""
    from_idx = pg.evaluate("() => window.__samples.length")
    pg.evaluate("(a) => window.__pump(a[0], a[1])", [steps, px])
    pg.wait_for_timeout(steps * 60 + 400)
    return from_idx, pg.evaluate(STATE), pg.evaluate(STALL, from_idx)


def main():
    httpd, port = start_server()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={"width": 1280, "height": 800})
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.goto(f"http://127.0.0.1:{port}/", wait_until="load")
            pg.wait_for_selector("#chat-messages", state="attached", timeout=10000)
            pg.evaluate("() => { window.__stub.frameDelay = 45; }")
            pg.wait_for_timeout(300)
            print("=== 基线 ===")
            print("  ", pg.evaluate(STATE))

            # ── ① 真流式（在底部）：对照组，不是缺陷判据 ──
            print("\n=== ① 真流式 · 在底部（对照组） ===")
            pg.evaluate(SET_TOP, None)
            pg.wait_for_timeout(80)
            _, s1, st1 = stream_round(pg, "第一条探针消息", ROUND)
            print("   收尾：", s1)
            check("①a 流式收尾时钉在底部（距底 < 4px）", s1["dist"] < 4,
                  f"距底={s1['dist']} max={s1['max']}")
            check("①b 内容确实被撑超出去了（否则这条腿是永真的空跑）", s1["max"] > 100,
                  f"max={s1['max']} clientH={s1['clientH']}")
            check("①c 这一路不该亮提示条（主人没离开底部）", not s1["noteActive"],
                  f"noteActive={s1['noteActive']}")

            # ── ② 竞态 · 在底部：缺陷本体 ──
            print("\n=== ② 竞态泵 · 在底部（缺陷本体） ===")
            pg.evaluate(SET_TOP, None)
            pg.wait_for_timeout(80)
            _, s2, st2 = pump(pg, steps=8)
            print("   收尾：", s2)
            print("   采样：", st2)
            check("②a 竞态下收尾仍钉在底部（距底 < 4px）", s2["dist"] < 4,
                  f"距底={s2['dist']} max={s2['max']} scrollTop={s2['top']}")
            check("②b 全程没有「停摆且不亮提示条」（< 300ms）", st2["maxRunMs"] < 300,
                  f"最长静默停摆={st2['maxRunMs']}ms")
            check("②c 一路 8 步内容都在长（不是空跑）", s2["max"] > s1["max"] + 300,
                  f"max {s1['max']} → {s2['max']}")
            check("②d 这一路也不该亮提示条（主人没离开底部）", not s2["noteActive"],
                  f"noteActive={s2['noteActive']}")

            # ── ③ 竞态 · 主人在历史区：不拽回 + 亮提示条（负控） ──
            print("\n=== ③ 竞态泵 · 主人在历史区（负控） ===")
            pg.evaluate(SET_TOP, 0)
            pg.wait_for_timeout(150)
            up = pg.evaluate(STATE)
            _, s3, st3 = pump(pg, steps=6)
            print("   上翻后：", up)
            print("   收尾：", s3)
            check("③a 主人在历史区时新内容不拽回（仍在顶部 200px 内）", s3["top"] < 200,
                  f"scrollTop={s3['top']} max={s3['max']}")
            check("③b 提示条亮起（.active + 计算样式可见）",
                  s3["noteActive"] and s3["noteDisp"] not in ("none", None)
                  and s3["noteOpa"] not in ("0", None),
                  f"active={s3['noteActive']} display={s3['noteDisp']} opacity={s3['noteOpa']}")
            check("③c 提醒的是「有新消息」而不是把主人拉回去（距底仍远）", s3["dist"] > 60,
                  f"距底={s3['dist']}")

            # ── ④ 主人自己滚回底部 ⇒ 跟随恢复 ──
            print("\n=== ④ 滚回底部后恢复 ===")
            pg.evaluate(SET_TOP, None)
            pg.wait_for_timeout(150)
            _, s4, st4 = pump(pg, steps=5)
            print("   收尾：", s4)
            check("④a 滚回底部后跟随恢复（收尾距底 < 4px）", s4["dist"] < 4,
                  f"距底={s4['dist']}")
            check("④b 恢复后不再静默停摆（< 300ms）", st4["maxRunMs"] < 300,
                  f"最长静默停摆={st4['maxRunMs']}ms")
            check("④c 回底那一下提示条已收起", not s4["noteActive"],
                  f"noteActive={s4['noteActive']}")

            # ── ⑤ 提示条点一下 ⇒ 回底且收起 ──
            print("\n=== ⑤ 提示条点击 ===")
            pg.evaluate(SET_TOP, 0)
            pg.wait_for_timeout(150)
            _, s5a, _ = pump(pg, steps=4)
            pg.evaluate("() => document.getElementById('chat-new-msg-note').click()")
            pg.wait_for_timeout(600)
            s5 = pg.evaluate(STATE)
            print("   点击前：", s5a)
            print("   点击后：", s5)
            check("⑤a 点击提示条回到最底（距底 < 4px）", s5["dist"] < 4, f"距底={s5['dist']}")
            check("⑤b 提示条收起", not s5["noteActive"], f"noteActive={s5['noteActive']}")

            check("页面无未捕获异常", errs == [], " | ".join(errs[:4]))
            pg.close()
            b.close()
    finally:
        httpd.shutdown()

    print()
    if FAILS:
        print(f"✗ chat-scroll-follow：{len(FAILS)} 条失败")
        for f in FAILS:
            print("  - " + f)
        return 1
    print("✓ chat-scroll-follow：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
