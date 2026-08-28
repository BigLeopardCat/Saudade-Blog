// ═ 时间标签错位复现 harness（20260828o 浏览器回归发现的 bug）══
// 用户现场：主窗口"天气消息下方显示昨天20:42"、后台窗口"网络错误消息上方显示昨天20:42"。
// 复现链条：50 条历史（首条昨天20:42）→ 发消息 → SSE 断流 → catch 转正（l 轮, 今天）
// → saveHistory → storage 触发 pullHistory（60s 窗口内外两种）→ reconcileDOM 检查 TD 位置。
// 运行：node tests/repro-timegap.mjs
import { readFileSync, existsSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

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

// ── 最小 DOM stub（与 smoke-harness 同构）──
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c) { this.contains(c) ? this.remove(c) : this.add(c); }
}
class Element {
  constructor(tag, id) {
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this.parentNode = null;
    this._listeners = {};
    this._attrs = {};
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this.textContent = '';
    this._html = '';
    this.disabled = false;
    this.title = '';
    this.value = '';
    this.src = '';
    this.type = '';
  }
  get className() { return this._className || ''; }
  set className(v) { this._className = v; this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
  get firstChild() { return this.children[0] || null; }
  get previousSibling() { return this.parentNode ? this.parentNode.children[this.parentNode.children.indexOf(this) - 1] || null : null; }
  get nextSibling() { return this.parentNode ? this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null : null; }
  appendChild(c) { if (c.parentNode && c.parentNode !== this) { const i = c.parentNode.children.indexOf(c); if (i >= 0) c.parentNode.children.splice(i, 1); } c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    // 真实 DOM 移动语义：已挂载的元素先移除再插入
    if (c.parentNode && c.parentNode !== this) { const i = c.parentNode.children.indexOf(c); if (i >= 0) c.parentNode.children.splice(i, 1); }
    if (c.parentNode === this) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    if (!ref) { c.parentNode = this; this.children.push(c); return c; }
    const i = this.children.indexOf(ref);
    if (i < 0) { c.parentNode = this; this.children.push(c); return c; }
    c.parentNode = this;
    this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k] ?? null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { const a = this._listeners[t]; if (a) this._listeners[t] = a.filter(f => f !== fn); }
  focus() {}
  contains() { return false; }
  animate() {}
  matches() { return false; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matchesSel(c, sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  set innerHTML(v) { this._html = v; this.textContent = String(v).replace(/<[^>]*>/g, ''); this._htmlSets = (this._htmlSets || 0) + 1; }
  get innerHTML() { return this._html; }
  insertAdjacentHTML(pos, html) {
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    for (const id of ids) {
      const el = new Element('div', id);
      document._byId[id] = el;
      this.appendChild(el);
    }
  }
  click() { (this._listeners.click || []).forEach(fn => fn({ target: this, stopPropagation() {}, preventDefault() {} })); }
}
function matchesSel(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('[')) return true;
  return el.tagName === sel.toUpperCase();
}
const document = {
  _byId: {},
  _listeners: {},
  head: new Element('head'),
  createElement(tag) { return new Element(tag); },
  getElementById(id) { return this._byId[id] || null; },
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  removeEventListener() {},
  dispatchEvent() {},
};
globalThis.document = document;
globalThis.Element = Element;
globalThis.addEventListener = (t, fn) => { (document._listeners[t] = document._listeners[t] || []).push(fn); };
globalThis.removeEventListener = (t, fn) => { const a = document._listeners[t]; if (a) document._listeners[t] = a.filter(f => f !== fn); };
document.head.appendChild = (el) => {
  setTimeout(() => {
    if (el.tagName === 'SCRIPT' && el.src && el.src.includes('/live2d-widgets/') && el.type !== 'module') {
      const name = el.src.split('/').pop().split('?')[0];
      const p = path.join(W, name);
      if (existsSync(p)) vm.runInThisContext(readFileSync(p, 'utf8'), { filename: name });
    }
    if (el.onload) el.onload(); else if (el.onerror) el.onerror();
  }, 0);
  return el;
};

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
const coreModel = { setParameterValueById() {}, getParameterCount() { return 0; }, _parameterValues: [] };
const liveModel = { _modelSetting: { getHitAreasCount() { return 0; } }, _state: 22, getModel() { return coreModel; }, update() {}, __customAnimHooked: false };
const liveSub = { getLive2DManager() { return { _models: { getSize() { return 1; }, at() { return liveModel; } } }; } };
globalThis.__cubism5model = { subdelegates: { getSize() { return 1; }, at() { return liveSub; } } };
globalThis.initWidget = (opts, models) => {
  const waifu = new Element('div', 'waifu');
  waifu.classList.add('waifu-active');
  document._byId.waifu = waifu;
  const canvas = new Element('canvas', 'live2d'); waifu.appendChild(canvas); document._byId.live2d = canvas;
  const tips = new Element('div', 'waifu-tips'); waifu.appendChild(tips); document._byId['waifu-tips'] = tips;
  const tool = new Element('div', 'waifu-tool'); waifu.appendChild(tool); document._byId['waifu-tool'] = tool;
  for (const id of ['hitokoto', 'switch-model', 'switch-texture']) {
    const b = new Element('span', 'waifu-tool-' + id); tool.appendChild(b); document._byId['waifu-tool-' + id] = b;
  }
};

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
// 假时钟：Date.now 偏移（replaceWithIncoming 60s 判定用 Date.now()）
const realNow = Date.now.bind(Date);
let nowOffset = 0;
Date.now = () => realNow() + nowOffset;
// 场景 2b 的 catch 内 applyMsg(null) crash 是异步未捕获异常：node 默认退出，兜住计数
let unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String((e && e.message) || e)); });
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/api/chat/history')) {
    pullCount++;
    return { ok: true, json: async () => ({ items: HISTORY }) };
  }
  if (String(url).includes('/api/chat/discard')) return { ok: true, json: async () => ({}) };
  if (String(url).includes('/api/chat/stream')) {
    if (streamMode === 'fetch-fail') throw new TypeError('Failed to fetch'); // 连接层失败（contentSpan 未建）
    if (streamMode === 'error-frame') {
      // agent 重启：Rust 上游断开 → 发 __ERROR__ 帧（chat.rs:546 真实格式：裸前缀 + JSON 字符串）
      const enc = new TextEncoder();
      const FRAMES = ['data: __ERROR__:"与 Agent 的连接中断，回复可能不完整"\n\n'];
      let i = 0;
      return { ok: true, body: { getReader: () => ({ read: async () => (i < FRAMES.length ? { done: false, value: enc.encode(FRAMES[i++]) } : { done: true, value: undefined }) }) } };
    }
    const enc = new TextEncoder();
    const FRAMES = ['data: ' + JSON.stringify('喵呜测试') + '\n\n', 'data: __END__\n\n'];
    let i = 0;
    return { ok: true, body: { getReader: () => ({ read: async () => (i < FRAMES.length ? { done: false, value: enc.encode(FRAMES[i++]) } : { done: true, value: undefined }) }) } };
  }
  throw new Error('unexpected fetch: ' + url);
};
const fireStorage = async (label) => {
  const fns = document._listeners['storage'] || [];
  fns.forEach(fn => fn({ key: 'chat_history_' + store.get('tokenKey') }));
  await new Promise(r => setTimeout(r, 500)); // 400ms 防抖 + fetch
};

vm.runInThisContext(readFileSync(path.join(W, 'autoload.js'), 'utf8'), { filename: 'autoload.js' });
await new Promise(r => setTimeout(r, 100));
await new Promise(r => setTimeout(r, 800));
const core = globalThis.__waifuChatCore;
if (!core) { console.error('chat-core 未注册'); process.exit(1); }

let failed = 0;
const assert = (cond, name, detail) => {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const tdsOf = () => [...document.getElementById('chat-messages').children]
  .filter(c => c.classList.contains('chat-time-divider'));
const msgsOf = () => [...document.getElementById('chat-messages').children]
  .filter(c => c.classList.contains('chat-msg'));

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
  // 固定当前时间 14:52:30：与末条 DB 记录 1895@14:51:56 间隔 <5min → user 消息上方无 TD
  // （TD 总数恒为 14），且后续场景的 60s 窗口判定（replaceWithIncoming 用 Date.now()）全部确定
  nowOffset = T(2026, 8, 28, 14, 52, 30) - realNow();
  const input = document.getElementById('chat-input');
  input.value = '可以呀帮我看看杭州钱塘区天气';
  document.getElementById('chat-send').click();
  await new Promise(r => setTimeout(r, 300));
  dump('断流后');
  const msgs = msgsOf();
  const tds = tdsOf();
  const last = msgs[msgs.length - 1];
  assert(msgs.length === 52, '50 历史 + user + 网络错误气泡 = 52 条', msgs.length);
  assert(!last.dataset.mid, '网络错误气泡无 mid（__ERROR__ 帧无回复内容不转正——设计行为，与真实 DB 一致）', last.dataset.mid);
  const t = last.querySelector('.msg-text');
  assert(!!t && t.textContent.includes('网络错误: 与 Agent 的连接中断'), '末条显示网络错误文案', t && t.textContent.slice(0, 40));
  assert(!(last.previousSibling && last.previousSibling.classList.contains('chat-time-divider')), '网络错误上方无 TD');
  assert(tds.length === EXPECT_TD_ABOVE.length, 'TD 数量 = 14（user 与 1895 间隔 <5min 不新增）', tds.length);
  let tdBad = 0;
  for (const mid of EXPECT_TD_ABOVE) {
    const el = msgs.find(m => m.dataset.mid === 'd' + mid);
    if (!el || !(el.previousSibling && el.previousSibling.classList.contains('chat-time-divider'))) { tdBad++; }
  }
  assert(tdBad === 0, '原有 14 个 TD 位置未被破坏', tdBad);
}

console.log('\n== 场景 8：fetch 层失败（连接级）→ 自建错误气泡（20260828o 修复验证）==');
streamMode = 'fetch-fail';
{
  const before = msgsOf().length;
  const input = document.getElementById('chat-input');
  input.value = '测试连接失败';
  document.getElementById('chat-send').click();
  await new Promise(r => setTimeout(r, 200));
  const msgs = msgsOf();
  assert(msgs.length === before + 2, '用户消息 + 自建错误气泡（修复前气泡缺失只有 user 消息）', msgs.length);
  assert(unhandled.length === 0, '无 crash（contentSpan=null 时 catch 自建气泡再 applyMsg）', unhandled.slice(0, 2));
  const last = msgs[msgs.length - 1];
  assert(!last.dataset.mid, '错误气泡无 mid（不转正不保存）', last.dataset.mid);
  const t = last.querySelector('.msg-text');
  assert(!!t && t.textContent.includes('网络错误: Failed to fetch'), '错误文案已渲染', t && t.textContent.slice(0, 40));
  assert(tdsOf().length === EXPECT_TD_ABOVE.length, 'TD 数量不变', tdsOf().length);
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
  await new Promise(r => setTimeout(r, 50));
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
  await new Promise(r => setTimeout(r, 200));
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

console.log('\n' + (failed === 0 ? '✅ 复现 harness 全过——未复现错位（bug 需真实 DOM 证据）' : '❌ 复现成功——bug 锁定') + `：${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
