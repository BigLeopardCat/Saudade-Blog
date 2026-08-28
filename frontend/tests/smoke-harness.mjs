// ═ 看板娘集成冒烟 harness（20260828o 结构拆分回归）══
// node tests/smoke-harness.mjs：最小 DOM stub + 完整 autoload 加载链 +
// 一次真实 SSE 对话往返（发送 → 流式帧 → 转正 → 命令解析）。验证：
// ① 6 个文件按依赖序加载不抛错、工厂依赖校验通过；
// ② engine.init/stream.init 时序（#waifu 由 initWidget 创建后执行）无引用错误；
// ③ sendMessage 全流程：乐观插入 → live 气泡（msg-streaming）→ 收尾转正 →
//    saveHistory（localStorage 含 2 条）→ 时间标签（首条出现、第二条不重复）；
// ④ 停止按钮复位 / 输入框恢复 / broadcast 帧无异常。
import { readFileSync, existsSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/live2d-widgets');

// ── 最小 DOM stub ──
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
    this.open = false;
  }
  get className() { return this._className || ''; }
  set className(v) { this._className = v; this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
  get firstChild() { return this.children[0] || null; }
  get previousSibling() { return this.parentNode ? this.parentNode.children[this.parentNode.children.indexOf(this) - 1] || null : null; }
  get nextSibling() { return this.parentNode ? this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { if (!ref) return this.appendChild(c); const i = this.children.indexOf(ref); if (i < 0) return this.appendChild(c); c.parentNode = this; this.children.splice(i, 0, c); return c; }
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
  set innerHTML(v) { this._html = v; this.textContent = String(v).replace(/<[^>]*>/g, ''); }
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
globalThis.document = document; // vm 作用域内裸 document 解析到它
globalThis.Element = Element;   // live2d-widget.js 的 animate 检测引用全局 Element
// window === globalThis，engine.init 的 window.addEventListener('storage') 落到这里
globalThis.addEventListener = (t, fn) => { (document._listeners[t] = document._listeners[t] || []).push(fn); };
globalThis.removeEventListener = (t, fn) => { const a = document._listeners[t]; if (a) document._listeners[t] = a.filter(f => f !== fn); };
document.head.appendChild = (el) => {
  // script/link 加载：异步执行内容 + 触发 onload（模拟真实资源加载）
  setTimeout(() => {
    if (el.tagName === 'SCRIPT' && el.src && el.src.includes('/live2d-widgets/') && el.type !== 'module') {
      // autoload 动态加载的子模块：按 src 从磁盘读文件执行（真实加载路径）。
      // waifu-tips.js 是 ES module（type=module）跳过执行——其 initWidget 已被
      // harness 桩接管，只需触发 onload 走完加载链
      const name = el.src.split('/').pop().split('?')[0];
      const p = path.join(W, name);
      if (existsSync(p)) vm.runInThisContext(readFileSync(p, 'utf8'), { filename: name });
    }
    if (el.onload) el.onload(); else if (el.onerror) el.onerror();
  }, 0);
  return el;
};

// ── 浏览器全局 stub ──
const store = new Map();
const store2 = new Map();
globalThis.window = globalThis;
// sendMessage 上报 window.location.href；autoload observeTips 判 location.pathname
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
// 登录态：无 tokenKey 时 sendMessage 走游客合规门禁（只显示 notice 不发起 SSE）——
// 冒烟测真实对话链路，需种一个含 sub 的假 JWT（payload base64: {"sub":"123"}）
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
// Cubism 模型桩：guard/forceSlide/startCustomAnim 需要的嵌套结构
const coreModel = { setParameterValueById() {}, getParameterCount() { return 0; }, _parameterValues: [] };
const liveModel = { _modelSetting: { getHitAreasCount() { return 0; } }, _state: 22, getModel() { return coreModel; }, update() {}, __customAnimHooked: false };
const liveSub = { getLive2DManager() { return { _models: { getSize() { return 1; }, at() { return liveModel; } } }; } };
globalThis.__cubism5model = { subdelegates: { getSize() { return 1; }, at() { return liveSub; } } };
// initWidget 桩：创建 #waifu + canvas + tips + 工具按钮
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
// fetch 桩：history 空 + 一次 SSE 流（过程帧 + 正文帧 + 结束标记）
const FRAMES = [
  'data: ' + JSON.stringify('__PROCESS__:🧭 计划') + '\n\n',
  'data: ' + JSON.stringify('喵呜～测试回复') + '\n\n',
  'data: __END__\n\n',
];
let streamCount = 0;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/api/chat/history')) {
    return { ok: true, json: async () => ({ items: [] }) };
  }
  if (String(url).includes('/api/chat/discard')) {
    return { ok: true, json: async () => ({}) };
  }
  if (String(url).includes('/api/chat/stream')) {
    streamCount++;
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => (i < FRAMES.length ? { done: false, value: enc.encode(FRAMES[i++]) } : { done: true, value: undefined }) }) },
    };
  }
  throw new Error('unexpected fetch: ' + url);
};

// ── 加载 autoload（它内部按依赖序动态加载其余 5 个子模块——真实加载路径）──
vm.runInThisContext(readFileSync(path.join(W, 'autoload.js'), 'utf8'), { filename: 'autoload.js' });
// autoload 是 async IIFE：先等子模块 script onload 链完成再检查注册
await new Promise(r => setTimeout(r, 100));
const core = globalThis.__waifuChatCore;
if (!core) { console.error('✗ chat-core 未注册（子模块加载失败）'); process.exit(1); }

// 等待 autoload 异步链路完成（子模块 script onload → cubism → effects → initWidget → engine.init → stream.init）
await new Promise(r => setTimeout(r, 800));

let failed = 0;
const assert = (cond, name, detail) => {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const messages = document.getElementById('chat-messages');
const sendBtn = document.getElementById('chat-send');
const input = document.getElementById('chat-input');

assert(!!messages, '聊天面板已注入（#chat-messages 存在）');
assert(!!sendBtn && !!input, '发送按钮/输入框存在');
assert(messages.children.length === 0, '初始无消息');

// ── 第一轮对话（时间标签应出现：首条恒显示）──
input.value = '你好喵';
sendBtn.click();
await new Promise(r => setTimeout(r, 200));

let msgs = messages.children.filter(c => c.classList.contains('chat-msg'));
let tds = messages.children.filter(c => c.classList.contains('chat-time-divider'));
assert(msgs.length === 2, '乐观插入 + 转正后共 2 条消息', msgs.length);
assert(msgs[0].classList.contains('user') && msgs[1].classList.contains('agent'), 'user 在前 agent 在后');
assert(tds.length === 1, '首条消息上方有时间标签', tds.length);
assert(msgs[1].dataset.mid && msgs[1].dataset.finished === '1', 'agent 气泡已转正（mid + finished）');
assert(!msgs[1].querySelector('.msg-text').classList.contains('msg-streaming'), '流式 class 已移除');
assert(msgs[1].querySelector('.msg-text').textContent.includes('喵呜～测试回复'), '回复文本已渲染');
assert(!!msgs[1].querySelector('.agent-process-body'), '过程行已渲染（🧭 计划帧）');
assert(sendBtn.title === '发送' && !sendBtn.classList.contains('stop-mode'), '发送按钮已复位');
assert(input.disabled === false, '输入框已恢复');
const hist = JSON.parse(localStorage.getItem('chat_history_' + store.get('tokenKey')) || '[]');
assert(hist.length === 2, 'localStorage 历史含 2 条', hist.length);
assert(hist[0].type === 'user' && hist[1].type === 'agent', '历史条目类型正确');
assert(!hist[0].text.includes('__PROCESS__'), '过程帧未入库');
assert(streamCount === 1, 'SSE 请求发起 1 次');

// ── 第二轮对话（间隔 <5 分钟 → 不新增时间标签）──
input.value = '再发一条';
sendBtn.click();
await new Promise(r => setTimeout(r, 200));
msgs = messages.children.filter(c => c.classList.contains('chat-msg'));
tds = messages.children.filter(c => c.classList.contains('chat-time-divider'));
assert(msgs.length === 4, '第二轮共 4 条消息');
assert(tds.length === 1, '间隔小 → 时间标签不重复', tds.length);
assert(streamCount === 2, 'SSE 请求发起 2 次');

console.log('\n' + (failed === 0 ? '✅ 冒烟通过' : '❌ 冒烟失败') + `：${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
