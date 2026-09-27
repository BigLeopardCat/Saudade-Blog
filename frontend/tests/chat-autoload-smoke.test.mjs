// ═ 看板娘集成冒烟：CI 断言套件（20260828o 结构拆分回归）══
// node tests/chat-autoload-smoke.test.mjs：最小 DOM stub + 完整 autoload 加载链 +
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
import { installDom, installScriptLoader } from './stubs/dom.mjs';

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/live2d-widgets');

// ── 最小 DOM stub（20260927 起与时间标签那支共用 tests/stubs/dom.mjs）──
// 抽出去的理由与三处真机语义见该文件头注；此前两份各复制一份、"同构"靠人记，
// 结果两支都没有 document.querySelector，一起死在 chat-stream.js:1896。
installDom();
installScriptLoader(W);   // head.appendChild → 真读 live2d-widgets/ 下的子模块执行

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
  if (String(url).includes('/api/chat/conversations')) {
    // 会话化（20260903）：空白新对话态发送前先建会话（`ensureConversation`）。
    // 此前这个 URL 没有桩 ⇒ fetch 抛"unexpected fetch" ⇒ 被 ensureConversation 的
    // catch 吞成 false ⇒ **每一轮都停在"创建新会话失败"气泡上**：harness 自称在测
    // SSE 往返，其实一次都没发出去（20260927 修）。
    return { ok: true, json: async () => ({ id: 1 }) };
  }
  if (String(url).includes('/api/monitor/log')) {
    // 前端错误上报（匿名可写）：harness 里出现它说明上游有报错，**不该让 fetch 炸**——
    // 那会把"某个模块初始化失败"变成一句与真因无关的 unexpected fetch
    return { ok: true, json: async () => ({}) };
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

// 轮询等待（替代固定 sleep）：固定 200ms 在慢机器/CI 上是**偶发红**的来源，
// 偶发红比没有测试更坏（会训练人忽略红）。等不到就照旧交给断言判红。
const waitFor = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  return cond();
};
const msgsOf = () => messages.children.filter(c => c.classList.contains('chat-msg'));
const tdsOf = () => messages.children.filter(c => c.classList.contains('chat-time-divider'));

assert(!!messages, '聊天面板已注入（#chat-messages 存在）');
assert(!!sendBtn && !!input, '发送按钮/输入框存在');
// 「初始无消息」按 .chat-msg 数：真机上 `#chat-ask`（常驻确认卡片）就住在
// `#chat-messages` 里，所以 children 一开始就不空——**空的是消息**。旧断言数的是
// children.length，那是扁平 stub（把 html 里的 id 一律挂成直接子节点）才成立的形状。
assert(msgsOf().length === 0, '初始无消息', msgsOf().length);

// ── 第一轮对话（时间标签应出现：首条恒显示）──
input.value = '你好喵';
sendBtn.click();
const round1 = await waitFor(() => msgsOf().length === 2);
let msgs = msgsOf();
let tds = tdsOf();
assert(round1, '乐观插入 + 转正后共 2 条消息', msgs.map(c => c.dataset.mtext));
assert(msgs[0].classList.contains('user') && msgs[1].classList.contains('agent'), 'user 在前 agent 在后');
assert(tds.length === 1, '首条消息上方有时间标签', tds.length);
assert(msgs[1].dataset.mid && msgs[1].dataset.finished === '1', 'agent 气泡已转正（mid + finished）');
assert(!msgs[1].querySelector('.msg-text').classList.contains('msg-streaming'), '流式 class 已移除');
assert(msgs[1].querySelector('.msg-text').textContent.includes('喵呜～测试回复'), '回复文本已渲染');
assert(!!msgs[1].querySelector('.agent-process-body'), '过程行已渲染（🧭 计划帧）');
assert(sendBtn.title === '发送' && !sendBtn.classList.contains('stop-mode'), '发送按钮已复位');
assert(input.disabled === false, '输入框已恢复');
// 缓存键自 20260903 起按会话分桶（`chat_history_<token>_(auto|<convId>)`）：写死
// `chat_history_<token>` 是那份键存在时的形状，现在只会读到空数组——那不是"没存"。
const histKeys = [...store.keys()].filter((k) => k.startsWith('chat_history_'));
assert(histKeys.length > 0, '本地缓存已写入（键按会话分桶）', [...store.keys()]);
const hist = histKeys.map((k) => JSON.parse(store.get(k) || '[]'))
  .reduce((a, b) => (b.length > a.length ? b : a), []);
assert(hist.length === 2, 'localStorage 历史含 2 条', { keys: histKeys, len: hist.length });
assert(hist.length === 2 && hist[0].type === 'user' && hist[1].type === 'agent', '历史条目类型正确');
assert(hist.length === 2 && !hist[0].text.includes('__PROCESS__'), '过程帧未入库');
assert(streamCount === 1, 'SSE 请求发起 1 次', streamCount);

// ── 第二轮对话（间隔 <5 分钟 → 不新增时间标签）──
input.value = '再发一条';
sendBtn.click();
const round2 = await waitFor(() => msgsOf().length === 4);
msgs = msgsOf();
tds = tdsOf();
assert(round2, '第二轮共 4 条消息', msgs.length);
assert(tds.length === 1, '间隔小 → 时间标签不重复', tds.length);
assert(streamCount === 2, 'SSE 请求发起 2 次', streamCount);

console.log('\n' + (failed === 0 ? '✅ 冒烟通过' : '❌ 冒烟失败') + `：${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
