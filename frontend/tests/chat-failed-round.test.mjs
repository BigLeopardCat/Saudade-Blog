// ═ 失败轮"刷新后仍可重发/编辑"：CI 断言套件（20260927）══
//   node tests/chat-failed-round.test.mjs
//
// 缘起（用户报的覆盖缺口）：后端出错时那条消息**不进 chat_history**，但错误气泡
// 显示在对话框里；而重发/编辑按钮只有部分场景才挂得上——刷新一次就只剩一句
// 「未收到回复」，主人既不知道为什么、也没法重来。用户拍板的口径是
// **"不入库，但要能刷新后存活"**：DB 与历史注入保持干净（不把系统话术冒充成
// assistant 说过的话），失败轮连同**原因**存 localStorage，刷新后照旧渲染带原因
// 的错误气泡并挂回两个按钮。
//
// 本套件钉住的四件事（每一件都是"改坏了没人知道"的类型）：
//   ① 刷新后提示条带**原因**（`reason`；旧记录没有这个字段 ⇒ 回退到笼统说法，
//      历史记录不迁移）；
//   ② 提示条里的空槽被 `onFailedResync` 钩子挂上两个按钮，且**幂等**——每趟
//      reconcile 都会把提示条（无 mid、不进 items）当孤儿删掉重建，钩子跟着重挂；
//      不幂等就是按钮越挂越多；
//   ③ 按钮点了**必须有话说**：discard 三种失败（原文对不上 / 登录失效 / 连不上）
//      各自回一句能指导下一步的话，而不是闪一下复原；
//   ④ 成功那条路真的办成了事：带原文与 conversation_id 的 discard + 原文回填输入框
//      + 摘掉那条旧用户气泡（否则重发会在历史里重复）。
//
// 为什么用真 boot（而不是切片求值）：这些行为横跨三个模块的接线——引擎渲染槽位、
// 钩子在 reconcile 末尾被调、交互层闭包里的 discard/回填。切片只能证明"函数写得对"，
// 证明不了"这条线接上了"。本仓已有两次"能力有测试、接线没人测"的前科。
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { installDom, installScriptLoader } from './stubs/dom.mjs';

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/live2d-widgets');

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
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = BroadcastChannelStub;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} };
globalThis.Image = class {};
globalThis.Live2DCubismCore = {};
globalThis.__chatRenderMarkdown = (t) => String(t);
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

// ── 夹具：一条已答复的往返 + 末条"没收到回复"的 user 消息 ──
// 末条必须是**最后一条 item**（引擎的失败判据是"最后一条是匹配标记的 user 且其后
// 没有 agent 回复"）——这正是刷新后 DB 里的真实形状：user 消息入库了，回复没有。
const NOW = Date.now();
const FAIL_TEXT = '这条消息没收到回复';
const FAIL_REASON = '网络错误: Failed to fetch';
const HISTORY = [
  { id: 1, role: 'assistant', content: '你好呀', time: NOW - 60000 },
  { id: 2, role: 'user', content: FAIL_TEXT, time: NOW - 50000 },
];
const CONV_ID = 7;

let discardMode = 'ok';          // 'ok' | 'mismatch' | 'unauthorized' | 'throw'
let discardCalls = [];
let streamCalls = 0;
let pullCount = 0;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/chat/history')) {
    pullCount++;
    return { ok: true, json: async () => ({ items: HISTORY, conversation_id: CONV_ID }) };
  }
  if (u.includes('/api/chat/conversations')) return { ok: true, json: async () => ({ id: CONV_ID }) };
  if (u.includes('/api/monitor/log')) return { ok: true, json: async () => ({}) };
  if (u.includes('/api/chat/discard')) {
    discardCalls.push(JSON.parse(opts.body));
    if (discardMode === 'throw') throw new TypeError('Failed to fetch');
    if (discardMode === 'mismatch') return { ok: true, json: async () => ({ success: false, reason: 'mismatch' }) };
    if (discardMode === 'unauthorized') return { ok: true, json: async () => ({ success: false, error: 'unauthorized' }) };
    return { ok: true, json: async () => ({ success: true }) };
  }
  if (u.includes('/api/chat/stream')) {
    streamCalls++;
    const enc = new TextEncoder();
    const FRAMES = ['data: ' + JSON.stringify('喵') + '\n\n', 'data: __END__\n\n'];
    let i = 0;
    return { ok: true, body: { getReader: () => ({ read: async () => (i < FRAMES.length ? { done: false, value: enc.encode(FRAMES[i++]) } : { done: true, value: undefined }) }) } };
  }
  throw new Error('unexpected fetch: ' + url);
};

let unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String((e && e.message) || e)); });

const msgsRoot = () => document.getElementById('chat-messages');
const notes = () => [...(msgsRoot() ? msgsRoot().children : [])].filter(c => c.classList.contains('chat-msg-failed-note'));
const note = () => notes()[0] || null;
const noteText = () => { const n = note(); return n && n.querySelector('.chat-msg-failed-text') ? n.querySelector('.chat-msg-failed-text').textContent : ''; };
const slot = () => note() ? note().querySelector('.chat-msg-retry-slot') : null;
const btns = () => note() ? note().querySelectorAll('.chat-retry-btn') : [];
const btnByText = (t) => btns().find(b => b.textContent === t) || null;
const hintText = () => { const h = note() ? note().querySelector('.chat-retry-hint') : null; return h ? h.textContent : ''; };
const midEls = () => [...(msgsRoot() ? msgsRoot().children : [])].filter(c => c.className.split(' ').includes('chat-msg'));

const waitFor = async (cond, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  return cond();
};
const settle = () => new Promise(r => setTimeout(r, 20));
const fireStorage = async () => {
  const keys = [...store.keys()].filter(k => k.startsWith('chat_history_') && !k.includes('backup'));
  const key = keys[keys.length - 1] || ('chat_history_' + store.get('tokenKey'));
  const before = pullCount;
  (document._listeners['storage'] || []).forEach(fn => fn({ key }));
  await waitFor(() => pullCount > before);
  await settle();
};
let failed = 0;
const assert = (cond, name, detail) => {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

// 预置失败标记（新形态带 reason），再真启动整条加载链
store.set('saudade-chat-failed', JSON.stringify([{ text: FAIL_TEXT, ts: NOW, reason: FAIL_REASON }]));

vm.runInThisContext(readFileSync(path.join(W, 'autoload.js'), 'utf8'), { filename: 'autoload.js' });
if (!await waitFor(() => !!globalThis.__waifuChatCore)) { console.error('chat-core 未注册（子模块加载失败）'); process.exit(1); }
await waitFor(() => midEls().length === 2);

console.log('== 场景 1：刷新后（预置 marker + DB 末条 = 那条 user）提示条带原因、按钮挂回来 ==');
{
  assert(!!note(), '失败提示条已渲染', midEls().length);
  assert(noteText() === '⏳ 该条消息未收到回复：' + FAIL_REASON, '提示条带原因（不是笼统说法）', noteText());
  assert(notes().length === 1, '提示条只有一条', notes().length);
  const s = slot();
  assert(!!s && s.dataset.failedText === FAIL_TEXT, '槽位带原文（钩子要拿它去走带原文校验的 discard）', s && s.dataset.failedText);
  const wrap = note().querySelector('.chat-msg-retry');
  assert(!!wrap, '按钮组已挂上（刷新前这是缺的那一环）', !!wrap);
  assert(btns().length === 2, '两个按钮：重发 + 编辑', btns().map(b => b.textContent));
  assert(!!btnByText('↻ 重发') && !!btnByText('✎ 编辑'), '按钮文案即动作（↻ 重发 / ✎ 编辑）', btns().map(b => b.textContent));
  assert(note().querySelectorAll('.chat-retry-hint').length === 0, '初始无提示语（没点过按钮不该有话说）');
}

console.log('\n== 场景 2：再来一趟 reconcile（提示条被当孤儿删掉重建）→ 按钮仍只有一组 ==');
{
  await fireStorage();
  assert(!!note(), '提示条重建');
  assert(btns().length === 2, '钩子幂等：重建后仍是一组按钮，没有叠出第二组', btns().map(b => b.textContent));
  assert(notes().length === 1, '提示条仍只有一条', notes().length);
}

console.log('\n== 场景 3：discard 说"原文对不上"（这一轮不在服务端记录里）→ 点重发要说话、且什么都不删 ==');
{
  discardMode = 'mismatch';
  const streamsBefore = streamCalls;
  btnByText('↻ 重发').click();
  await waitFor(() => !!hintText());
  assert(hintText() === '这一轮已经不在服务端记录里，没有可删除的旧轮', '把后端那句回答分类后说给主人', hintText());
  assert(btnByText('↻ 重发') && btnByText('↻ 重发').disabled === false, '按钮复原可再点（不是禁用态卡住）', btnByText('↻ 重发') && btnByText('↻ 重发').disabled);
  assert(!!note(), '失败轮没被误删（原文还在气泡里可复制）', !!note());
  assert(store.has('saudade-chat-failed'), '失败标记也还在（刷新后仍能看到这条）');
  assert(streamCalls === streamsBefore, '没有偷偷发出去一轮（discard 失败即放弃，不重发）', streamCalls - streamsBefore);
  assert(discardCalls.length === 1 && discardCalls[0].text === FAIL_TEXT, 'discard 带原文', discardCalls[0]);
}

console.log('\n== 场景 4：discard 说"未授权"（登录失效）→ 提示语换成刷新页面 ==');
{
  discardMode = 'unauthorized';
  btnByText('✎ 编辑').click();
  await waitFor(() => hintText() === '登录状态已失效，刷新页面后再试');
  assert(hintText() === '登录状态已失效，刷新页面后再试', '登录失效有专门说法（不是"连不上服务端"）', hintText());
  assert(!!note(), '同样不删任何东西');
}

console.log('\n== 场景 5：discard 成功 → 编辑真的办了事（原文回填 + 旧气泡摘掉）==');
{
  discardMode = 'ok';
  const discardBefore = discardCalls.length;
  btnByText('✎ 编辑').click();
  await waitFor(() => document.getElementById('chat-input').value === FAIL_TEXT);
  assert(discardCalls.length === discardBefore + 1, '发了一次 discard', discardCalls.length - discardBefore);
  const body = discardCalls[discardCalls.length - 1];
  assert(body.text === FAIL_TEXT, 'discard 带原文（Rust 侧原文校验的双保险）', body);
  assert(body.conversation_id === CONV_ID, 'discard 定向到当前会话（不误删别的会话的旧轮）', body);
  assert(document.getElementById('chat-input').value === FAIL_TEXT, '原文（含图片路径）回填输入框', document.getElementById('chat-input').value);
  assert(!note(), '提示条随本轮一起被摘掉（那一轮的失败标记已清）');
  assert(!midEls().some(el => el.dataset.mid === 'd2'), '旧用户气泡已删除（不删则重发会渲染出重复内容）', midEls().map(el => el.dataset.mid));
  assert(unhandled.length === 0, '无未捕获异常', unhandled.slice(0, 2));
}

console.log('\n== 场景 6：24h 过期的标记不再渲染提示条（陈旧失败不吓人）==');
{
  store.set('saudade-chat-failed', JSON.stringify([{ text: FAIL_TEXT, ts: NOW - 25 * 3600 * 1000, reason: FAIL_REASON }]));
  await fireStorage();
  assert(!note(), '过期标记不渲染提示条', note() && noteText());
  assert(midEls().length === 2, '历史照旧（DB 视图把那条 user 消息带回来了）', midEls().map(el => el.dataset.mid));
}

console.log('\n== 场景 7：旧形态记录（没有 reason 字段）→ 回退到笼统说法，但按钮照旧有 ==');
{
  store.set('saudade-chat-failed', JSON.stringify([{ text: FAIL_TEXT, ts: Date.now() }]));
  await fireStorage();
  assert(noteText() === '⏳ 该条消息未收到回复（可能已超时或网络中断）', '缺 reason ⇒ 回退原话术（历史记录不迁移）', noteText());
  assert(btns().length === 2, '旧记录同样挂得出重发/编辑', btns().map(b => b.textContent));
}

console.log('\n== 场景 8：连接不上（discard 抛）→ 也有一句能指导下一步的话 ==');
{
  discardMode = 'throw';
  btnByText('↻ 重发').click();
  await waitFor(() => hintText() === '连不上服务端，稍后再试');
  assert(hintText() === '连不上服务端，稍后再试', '连不上 ≠ 原文对不上 ≠ 登录失效（三种话各自不同）', hintText());
  assert(!!note(), '仍然什么都不删');
}

console.log('\n' + (failed === 0 ? '✅ 失败轮重发套件通过' : '❌ 失败轮重发套件失败') + `：${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
