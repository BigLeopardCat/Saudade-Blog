// ═ 时间标签（TD）位置与相对时间：CI 断言套件（20260927 由 `repro-timegap.mjs` 升格）══
//   node tests/chat-time-divider.test.mjs
//
// 缘起（20260828o 浏览器回归）——用户现场：主窗口"天气消息下方显示昨天20:42"、
// 后台窗口"网络错误消息上方显示昨天20:42"。链条：50 条真实历史（首条昨天 20:42）
// → 发消息 → SSE 断流 → catch 转正（l 轮，今天）→ saveHistory → storage 触发 pullHistory
// （60s 窗口内外两种）→ reconcileDOM 孤儿清理 → **标签必须仍钉在各自消息正上方**。
//
// 升格理由：它此前长期是"手工排查工具"，20260927 修好两处陈旧（时钟没钉死 ⇒
// 「首 TD 文本」随跑测日期漂移；storage 触发用了 20260903 之前的单桶键 ⇒ 整条拉取
// 链路静默空转，看着像渲染错了）之后**每条都确定可判**，于是进 CI（`npm test` 的
// glob 收录）——这类"渲染物位置"的回归恰恰是手工跑才会漏掉的。
//
// 时钟：整支 `Date` 被钉在 2026-08-28 14:52:30（见下方假时钟块），与 fixture 的
// 末条 DB 记录 1895@14:51:56 配套 ⇒ TD 文本（`昨天 20:42`）与 60s 窗口全部确定。
import { readFileSync, existsSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { installDom, installScriptLoader } from './stubs/dom.mjs';
// SSE 桩要带 content-type：20261002 起前端据它判"这是不是流"
import { sseHeaders } from './stubs/sse.mjs';

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/live2d-widgets');
const dump = (label) => {
  const msgs = document.getElementById('chat-messages');
  const line = [...msgs.children].map(c => {
    if (c.classList.contains('chat-time-divider')) return '▼TD[' + c.textContent + ']';
    const cs = c.querySelector('.msg-text');
    return c.className.split(' ')[0] + '#' + (c.dataset.mid || '无mid').slice(0, 14)
         + '「' + (cs ? cs.textContent : c.textContent || '').slice(0, 14).replace(/\n/g, ' ') + '」'
         + (cs && cs._htmlSets ? ' S' + cs._htmlSets : '');
  }).join(' | ');
  console.log('  ' + label + ':\n    ' + line);
};

// ── 最小 DOM stub：20260927 起与 smoke 那支共用 tests/stubs/dom.mjs ──
// （两份各复制一份时，两份都没有 document.querySelector —— 谁也没跑到自己声称的
//   地方；抽出去的完整理由与三处真机语义见 stubs/dom.mjs 头注）
installDom();
installScriptLoader(W);

const store = new Map();
const store2 = new Map();
globalThis.window = globalThis;
globalThis.location = { href: 'https://saudade.site/', pathname: '/' };
globalThis.localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.sessionStorage = {
  getItem: (k) => store2.has(k) ? store2.get(k) : null,
  setItem: (k, v) => store2.set(k, String(v)),
  removeItem: (k) => store2.delete(k),
};
store.set('tokenKey', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig');
class BroadcastChannelStub {
  static instances = [];
  constructor(name) { this.name = name; this.onmessage = null; BroadcastChannelStub.instances.push(this); }
  postMessage(m) {
    for (const other of BroadcastChannelStub.instances) {
      if (other !== this && other.onmessage) setTimeout(() => other.onmessage({ data: m }), 0);
    }
  }
  close() {}
}
globalThis.BroadcastChannel = BroadcastChannelStub;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} };
globalThis.Image = class {};
globalThis.Live2DCubismCore = {};
globalThis.__chatRenderMarkdown = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
globalThis.__chatEnhance = () => {};
// 看板娘在这里**不打桩**（20261001 渲染层换自研）：上游 initWidget 与 __cubism5model 那套
// 嵌套结构已随 GPL 实现一起从仓库移除，现在由 renderer.js 自己建 #waifu 骨架。
// 真 renderer 在 Node 下会死在 PIXI 未定义处、被它自己的 .catch 兜住（模型画不出来，但工具条
// 照建、waifu-active 照加）——这正是本 harness 要覆盖的形状，别再加桩把它盖回假绿。

// ── 真实 DB 数据（2026-08-28 导出 chat_history id 1846-1895，+08:00 钟面）──
// 期望 TD（间隔 >5min）：1846上"昨天 20:42"、1847上"00:36"、1853上"01:56"、
// 1865上"02:19"、1867上"02:27"、1869上"02:36"、1871上"10:24"、1879上"10:56"、
// 1881上"12:30"、1883上"12:45"、1889上"14:09"、1893上"14:46"（共 12 个）
const T = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();
const RAW = [
  [1846, 'assistant', '首页介绍', 2026, 8, 27, 20, 42, 23],
  [1847, 'user', '最新说说', 2026, 8, 28, 0, 36, 17],
  [1848, 'assistant', 'RAG 看法', 2026, 8, 28, 0, 36, 30],
  [1849, 'user', '需要勘误吗', 2026, 8, 28, 0, 37, 19],
  [1850, 'assistant', '勘误补充', 2026, 8, 28, 0, 37, 31],
  [1851, 'user', '压缩算法他说了吗', 2026, 8, 28, 0, 39, 9],
  [1852, 'assistant', '老实认错', 2026, 8, 28, 0, 39, 19],
  [1853, 'user', 'OLED 端到端验证', 2026, 8, 28, 1, 56, 33],
  [1854, 'assistant', '已显示', 2026, 8, 28, 1, 56, 41],
  [1855, 'user', '屏幕上显示什么', 2026, 8, 28, 1, 56, 55],
  [1856, 'assistant', '端到端验证', 2026, 8, 28, 1, 57, 35],
  [1857, 'user', '去物联网平台', 2026, 8, 28, 2, 9, 11],
  [1858, 'assistant', '带您去', 2026, 8, 28, 2, 9, 17],
  [1859, 'user', '说点啥在ESP32上', 2026, 8, 28, 2, 9, 44],
  [1860, 'assistant', '元气满满', 2026, 8, 28, 2, 9, 52],
  [1861, 'user', '谢谢你小猫咪', 2026, 8, 28, 2, 10, 14],
  [1862, 'assistant', '不客气', 2026, 8, 28, 2, 10, 20],
  [1863, 'user', '真机闭环测试完成', 2026, 8, 28, 2, 11, 54],
  [1864, 'assistant', '已经显示', 2026, 8, 28, 2, 12, 1],
  [1865, 'user', '再说点什么吧', 2026, 8, 28, 2, 19, 7],
  [1866, 'assistant', '猫薄荷', 2026, 8, 28, 2, 19, 15],
  [1867, 'user', '幽灵窗口诚实化测试', 2026, 8, 28, 2, 27, 47],
  [1868, 'assistant', '还在忙', 2026, 8, 28, 2, 28, 1],
  [1869, 'user', '明天继续优化你', 2026, 8, 28, 2, 36, 3],
  [1870, 'assistant', '晚安', 2026, 8, 28, 2, 36, 11],
  [1871, 'user', '早上小猫咪', 2026, 8, 28, 10, 24, 25],
  [1872, 'assistant', '早上好', 2026, 8, 28, 10, 24, 31],
  [1873, 'user', '回到首页吧', 2026, 8, 28, 10, 24, 46],
  [1874, 'assistant', '已经回首页', 2026, 8, 28, 10, 24, 53],
  [1875, 'user', '留言板链接', 2026, 8, 28, 10, 42, 7],
  [1876, 'assistant', '带您去留言板', 2026, 8, 28, 10, 42, 15],
  [1877, 'user', '最新留言内容', 2026, 8, 28, 10, 42, 41],
  [1878, 'assistant', '最新留言', 2026, 8, 28, 10, 42, 49],
  [1879, 'user', '回答的是什么', 2026, 8, 28, 10, 56, 43],
  [1880, 'assistant', '断片儿道歉', 2026, 8, 28, 10, 56, 59],
  [1881, 'user', '没按留言执行', 2026, 8, 28, 12, 30, 45],
  [1882, 'assistant', '带您去留言板2', 2026, 8, 28, 12, 31, 16],
  [1883, 'user', '大笨猫你做了什么', 2026, 8, 28, 12, 45, 21],
  [1884, 'assistant', '道歉', 2026, 8, 28, 12, 45, 38],
  [1885, 'user', '测一下链路', 2026, 8, 28, 12, 50, 6],
  [1886, 'assistant', '链路测试', 2026, 8, 28, 12, 50, 27],
  [1887, 'user', '没有责怪', 2026, 8, 28, 12, 52, 59],
  [1888, 'assistant', '心里的石头落地', 2026, 8, 28, 12, 53, 9],
  [1889, 'user', '午觉才艺', 2026, 8, 28, 14, 9, 44],
  [1890, 'assistant', '无影翻滚', 2026, 8, 28, 14, 10, 19],
  [1891, 'user', '物联网平台', 2026, 8, 28, 14, 12, 44],
  [1892, 'assistant', '管理设备', 2026, 8, 28, 14, 12, 56],
  [1893, 'user', '小猫咪！', 2026, 8, 28, 14, 46, 49],
  [1894, 'assistant', '我在呢', 2026, 8, 28, 14, 46, 58],
  [1895, 'user', '可以呀帮我看看杭州钱塘区天气', 2026, 8, 28, 14, 51, 56],
];
const HISTORY = RAW.map(([id, role, content, ...t]) => ({ id, role, content, time: T(...t) }));
// 期望 TD 消息 id 列表（间隔 >5min 出现标签；1857/1875 间隔也超 5min）
const EXPECT_TD_ABOVE = [1846, 1847, 1853, 1857, 1865, 1867, 1869, 1871, 1875, 1879, 1881, 1883, 1889, 1893];

let pullCount = 0;
let streamMode = 'ok'; // 'ok' | 'error-frame' | 'fetch-fail'
let itemsCb = null;
// ── 假时钟（20260927 重做）──
// **必须换掉 `Date` 本身，不是只盖 `Date.now`**：两处取"现在"的写法不同——
//   · `replaceWithIncoming` 的 60s 窗口用 `Date.now()`；
//   · `__chatCore.formatTimeLabel` 用 **`new Date()`**（chat-core.js:207，算本地日界差，
//     决定 TD 是 `HH:mm` / `昨天 HH:mm` / `M月D日 HH:mm`）。
// 旧版只盖了 `Date.now` ⇒ TD 文本始终按**真实跑测日期**渲染：2026-08-28 那天跑是
// "昨天 20:42"，今天（09-27）跑变成"8月27日 20:42"——「首 TD 文本」这条断言于是
// 依赖跑测日期（而且它当年能过，只是因为写它的那天正好是 8-28）。
// 现在整支 `Date` 都是偏移过的：带参构造照旧（`T(y,m,d,…)` 造的是绝对时刻），
// 无参构造 = 现在。**先钉死再加载**，全部场景一律从 2026-08-28 14:52:30 起算——
// 它同时满足场景 2 的口径（与末条 DB 记录 1895@14:51:56 间隔 <5min ⇒ user 消息上方
// 不新增 TD，TD 总数恒为 14）。
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
let nowOffset = T(2026, 8, 28, 14, 52, 30) - realNow();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(realNow() + nowOffset); else super(...args); }
  static now() { return realNow() + nowOffset; }
};
// 场景 2b 的 catch 内 applyMsg(null) crash 是异步未捕获异常：node 默认退出，兜住计数
let unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String((e && e.message) || e)); });
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/api/chat/history')) {
    pullCount++;
    return { ok: true, json: async () => ({ items: HISTORY }) };
  }
  if (String(url).includes('/api/chat/discard')) return { ok: true, json: async () => ({}) };
  if (String(url).includes('/api/chat/conversations')) {
    // 会话化（20260903）新增：空白新对话态发送前先建会话（`ensureConversation`）。
    // 缺这个桩 ⇒ fetch 抛"unexpected fetch" ⇒ 被它的 catch 吞成 false ⇒ 每轮都停在
    // 「创建新会话失败」气泡上：期望的 50/51/52 条一律 +2，全场景判红（20260927 修）。
    return { ok: true, json: async () => ({ id: 1 }) };
  }
  if (String(url).includes('/api/monitor/log')) return { ok: true, json: async () => ({}) };
  if (String(url).includes('/api/chat/stream')) {
    if (streamMode === 'fetch-fail') throw new TypeError('Failed to fetch'); // 连接层失败（contentSpan 未建）
    if (streamMode === 'error-frame') {
      // agent 重启：Rust 上游断开 → 发 __ERROR__ 帧（chat.rs:546 真实格式：裸前缀 + JSON 字符串）
      const enc = new TextEncoder();
      const FRAMES = ['data: __ERROR__:"与 Agent 的连接中断，回复可能不完整"\n\n'];
      let i = 0;
      return { ok: true, ...sseHeaders(), body: { getReader: () => ({ read: async () => (i < FRAMES.length ? { done: false, value: enc.encode(FRAMES[i++]) } : { done: true, value: undefined }) }) } };
    }
    const enc = new TextEncoder();
    const FRAMES = ['data: ' + JSON.stringify('喵呜测试') + '\n\n', 'data: __END__\n\n'];
    let i = 0;
    return { ok: true, ...sseHeaders(), body: { getReader: () => ({ read: async () => (i < FRAMES.length ? { done: false, value: enc.encode(FRAMES[i++]) } : { done: true, value: undefined }) }) } };
  }
  throw new Error('unexpected fetch: ' + url);
};
// ── 等待工具（20260927）：固定 sleep 在慢机器/CI 上就是**偶发红**的来源，
// 偶发红比没有测试更坏（会训练人忽略红）。等不到就照旧交给断言判红。
const msgsOf = () => {
  const m = document.getElementById('chat-messages');
  return m ? [...m.children].filter(c => c.classList.contains('chat-msg')) : [];
};
const tdsOf = () => {
  const m = document.getElementById('chat-messages');
  return m ? [...m.children].filter(c => c.classList.contains('chat-time-divider')) : [];
};
const waitFor = async (cond, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  return cond();
};
// 拉取完成（fetch 已发生）后 reconcile 还要走几个微任务：给一拍再断言
const settle = () => new Promise(r => setTimeout(r, 20));
let failed = 0;
const assert = (cond, name, detail) => {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const fireStorage = async (label) => {
  // 键自 20260903 起按会话分桶（`chat_history_<token>_(auto|<convId>)`），而监听器是
  // **全键相等**比较（JWT 自带 '_'，前缀判断会误收别的会话的写入）⇒ 写死旧单桶键
  // `chat_history_<token>` 等于**什么都没触发**：pullHistory 不跑、reconcile 不做孤儿
  // 清理，于是"无 mid 的错误气泡被收敛"这组期望全部落空（20260927 修）。
  // 取当前真实键 = 最近一次写入的那个（本文件不用精确指定会话，视图只有一个）。
  const keys = [...store.keys()].filter(k => k.startsWith('chat_history_') && !k.includes('backup'));
  const key = keys[keys.length - 1] || ('chat_history_' + store.get('tokenKey'));
  const before = pullCount;
  const fns = document._listeners['storage'] || [];
  fns.forEach(fn => fn({ key }));
  // 等**拉取真的发生**（而非"睡够 500ms 希望它发生"）：这是监听器认没认这个键的
  // 直接证据——此前正是这条链路静默空转，导致后面所有断言看着像"渲染错了"。
  await waitFor(() => pullCount > before);
  await settle();
};

vm.runInThisContext(readFileSync(path.join(W, 'boot.js'), 'utf8'), { filename: 'boot.js' });
// 加载链是 setTimeout(0) 驱动的（stubs/dom.mjs 的 installScriptLoader）⇒ 轮询等它走完
if (!await waitFor(() => !!globalThis.__waifuChatCore)) {
  console.error('chat-core 未注册（子模块加载失败）'); process.exit(1);
}
// 等首拉落地：轮询消息数而不是睡 800ms（原固定值在 CI 慢机器上是偶发红来源）
await waitFor(() => msgsOf().length === 50);

console.log('== 场景 1：加载 50 条真实历史 ==');
dump('加载后');
{
  const msgs = msgsOf();
  const tds = tdsOf();
  assert(msgs.length === 50, '50 条消息', msgs.length);
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量 = 期望 ' + EXPECT_TD_ABOVE.length, tds.length);
  // 每个期望 TD 的 mid 都应在 TD 正下方；TD 文本应与对应消息时间一致
  let tdBad = 0;
  for (const mid of EXPECT_TD_ABOVE) {
    const el = msgs.find(m => m.dataset.mid === 'd' + mid);
    if (!el || !(el.previousSibling && el.previousSibling.classList.contains('chat-time-divider'))) { tdBad++; }
  }
  assert(tdBad === 0, '12 个期望 TD 全部在对应消息正上方', tdBad);
  assert(tds[0].textContent === '昨天 20:42', '首 TD 文本 = 昨天 20:42', tds[0].textContent);
  const last = msgs[msgs.length - 1];
  assert(last.dataset.mid === 'd1895', '末条 = 天气 user', last.dataset.mid);
  assert(!(last.nextSibling && last.nextSibling.classList.contains('chat-time-divider')), '天气消息下方无 TD');
}

console.log('\n== 场景 2：发消息 → __ERROR__ 帧（agent 重启断流）→ 网络错误气泡（无 mid，不转正）==');
streamMode = 'error-frame';
{
  // 时钟已在文件头钉死为 2026-08-28 14:52:30（此处原有的那行赋值是场景 1 之后才生效的，
  // 正是「首 TD 文本」随跑测日期漂移的成因，20260927 上移）。
  const input = document.getElementById('chat-input');
  input.value = '可以呀帮我看看杭州钱塘区天气';
  document.getElementById('chat-send').click();
  await waitFor(() => msgsOf().length === 52);   // 等气泡真的落地（而非睡 300ms 希望它落地）
  dump('断流后');
  const msgs = msgsOf();
  const tds = tdsOf();
  const last = msgs[msgs.length - 1];
  assert(msgs.length === 52, '50 历史 + user + 网络错误气泡 = 52 条', msgs.length);
  assert(!last.dataset.mid, '网络错误气泡无 mid（__ERROR__ 帧无回复内容不转正——设计行为，与真实 DB 一致）', last.dataset.mid);
  // 错误文案住**子节点** `div.chat-msg-err-note`（renderFailed：正文照常渲染，提示作为独立节点追加），
  // 不在 `.msg-text` 自己的 textContent 里；且 20260927 起服务端自写的那句话**不套**
  // 「网络错误: 」前缀（这个帧是终止帧的一种、不是连接故障）⇒ 这里断的是**帧里的原文**。
  // 注：本 stub 的 textContent 是普通字段、不聚合子节点（真机是聚合的），所以直接读提示节点。
  const note = last.querySelector('.chat-msg-err-note');
  const t = last.querySelector('.msg-text');
  assert(!!note && note.textContent === '与 Agent 的连接中断，回复可能不完整',
         '__ERROR__ 帧的服务端原文原样进错误提示（不加「网络错误: 」前缀）', note && note.textContent);
  assert(!!note && !!t && note.parentNode === t,
         '错误提示挂在正文节点内（真机 textContent 因此会把它算进这条气泡）', note && !!t);
  assert(!(last.previousSibling && last.previousSibling.classList.contains('chat-time-divider')), '网络错误上方无 TD');
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量 = 14（user 与 1895 间隔 <5min 不新增）', tds.length);
  let tdBad = 0;
  for (const mid of EXPECT_TD_ABOVE) {
    const el = msgs.find(m => m.dataset.mid === 'd' + mid);
    if (!el || !(el.previousSibling && el.previousSibling.classList.contains('chat-time-divider'))) { tdBad++; }
  }
  assert(tdBad === 0, '原有 14 个 TD 位置未被破坏', tdBad);
  // 20260927：错误气泡现在也挂重发/编辑 + 失败原因落 localStorage（此前只有超时那
  // 两支有按钮，而 __ERROR__ 帧与真网络错误恰是线上最常见的失败形态）。判据的完整
  // 版本在 tests/chat-failed-round.test.mjs（刷新存活 + 三种 discard 失败各自回话），
  // 这里只钉"这一支接上了"——它是**同一份代码的另一条分支**。
  const retry = last.querySelector('.chat-msg-retry');
  assert(!!retry && retry.querySelectorAll('.chat-retry-btn').length === 2,
         '__ERROR__ 帧的错误气泡挂出重发/编辑',
         retry && retry.querySelectorAll('.chat-retry-btn').map(b => b.textContent));
  const marker = JSON.parse(store.get('saudade-chat-failed') || 'null');
  assert(!!marker && marker[0] && marker[0].text === '可以呀帮我看看杭州钱塘区天气',
         '失败轮原文进持久化标记（刷新后仍能看到这条）', marker && marker[0]);
  assert(!!marker && marker[0] && marker[0].reason === '与 Agent 的连接中断，回复可能不完整',
         '原因也存下来（服务端自写的那句话原样，不加「网络错误: 」前缀）', marker && marker[0] && marker[0].reason);
}

console.log('\n== 场景 8：fetch 层失败（连接级）→ 自建错误气泡（20260828o 修复验证）==');
streamMode = 'fetch-fail';
{
  const before = msgsOf().length;
  const input = document.getElementById('chat-input');
  input.value = '测试连接失败';
  document.getElementById('chat-send').click();
  await waitFor(() => msgsOf().length === before + 2);
  const msgs = msgsOf();
  assert(msgs.length === before + 2, '用户消息 + 自建错误气泡（修复前气泡缺失只有 user 消息）', msgs.length);
  assert(unhandled.length === 0, '无 crash（contentSpan=null 时 catch 自建气泡再 applyMsg）', unhandled.slice(0, 2));
  const last = msgs[msgs.length - 1];
  assert(!last.dataset.mid, '错误气泡无 mid（不转正不保存）', last.dataset.mid);
  // 连接级失败（fetch 抛）走的是**认不出来的异常**那条 ⇒ 才带「网络错误: 」前缀
  // （与上面那条 __ERROR__ 帧形成对照：同一条提示节点、两种来源）。
  const note = last.querySelector('.chat-msg-err-note');
  assert(!!note && note.textContent === '网络错误: Failed to fetch',
         '错误文案已渲染（认不出的异常套「网络错误: 」前缀）', note && note.textContent);
  assert(tdsOf().length === EXPECT_TD_ABOVE.length, 'TD 数量不变', tdsOf().length);
  // 连接级失败（自建气泡那条路）同样要有按钮 + 原因（20260927；与场景 2 是姊妹分支）
  const retry8 = last.querySelector('.chat-msg-retry');
  assert(!!retry8 && retry8.querySelectorAll('.chat-retry-btn').length === 2,
         '连接层失败的自建错误气泡同样挂出重发/编辑',
         retry8 && retry8.querySelectorAll('.chat-retry-btn').map(b => b.textContent));
  const marker8 = JSON.parse(store.get('saudade-chat-failed') || 'null');
  assert(!!marker8 && marker8[0] && marker8[0].reason === '网络错误: Failed to fetch',
         '原因 = 展示口径那句话（认不出的异常套「网络错误: 」前缀）', marker8 && marker8[0] && marker8[0].reason);
}

console.log('\n== 场景 3：storage 触发 pullHistory（60s 窗口内 → l 轮保留；网络错误气泡被孤儿清理收敛）==');
{
  await fireStorage('pull#1');
  dump('60s 内 pull 后');
  const msgs = msgsOf();
  const last = msgs[msgs.length - 1];
  assert(msgs.length === 51, '50 历史 + user（l 保留；无 mid 错误气泡被孤儿清理收敛到 DB 视图）', msgs.length);
  assert(last.dataset.mid.startsWith('l'), 'l 轮仍在', last.dataset.mid);
  assert(!(last.previousSibling && last.previousSibling.classList.contains('chat-time-divider')), 'user 上方无 TD（与 1895 间隔 <5min）');
  const tds = tdsOf();
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量不变', tds.length);
}

console.log('\n== 场景 4：pullHistory（60s 窗口外 → l 轮被 replaceWithIncoming 丢弃 + 孤儿清理）==');
{
  // 假时钟推进 70s → replaceWithIncoming 内部 Date.now() 判定 l 超时丢弃
  nowOffset += 70000;
  await fireStorage('pull#2');
  dump('60s 外 pull 后');
  const msgs = msgsOf();
  const tds = tdsOf();
  assert(msgs.length === 50, 'l 轮被丢弃 → 50 条', msgs.length);
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量不变', tds.length);
  const last = msgs[msgs.length - 1];
  assert(last.dataset.mid === 'd1895', '末条 = 天气 user', last.dataset.mid);
  assert(!(last.nextSibling && last.nextSibling.classList.contains('chat-time-divider')), '天气消息下方无 TD');
  // ★ 孤儿清理删除网络错误 el 后，12 个期望 TD 仍在其消息正上方（TD 未被捡走/移位）
  let tdBad = 0;
  for (const mid of EXPECT_TD_ABOVE) {
    const el = msgs.find(m => m.dataset.mid === 'd' + mid);
    if (!el || !(el.previousSibling && el.previousSibling.classList.contains('chat-time-divider'))) { tdBad++; }
  }
  assert(tdBad === 0, '孤儿清理后 12 个 TD 位置未被破坏', tdBad);
}

console.log('\n== 场景 5：后台窗口 done 帧（远端转正, 不调 patchDivider）==');
{
  const ch = BroadcastChannelStub.instances[0];
  ch.onmessage({ data: { t: 'done', roundId: 'l-remote1', id: 'l-remote1', fullText: '网络错误: 远端断流', time: Date.now(), process: [] } });
  await waitFor(() => msgsOf().length === 51);
  dump('done 帧后');
  const msgs = msgsOf();
  const tds = tdsOf();
  const last = msgs[msgs.length - 1];
  assert(msgs.length === 51, '远端 l 轮追加 → 51 条', msgs.length);
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量不变', tds.length);
  assert(!(last.previousSibling && last.previousSibling.classList.contains('chat-time-divider')), '远端网络错误上方无 TD');
}

console.log('\n== 场景 6：后台窗口 storage → pullHistory（远端 l 轮 60s 外被丢弃）==');
{
  nowOffset += 70000;
  await fireStorage('pull#3');
  dump('远端 pull 后');
  const msgs = msgsOf();
  const tds = tdsOf();
  assert(msgs.length === 50, '远端 l 轮被丢弃 → 50 条', msgs.length);
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量不变', tds.length);
  const last = msgs[msgs.length - 1];
  assert(last.dataset.mid === 'd1895', '末条 = 天气 user', last.dataset.mid);
  assert(!(last.nextSibling && last.nextSibling.classList.contains('chat-time-divider')), '天气消息下方无 TD');
}

console.log('\n== 场景 7：转正后 60s 内 pull（l 保留）再 60s 外 pull（l 丢弃）——TD 全程完好 ==');
streamMode = 'ok'; // 场景 8 改过 fetch-fail，这里恢复正常流（收尾转正 l 轮）
{
  const input = document.getElementById('chat-input');
  input.value = '交错测试';
  document.getElementById('chat-send').click();
  await waitFor(() => msgsOf().length === 52);
  await fireStorage('pull#4'); // 60s 内：l 保留
  let msgs = msgsOf();
  let last = msgs[msgs.length - 1];
  assert(msgs.length === 52, '交错：50 + user + l = 52', msgs.length);
  assert(last.dataset.mid.startsWith('l'), '交错：l 轮保留', last.dataset.mid);
  nowOffset += 70000;
  await fireStorage('pull#5'); // 60s 外：l 丢弃
  msgs = msgsOf();
  last = msgs[msgs.length - 1];
  assert(msgs.length === 50, '交错：l 丢弃 → 50 条', msgs.length);
  const tds = tdsOf();
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量不变', tds.length);
  let tdBad = 0;
  for (const mid of EXPECT_TD_ABOVE) {
    const el = msgs.find(m => m.dataset.mid === 'd' + mid);
    if (!el || !(el.previousSibling && el.previousSibling.classList.contains('chat-time-divider'))) { tdBad++; }
  }
  assert(tdBad === 0, '交错后 12 个 TD 位置未被破坏', tdBad);
}

console.log('\n' + (failed === 0 ? '✅ 时间标签套件通过' : '❌ 时间标签套件失败') + `：${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
