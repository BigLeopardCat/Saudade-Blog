import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { cp } from "node:fs/promises";
import { FE_DIR, withSandbox } from "./sandbox";

/**
 * 对话面板「新消息来了窗口不跟着往下滚」的回归台（20261008）
 * （原 tests/chat-scroll-follow.test.py，20261019 迁移）。
 *
 * 为什么必须单起一层：这条缺陷**不是**某段代码写错了，而是两个各自都对的机制撞在一起——
 *   · `chat-engine.js` 用 scroll 事件反推「主人在不在底部」（`userAtBottom`，阈值 60px）；
 *   · 回底靠「写 `scrollTop = scrollHeight`」（`scrollToBottom` 的双 rAF 与 `pin`）。
 * 而 **scroll 事件不是写完就派发的**（要等下一个渲染机会），它送到时读到的 `scrollHeight`
 * 可能已经被新内容顶高了远不止 60px ⇒ 一次**自己招来的**事件被读成「主人翻上去读历史了」
 * ⇒ `userAtBottom` 翻成 false 并且**再也不翻回来**（真人滚一下才有新的 scroll 事件），
 * 于是 `pin()` 静默早退、`scrollToBottom` 只亮提示条 ⇒ 症状就是"新消息不滚了"，
 * 而且**没有别的信号**（提示条那一路也没亮，见下）。
 *
 * 线上探针（20261008，访客身份、只读）逐帧记到的原话：
 *     t=2530 写入 261  写前 5   scrollH=261 clientH=183     ← pin 钉底（此刻确在底部）
 *     t=2553 scroll 事件送达：scrollTop=78 scrollH=335 距底 74 ≥ 60 ⇒ userAtBottom=false
 *     此后：scrollTop 写入 0 次、scroll 事件 0 次、提示条一直不亮
 * （261 被浏览器夹成 78 = 261-183 的 max；事件晚到 23ms，期间内容从 261 涨到 335。）
 *
 * ★ **为什么第一条腿（真流式）不是这条缺陷的判据**：帧率快的时候「写入 → 事件送达」
 * 只隔几毫秒，下一次内容长高往往落在窗口**外**，于是真流式跑十次也不红——本脚本第一版
 * 就是这样（真流式全绿、缺陷还在）。所以缺陷本体由第②③腿判：**把「内容长高」按帧序
 * 钉死在「写入之后、事件送达之前」**（见 __pumpStep 的注释，靠 rAF 注册次序而非计时），
 * 这一步在生产里对应"网络分片 / 贴纸图片晚 900ms 到位 / markdown 增强长高"，只是不再靠运气。
 *
 * （静态断言看不见这类洞——两段代码各自看都对；HTTP 探针也看不见——没有真时序就没有真事件。
 * 所以照 confirm-card 的老规矩：**真模块 + 真时序**，浏览器里问 DOM。）
 *
 * 五条腿：
 *   ① 真流式（在底部）⇒ 收尾钉底——不是缺陷判据，是"没把正常路径修坏"的对照
 *   ② 竞态（在底部）⇒ 收尾**仍钉底**：缺陷本体
 *   ③ 竞态（主人在历史区）⇒ 不拽回**且提示条亮**（20260828f 契约；同时是负控：修法若是
 *      "把 userAtBottom 那道闸删了"，②会过而这条当场红）
 *   ④ 主人自己滚回底部 ⇒ 跟随恢复
 *   ⑤ 提示条点一下 ⇒ 回底且收起（修法若只亮不灭，这条红）
 *
 * ★ 为什么住在**父仓**（源码在 agent 仓 `frontend/public/live2d-widgets/`）：本套件读的是
 * `frontend/public/` 里那份**按 `widget.lock.json` 的 pin 取来的**副本——也就是真会发到浏览器
 * 的那一份 ⇒ 它顺带判「pin 没换」（改了 agent 仓却没换 pin，②③腿当场红）。换成读 agent 仓
 * 那份就把这个判据丢了。
 *
 * （TS 迁移注：Python 版的静态服务以 `frontend/public/` 为根，widget 五件套与
 * `/icons/*.png` 天然可达；TS 沙箱的根是临时目录，所以在这里把
 * `public/live2d-widgets/` 整目录与 `public/icons/` **原样拷进沙箱**——
 * widget 特效系统会动态请求 `/icons/星星.png` 等图标，缺了 404 会把
 * 「全程无异常」判据（含 console error，与 Python 版同口径）染红。）
 */

const PUBLIC = path.join(FE_DIR, "public");

// ── 真帧：一段段**增量**正文（chat-stream 是 `displayText += text`，帧即 delta）──
const CHUNK = (
  "看板娘把这一段接着往上摞，用来模拟流式回复里一次到达一大段正文的情形，" +
  "这一段大约一百二十个字，落在面板里就是八九行的高度。"
).repeat(2);
const ROUND: string[] = [
  ...Array.from({ length: 8 }, () => JSON.stringify(CHUNK)),
  "__END__",
];

const HARNESS = `<!DOCTYPE html>
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
</body></html>`;

const SEND = (text: string) => {
  const i = document.getElementById("chat-input") as HTMLInputElement;
  i.value = text;
  i.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("chat-send")!.click();
};

// 面板读数。`noteDisp`/`noteOpa` 读的是**计算样式**：判据若是"有没有 .active 类"就只是
// 同义反复，提示条最容易坏的方式恰恰是"类加上了、屏幕上没显形"。
interface ChatState {
  top: number;
  max: number;
  dist: number;
  clientH: number;
  noteActive: boolean;
  noteDisp: string | null;
  noteOpa: string | null;
  msgs: number;
  isSending: boolean;
  streamCalls: number;
  nSamples: number;
}
const STATE = (): ChatState => {
  const m = document.getElementById("chat-messages")!;
  const note = document.getElementById("chat-new-msg-note");
  return {
    top: Math.round(m.scrollTop),
    max: m.scrollHeight - m.clientHeight,
    dist: m.scrollHeight - Math.round(m.scrollTop) - m.clientHeight,
    clientH: m.clientHeight,
    noteActive: !!(note && note.classList.contains("active")),
    noteDisp: note ? getComputedStyle(note).display : null,
    noteOpa: note ? getComputedStyle(note).opacity : null,
    msgs: m.children.length,
    isSending: !!(window as unknown as { __ctx: { state: { isSending: boolean } } })
      .__ctx.state.isSending,
    streamCalls: (window as unknown as { __stub: { streamCalls: number } }).__stub
      .streamCalls,
    nSamples: (window as unknown as { __samples: unknown[] }).__samples.length,
  };
};

const SET_TOP = (v: number | null): number => {
  const m = document.getElementById("chat-messages")!;
  m.scrollTop = v === null ? m.scrollHeight : v;
  return Math.round(m.scrollTop);
};

// 采样窗口内的「静默停摆」：连续出现"距底 > 60 且提示条不亮"的采样。
// 单帧内的瞬时值不算（内容刚长高、pin 的 rAF 还没跑时本就是这个读数）；
// 门槛取 300ms —— 主人能看见的"卡住不动"远长于此，而瞬时值只有 ~16ms。
interface StallInfo {
  maxRunMs: number;
  silentMs: number;
  samples: number;
}
const STALL = (from: number): StallInfo => {
  const s = (
    window as unknown as {
      __samples: Array<{ d: number; n: boolean }>;
    }
  ).__samples.slice(from);
  let run = 0;
  let worst = 0;
  let silent = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i].d > 60 && !s[i].n) {
      run++;
      if (run > worst) worst = run;
    } else run = 0;
    if (s[i].d > 60 && !s[i].n) silent += 1;
  }
  return { maxRunMs: worst * 20, silentMs: silent * 20, samples: s.length };
};

/** 真流式一轮：等它自然收尾（不看固定 sleep——收尾后的 150ms 兜底 rAF 也要跑完）。 */
async function streamRound(page: Page, text: string, frames: string[]) {
  const fromIdx = await page.evaluate(
    () => (window as unknown as { __samples: unknown[] }).__samples.length,
  );
  await page.evaluate(
    (f) => {
      (window as unknown as { __frames: string[] }).__frames = f;
    },
    frames,
  );
  await page.evaluate(SEND, text);
  await page.waitForFunction(
    () =>
      !(window as unknown as { __ctx: { state: { isSending: boolean } } }).__ctx
        .state.isSending,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(700);
  return {
    fromIdx,
    state: (await page.evaluate(STATE)) as ChatState,
    stall: (await page.evaluate(STALL, fromIdx)) as StallInfo,
  };
}

/** 竞态泵：真时序（见 __pumpStep 注释），不碰 widget 内部、不碰 scrollTop。 */
async function pump(page: Page, steps = 8, px = 150) {
  const fromIdx = await page.evaluate(
    () => (window as unknown as { __samples: unknown[] }).__samples.length,
  );
  await page.evaluate(
    (a) =>
      (
        window as unknown as {
          __pump: (steps: number, px: number) => Promise<boolean>;
        }
      ).__pump(a[0], a[1]),
    [steps, px] as [number, number],
  );
  await page.waitForTimeout(steps * 60 + 400);
  return {
    fromIdx,
    state: (await page.evaluate(STATE)) as ChatState,
    stall: (await page.evaluate(STALL, fromIdx)) as StallInfo,
  };
}

test.describe("对话面板滚动跟随", () => {
  test.setTimeout(180_000);

  test("真流式钉底对照；竞态仍钉底；历史区不拽回+亮提示条；回底恢复；提示条可点", async ({
    page,
  }) => {
    await withSandbox({ "index.html": HARNESS }, async (sb) => {
      // widget 五件套 + icons：照 Python 版静态根（frontend/public/）原样拷进沙箱。
      await cp(path.join(PUBLIC, "live2d-widgets"), path.join(sb.dir, "live2d-widgets"), {
        recursive: true,
      });
      await cp(path.join(PUBLIC, "icons"), path.join(sb.dir, "icons"), {
        recursive: true,
      });

      // 与 Python 版同口径：pageerror + console error 都算「页面异常」。
      const errs: string[] = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      page.on("console", (m) => {
        if (m.type() === "error") errs.push(m.text());
      });

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(sb.url, { waitUntil: "load" });
      await page.waitForSelector("#chat-messages", {
        state: "attached",
        timeout: 10_000,
      });
      await page.evaluate(() => {
        (window as unknown as { __stub: { frameDelay: number } }).__stub.frameDelay = 45;
      });
      await page.waitForTimeout(300);

      // ── ① 真流式 · 在底部（对照组，不是缺陷判据） ──
      await page.evaluate(SET_TOP, null);
      await page.waitForTimeout(80);
      const r1 = await streamRound(page, "第一条探针消息", ROUND);
      const s1 = r1.state;
      expect(
        s1.dist < 4,
        `①a 流式收尾时钉在底部（距底 < 4px） → 距底=${s1.dist} max=${s1.max}`,
      ).toBe(true);
      expect(
        s1.max > 100,
        `①b 内容确实被撑超出去了（否则这条腿是永真的空跑） → max=${s1.max} clientH=${s1.clientH}`,
      ).toBe(true);
      expect(
        !s1.noteActive,
        `①c 这一路不该亮提示条（主人没离开底部） → noteActive=${s1.noteActive}`,
      ).toBe(true);

      // ── ② 竞态 · 在底部：缺陷本体 ──
      await page.evaluate(SET_TOP, null);
      await page.waitForTimeout(80);
      const r2 = await pump(page, 8);
      const s2 = r2.state;
      const st2 = r2.stall;
      expect(
        s2.dist < 4,
        `②a 竞态下收尾仍钉在底部（距底 < 4px） → 距底=${s2.dist} max=${s2.max} scrollTop=${s2.top}`,
      ).toBe(true);
      expect(
        st2.maxRunMs < 300,
        `②b 全程没有「停摆且不亮提示条」（< 300ms） → 最长静默停摆=${st2.maxRunMs}ms`,
      ).toBe(true);
      expect(
        s2.max > s1.max + 300,
        `②c 一路 8 步内容都在长（不是空跑） → max ${s1.max} → ${s2.max}`,
      ).toBe(true);
      expect(
        !s2.noteActive,
        `②d 这一路也不该亮提示条（主人没离开底部） → noteActive=${s2.noteActive}`,
      ).toBe(true);

      // ── ③ 竞态 · 主人在历史区：不拽回 + 亮提示条（负控） ──
      await page.evaluate(SET_TOP, 0);
      await page.waitForTimeout(150);
      const r3 = await pump(page, 6);
      const s3 = r3.state;
      expect(
        s3.top < 200,
        `③a 主人在历史区时新内容不拽回（仍在顶部 200px 内） → scrollTop=${s3.top} max=${s3.max}`,
      ).toBe(true);
      expect(
        s3.noteActive &&
          s3.noteDisp !== "none" &&
          s3.noteDisp !== null &&
          s3.noteOpa !== "0" &&
          s3.noteOpa !== null,
        `③b 提示条亮起（.active + 计算样式可见） → active=${s3.noteActive} display=${s3.noteDisp} opacity=${s3.noteOpa}`,
      ).toBe(true);
      expect(
        s3.dist > 60,
        `③c 提醒的是「有新消息」而不是把主人拉回去（距底仍远） → 距底=${s3.dist}`,
      ).toBe(true);

      // ── ④ 主人自己滚回底部 ⇒ 跟随恢复 ──
      await page.evaluate(SET_TOP, null);
      await page.waitForTimeout(150);
      const r4 = await pump(page, 5);
      const s4 = r4.state;
      const st4 = r4.stall;
      expect(
        s4.dist < 4,
        `④a 滚回底部后跟随恢复（收尾距底 < 4px） → 距底=${s4.dist}`,
      ).toBe(true);
      expect(
        st4.maxRunMs < 300,
        `④b 恢复后不再静默停摆（< 300ms） → 最长静默停摆=${st4.maxRunMs}ms`,
      ).toBe(true);
      expect(
        !s4.noteActive,
        `④c 回底那一下提示条已收起 → noteActive=${s4.noteActive}`,
      ).toBe(true);

      // ── ⑤ 提示条点一下 ⇒ 回底且收起 ──
      await page.evaluate(SET_TOP, 0);
      await page.waitForTimeout(150);
      await pump(page, 4);
      await page.evaluate(() =>
        document.getElementById("chat-new-msg-note")!.click(),
      );
      await page.waitForTimeout(600);
      const s5 = (await page.evaluate(STATE)) as ChatState;
      expect(
        s5.dist < 4,
        `⑤a 点击提示条回到最底（距底 < 4px） → 距底=${s5.dist}`,
      ).toBe(true);
      expect(
        !s5.noteActive,
        `⑤b 提示条收起 → noteActive=${s5.noteActive}`,
      ).toBe(true);

      expect(
        errs.length === 0,
        `页面无未捕获异常（pageerror + console error） → ${errs.slice(0, 4).join(" | ")}`,
      ).toBe(true);
    });
  });
});
