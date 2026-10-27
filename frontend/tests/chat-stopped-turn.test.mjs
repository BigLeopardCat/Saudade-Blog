// Stop retains the original request and draft. Continue resumes its task;
// only explicit edit or regeneration discards the old turn.
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { installDom, installScriptLoader } from './stubs/dom.mjs';
// SSE 桩要带 content-type：20261002 起前端据它判"这是不是流"
import { sseHeaders } from './stubs/sse.mjs';

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
// 看板娘在这里**不打桩**（20261001 渲染层换自研）：上游 initWidget 与 __cubism5model 那套
// 嵌套结构已随 GPL 实现一起从仓库移除，现在由 renderer.js 自己建 #waifu 骨架。
// 真 renderer 在 Node 下会死在 PIXI 未定义处、被它自己的 .catch 兜住（模型画不出来，但工具条
// 照建、waifu-active 照加）——这正是本 harness 要覆盖的形状，别再加桩把它盖回假绿。

// ── 夹具 ──
const NOW = Date.now();
const CONV_ID = 7;
const M1 = '帮我看看这篇';        // 第一次被打断的那条
const M2 = '那换个说法';          // 第二次被打断的那条（用来验"补删"）
const M3 = '算了，先看别的';      // 打断之后主人**直接说的下一句**
const REFRESH_TEXT = '刷新后那条';

// 假 DB。关键一条：**服务端在转发之前就把用户消息入库**（Rust 的真实顺序），所以断流
// 之后拉历史仍能拿到那条 user 消息——"不丢它"在数据层才有依据。discard 的语义也照抄
// Rust（按最后一条 user 消息 + 原文校验定位，删掉从那条起的全部行）。
let DB = [{ id: 1, role: 'assistant', content: '你好呀', time: NOW - 60000 },
          { id: 9, role: 'user', content: REFRESH_TEXT, time: NOW - 1000 }];
let dbSeq = 100;
let nextMode = 'abortable';       // 下一条流的收尾形态：'abortable' | 'ignore'
let pullCount = 0;
let discardCalls = [];
let streamCalls = 0;
let seq = [];                     // 请求顺序与继续控制的请求体
let wantSnapshot = false;         // 下一次拉历史时先抓一份现场（= 停下那一刻的屏幕）
let atStopSnapshot = null;

const snapshot = () => ({
  users: midEls().filter(el => el.dataset.mtype === 'user').length,
  errNotes: errNotes().map(n => n.textContent),
  retryBtns: (msgsRoot() ? msgsRoot().querySelectorAll('.chat-retry-btn') : []).length,
});

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/chat/history')) {
    pullCount++;
    // 停下那一刻的屏幕：收尾块跑完 → `setTimeout(pullHistory,0)` → 进到这里。此刻还
    // 没被 DB 视图覆盖，是"主人当下看到的东西"的**确定性**取样点（不靠 sleep 抢时间）
    if (wantSnapshot) { wantSnapshot = false; atStopSnapshot = snapshot(); }
    return { ok: true, json: async () => ({ items: DB.slice(), conversation_id: CONV_ID }) };
  }
  if (u.includes('/api/chat/conversations')) return { ok: true, json: async () => ({ id: CONV_ID }) };
  if (u.includes('/api/monitor/log')) return { ok: true, json: async () => ({}) };
  if (u.includes('/api/chat/discard')) {
    const body = JSON.parse(opts.body);
    discardCalls.push(body);
    seq.push(['discard', body.text]);
    const idx = DB.map(r => (r.role === 'user' ? r.content : null)).lastIndexOf(body.text);
    if (idx >= 0) DB = DB.slice(0, idx);
    return { ok: true, json: async () => ({ success: true }) };
  }
  if (u.includes('/api/chat/stream')) {
    streamCalls++;
    const body = JSON.parse(opts.body);
    seq.push(['stream', body.message, body]);
    if (!body.resume_task) {
      dbSeq++;
      DB = DB.concat([{ id: dbSeq, role: 'user', content: body.message, time: Date.now() }]);
    }
    const mode = nextMode;
    nextMode = 'abortable';
    const enc = new TextEncoder();
    const frames = ['event: text\ndata: ' + JSON.stringify(
      body.resume_task ? '已继续完成。' : '正在读这篇') + '\n\n'];
    if (body.resume_task) {
      frames.push('event: done\ndata: {}\n\n');
      DB.push({ id: ++dbSeq, role: 'assistant', content: '已继续完成。', time: Date.now() });
    }
    let i = 0;
    // 只有 abort 能结束这一条（真实的 SSE 就是这样一直挂着）；'ignore' = 模拟
    // "浏览器对已开始读取的流 abort 不触发 AbortError"那个边界（3s 保险的用武之地）
    const pendingRead = () => (mode === 'ignore'
      ? new Promise(() => {})
      : new Promise((_, rej) => {
          const fire = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (opts.signal && opts.signal.aborted) fire();
          else if (opts.signal) opts.signal.addEventListener('abort', fire);
        }));
    return { ok: true, ...sseHeaders(), body: { getReader: () => ({ read: () => (i < frames.length
      ? Promise.resolve({ done: false, value: enc.encode(frames[i++]) })
      : body.resume_task ? Promise.resolve({ done: true }) : pendingRead()) }) } };
  }
  throw new Error('unexpected fetch: ' + url);
};

let unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String((e && e.message) || e)); });

const msgsRoot = () => document.getElementById('chat-messages');
const midEls = () => [...(msgsRoot() ? msgsRoot().children : [])].filter(c => c.className.split(' ').includes('chat-msg'));
const userBubbles = (text) => midEls().filter(el => el.dataset.mtype === 'user' && (text === undefined || el.dataset.mtext === text));
const errNotes = () => (msgsRoot() ? msgsRoot().querySelectorAll('.chat-msg-err-note') : []);
const failedNotes = () => (msgsRoot() ? msgsRoot().querySelectorAll('.chat-msg-failed-note') : []);
const failedText = () => {
  const t = failedNotes()[0] && failedNotes()[0].querySelector('.chat-msg-failed-text');
  return t ? t.textContent : '';
};
const btnsIn = (root) => (root ? root.querySelectorAll('.chat-retry-btn') : []);
const btnByText = (t) => btnsIn(failedNotes()[0]).find(b => b.textContent === t) || null;
const slotOf = (note) => (note ? note.querySelector('.chat-msg-retry-slot') : null);
const marker = () => {
  try {
    const c = JSON.parse(store.get('saudade-chat-failed') || 'null');
    return Array.isArray(c) && c.length ? c[0] : null;
  } catch (e) { return null; }
};
const inputEl = () => document.getElementById('chat-input');
const sendEl = () => document.getElementById('chat-send');
const say = (text) => { inputEl().value = text; sendEl().click(); };
const stop = () => sendEl().click();

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

// 刷新那条腿（场景 1）的前提：标记与那行 DB 记录**在开机之前**就位（见文件头注）
store.set('saudade-chat-failed', JSON.stringify([
  { text: REFRESH_TEXT, ts: NOW, reason: '已停止生成', kind: 'stopped' }]));

vm.runInThisContext(readFileSync(path.join(W, 'boot.js'), 'utf8'), { filename: 'boot.js' });
if (!await waitFor(() => !!globalThis.__waifuChatCore)) { console.error('chat-core 未注册（子模块加载失败）'); process.exit(1); }
await waitFor(() => midEls().length === 2);

console.log('== 场景 1：旧暂停记录提供重发/编辑；缺 kind 的记录保留错误提示 ==');
{
  assert(failedText() === '可以重新发送或编辑这条消息。', '旧记录明确可以重发或编辑', failedText());
  assert(btnsIn(failedNotes()[0]).length === 2, '按钮挂回来（刷新不是死路）', btnsIn(failedNotes()[0]).map(b => b.textContent));
  assert(slotOf(failedNotes()[0]) && slotOf(failedNotes()[0]).dataset.failedText === REFRESH_TEXT, '槽位带原文（补删/重发都要拿它去走原文校验）', slotOf(failedNotes()[0]) && slotOf(failedNotes()[0]).dataset.failedText);

  // 反向对照：没有 kind 的旧记录 ⇒ 旧话术（历史记录不迁移）
  store.set('saudade-chat-failed', JSON.stringify([
    { text: REFRESH_TEXT, ts: NOW, reason: '网络错误: Failed to fetch' }]));
  await fireStorage();
  assert(failedText() === '⏳ 该条消息未收到回复：网络错误: Failed to fetch', '缺 kind 的记录保留未收到回复提示', failedText());

  // 复位：后面几个场景从"干净的一页"（只有开场白）开始
  store.delete('saudade-chat-failed');
  DB = [{ id: 1, role: 'assistant', content: '你好呀', time: NOW - 60000 }];
  await fireStorage();
  const clean = await waitFor(() => userBubbles().length === 0 && failedNotes().length === 0);
  assert(clean, '复位干净（DB 视图里那条 user 项被收走，提示条也没了）', midEls().map(e => e.dataset.mid));
}

console.log('\n== 场景 2：按停止 → 消息留在原处、半截回复与重发/编辑立刻可见、零 discard ==');
{
  say(M1);
  await waitFor(() => streamCalls === 1 && streamingCount() === 1);
  assert(userBubbles(M1).length === 1, '发送后用户气泡在（发送路径照旧）', midEls().map(e => e.dataset.mtext));

  wantSnapshot = true;
  stop();
  await waitFor(() => !!atStopSnapshot);
  const s = atStopSnapshot || {};
  assert(s.users === 1, '**停下那一刻消息还在原地**（旧行为：当场被删）', s);
  assert(s.retryBtns === 3, '继续、重发、编辑立刻可用', s.retryBtns);
  assert((s.errNotes || []).includes('已停止生成'), '半截回复旁标出「已停止生成」', s.errNotes);

  // 落定：DB 拉取回来（DB 里只有那条 user 消息——残缺回复本来就没落库）
  await waitFor(() => failedNotes().length === 1 && btnsIn(failedNotes()[0]).length === 3);
  assert(discardCalls.length === 0, '**一个字节的 discard 都没发**（这一轮不丢）', discardCalls);
  assert(DB.some(r => r.role === 'user' && r.content === M1), 'DB 里那条 user 消息也还在', DB.map(r => r.content));
  assert(userBubbles(M1).length === 1, 'DB 视图回来之后它仍在屏幕上（不是"拉一次历史就没了"）', midEls().map(e => e.dataset.mtext));
  const m = marker();
  assert(!!m && m.kind === 'stopped' && m.text === M1, '标记带 kind=stopped（刷新后的措辞靠它）', m);
  assert(failedText() === '可以继续任务，也可以输入新的要求。', '暂停提示明确支持继续任务', failedText());
  assert(btnsIn(failedNotes()[0]).length === 3, '拉取重建之后按钮仍只有一组（钩子幂等）', btnsIn(failedNotes()[0]).map(b => b.textContent));
  // 半截回复的 'l' 项 60s 内不被 DB 视图收走 ⇒ 气泡上那份按钮与提示条这份会同时在场。
  // 屏幕上只该有**一组**（去重以提示条为准——它才是刷新后唯一活下来的那份）
  assert(btnsIn(msgsRoot()).length === 3, '屏幕上只有一组继续、重发、编辑，没有沿气泡再挂一份', btnsIn(msgsRoot()).map(b => b.textContent));
  assert(midEls().some(el => String(el.dataset.mid || '').startsWith('l')), '半截回复仍留在它自己的气泡里（断流别吞半截）', midEls().map(e => e.dataset.mid));
}

console.log('\n== 场景 3：点「✎ 编辑」= 明确表示这条不要了 ⇒ 当场删、原文回填、不再发一轮 ==');
{
  const before = streamCalls;
  const btn = btnByText('✎ 编辑');
  assert(!!btn, '提示条上有「✎ 编辑」', btnsIn(failedNotes()[0]).map(b => b.textContent));
  if (btn) btn.click();
  await waitFor(() => inputEl().value === M1);
  assert(discardCalls.length === 1 && discardCalls[0].text === M1, 'discard 带**被打断那条的原文**', discardCalls);
  assert(discardCalls[0].conversation_id === CONV_ID, 'discard 定向到当前会话（不误删别的会话的旧轮）', discardCalls[0]);
  assert(inputEl().value === M1, '原文回填输入框（改个措辞再发就是"编辑"的全部意义）', inputEl().value);
  assert(userBubbles(M1).length === 0, '旧气泡摘掉（不摘则改完再发会在历史里重复）', midEls().map(e => e.dataset.mtext));
  assert(streamCalls === before, '编辑**不**重发一轮', streamCalls - before);
  assert(!marker(), '标记一并清掉（否则下一趟渲染会把它当"还没处理的失败轮"又冒出来）', marker());
  assert(failedNotes().length === 0, '提示条随本轮收走（它讲的那条已经不在了）', failedText());
  assert(!midEls().some(el => String(el.dataset.mid || '').startsWith('l')), '半截回复跟着走（旧提问都删了，残句留着就是没有归属的一段话）', midEls().map(e => e.dataset.mid));
  inputEl().value = '';   // 输入框里那行是"待编辑"的，不属于后面的场景
}

console.log('\n== 场景 4：直接说下一句，保留原问题与部分回复，零 discard ==');
{
  say(M2);
  await waitFor(() => streamCalls === 2 && streamingCount() === 1);
  stop();
  await waitFor(() => failedNotes().length === 1 && marker() && marker().text === M2);
  // Track this draft independently of the next request's local message IDs.
  const partialEl = midEls().find(el => el.classList.contains('agent')
    && String(el.dataset.mid || '').startsWith('l'));
  const orphanMid = partialEl ? partialEl.dataset.mid : '';
  assert(!!orphanMid, '停下后那条部分回复有稳定标识', midEls().map(e => e.dataset.mid));
  assert(marker().kind === 'stopped', '第二条打断同样记 stopped', marker());
  assert(discardCalls.length === 1, '停下时仍然不发 discard', discardCalls.length);

  nextMode = 'ignore';   // 这一条连同它的停止一起走场景 5 那条腿
  say(M3);
  await waitFor(() => streamCalls === 3 && userBubbles(M3).length === 1);
  const lastTwo = seq.slice(-2);
  assert(lastTwo.every(entry => entry[0] === 'stream'), '新指令不自动 discard 原问题', lastTwo);
  assert(lastTwo[1][1] === M3, '新指令照常发送', lastTwo);
  assert(userBubbles(M2).length === 1, '原问题仍在屏幕上', midEls().map(e => e.dataset.mtext));
  assert(midEls().some(el => el.dataset.mid === orphanMid), '部分回复仍跟随原问题', midEls().map(e => e.dataset.mid));
  assert(DB.some(r => r.content === M2), '数据库中保留原问题', DB.map(r => r.content));
  assert(discardCalls.length === 1, '另发新指令没有发 discard', discardCalls);
  assert(!marker(), '旧任务的本地停止标记清除', marker());
}

console.log('\n== 场景 5：abort 没触发 AbortError（3s 保险那条腿）⇒ 同样的保留语义 ==');
{
  const pullsBefore = pullCount;
  const discardsBefore = discardCalls.length;
  stop();
  await new Promise(r => setTimeout(r, 700));
  assert(pullCount === pullsBefore, '收尾不是走 catch/finally（那条路会立刻补拉历史）', pullCount - pullsBefore);
  assert(await waitFor(() => sendEl().title === '发送', 6000), '3s 保险把界面强制恢复了（不卡在"停止生成"）', sendEl().title);
  assert(discardCalls.length === discardsBefore, '保险路径同样不发 discard', discardCalls.length - discardsBefore);
  const m = marker();
  assert(!!m && m.kind === 'stopped' && m.text === M3, '同样记 stopped 标记（刷新后仍看得到）', m);
  assert(userBubbles(M3).length === 1, '消息同样留在原地', midEls().map(e => e.dataset.mtext));
  assert(errNotes().some(n => n.textContent === '已停止生成'), '半截回复与「已停止生成」同样留在气泡里（与正常收尾同形）', errNotes().map(n => n.textContent));
  await fireStorage();
  assert(btnsIn(msgsRoot()).length === 3, '保险路径提供继续、重发、编辑', btnsIn(msgsRoot()).map(b => b.textContent));
}

console.log('\n== 场景 6：继续发送原任务控制，不新增用户消息或 discard ==');
{
  const saved = marker();
  const userCount = DB.filter(r => r.role === 'user').length;
  const streamsBefore = streamCalls;
  const discardsBefore = discardCalls.length;
  const resume = btnByText('继续任务');
  assert(!!resume && !!saved.task_id, '停止记录保留可继续的任务标识', saved);
  if (resume) resume.click();
  await waitFor(() => streamCalls === streamsBefore + 1 && sendEl().title === '发送');
  const body = seq.at(-1)[2];
  assert(body.resume_task === saved.task_id, '继续请求引用原任务标识', body);
  assert(body.conversation_id === CONV_ID && body.message === '', '继续是定向的空消息控制请求', body);
  assert(!body.task_id && !body.confirm_token, '继续既不新建任务也不附加确认授权', body);
  assert(discardCalls.length === discardsBefore, '继续不 discard 原问题', discardCalls);
  assert(DB.filter(r => r.role === 'user').length === userCount, '继续不在数据库追加用户行', DB);
  assert(userBubbles(M3).length === 1, '原用户气泡仅保留一份', midEls().map(e => e.dataset.mtext));
  assert(await waitFor(() => !marker()), '继续成功后清除停止标记', marker());
}

console.log('\n== 场景 7：显式重发先丢弃旧轮，再新建任务 ==');
{
  const text = '重发这个问题';
  const before = streamCalls;
  say(text);
  await waitFor(() => streamCalls === before + 1 && streamingCount() === 1);
  stop();
  await waitFor(() => marker()?.text === text && sendEl().title === '发送');
  const task = marker().task_id;
  const discardsBefore = discardCalls.length;
  const retry = btnByText('↻ 重发');
  assert(!!retry, '停止后可显式重发');
  if (retry) retry.click();
  await waitFor(() => streamCalls === before + 2);
  const lastTwo = seq.slice(-2);
  assert(discardCalls.length === discardsBefore + 1 && lastTwo[0][0] === 'discard',
    '重发先 discard 旧轮', lastTwo);
  assert(lastTwo[0][1] === text && lastTwo[1][1] === text, 'discard 与重发都绑定原问题', lastTwo);
  assert(lastTwo[1][2].task_id !== task && !lastTwo[1][2].resume_task,
    '重发分配新任务，不复用继续控制', lastTwo[1][2]);
  assert(DB.filter(r => r.role === 'user' && r.content === text).length === 1,
    '重发后数据库只有一条该问题', DB);
  stop();
  await waitFor(() => sendEl().title === '发送');
}

assert(unhandled.length === 0, '无未捕获异常', unhandled.slice(0, 2));

function streamingCount() {
  return msgsRoot() ? msgsRoot().querySelectorAll('.msg-streaming').length : 0;
}

console.log('\n' + (failed === 0 ? '✅ 主动打断保留套件通过' : '❌ 主动打断保留套件失败') + `：${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
