// ═ 主动打断的一轮"不丢"：CI 断言套件（20261001）══
//   node tests/chat-stopped-turn.test.mjs
//
// 缘起（用户拍板的口径）：主人按了「停止生成」之后，那条消息**不再从对话框里消失**。
// 旧行为是当场三件一起做——删本地条目与缓存、摘掉气泡、发 discard 让 Rust 把 DB 里的
// user 消息与残缺回复一起删。于是"手滑按错了 / 想改个措辞"时消息已经没了，只能重新
// 打一遍。新规矩：**留在原处可二次编辑/重发**；既不编辑也不重发、**直接说下一句** ⇒
// 到那一刻才丢（discard 推迟到下一次发言）。
//
// 本套件钉住的五件事（每一件都是"改坏了没人知道"的类型）：
//   ① 刷新后 `kind:'stopped'` 渲染「⏹ 被你停止了」而不是「⏳ 未收到回复」——
//      措辞必须分开：混成一句，刷新一次就被读成"agent 挂了"；缺 `kind` 的旧记录
//      照旧走 ⏳（反向对照）；
//   ② 打断那一刻：消息还在原地、半截回复标着「已停止生成」、重发/编辑立刻挂上，
//      且**一个字节的 discard 都没发**；
//   ③ 打断后点「✎ 编辑」= 明确表示"这条不要了" ⇒ 当场删、原文回填输入框、不再发一轮；
//   ④ 补删的时机与**顺序**：主人直接说下一句时才删，且 discard 必须**先于**新消息
//      落库——反过来时"同文重发"（主人重发同一句话是最自然的动作）会让后端那句
//      原文校验通过、删掉的是**刚发出去的那条**；
//   ⑤ 3s 保险那条腿（浏览器对已开始读取的流 abort 不触发 AbortError 时）同样是保留语义
//      ——这一段与正常收尾**共用一份实现**（`retainStoppedTurn`），此前是两份拷贝，
//      而且已经漂了（一份转正半截回复、一份没有）。
//
// **①为什么排在文件最前**：它模拟的是"刷新"——面板刚起来、`items` 里只有 DB 视图。
// 中断轮跑过之后再换一份 DB 去"模拟刷新"是**假的**：保留语义会在内存里留下那条 'l'
// 用户项（`retainStoppedTurn` 转正的那条，60s 内不被 DB 视图收走），引擎的锚点落到
// 它身上、原文匹配自然对不上新标记，于是"提示条没渲染"会变成一个假红。真刷新会把
// 内存整个丢掉，这里用"开机时就把标记与那行 DB 记录摆好"等价地表达同一个前提。
//
// 为什么用真 boot（而不是切片求值）：这些行为横跨三层接线——查流循环的 catch 分支、
// `finally` 之后的收尾块、以及 reconcile 末尾的 `onFailedResync` 钩子（按钮是那一趟
// 重建提示条时挂上去的）。切片只能证明"函数写得对"，证明不了"这条线接上了"。
// 本仓已有两次"能力有测试、接线没人测"的前科。
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
let seq = [];                     // 请求先后（补删必须**先于**新消息落库）
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
    seq.push(['stream', body.message]);
    dbSeq++;
    DB = DB.concat([{ id: dbSeq, role: 'user', content: body.message, time: Date.now() }]);
    const mode = nextMode;
    nextMode = 'abortable';
    const enc = new TextEncoder();
    const frames = ['data: ' + JSON.stringify('正在读这篇') + '\n\n'];
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
    return { ok: true, body: { getReader: () => ({ read: () => (i < frames.length
      ? Promise.resolve({ done: false, value: enc.encode(frames[i++]) })
      : pendingRead()) }) } };
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

vm.runInThisContext(readFileSync(path.join(W, 'autoload.js'), 'utf8'), { filename: 'autoload.js' });
if (!await waitFor(() => !!globalThis.__waifuChatCore)) { console.error('chat-core 未注册（子模块加载失败）'); process.exit(1); }
await waitFor(() => midEls().length === 2);

console.log('== 场景 1：刷新后 stopped 说「被你停止了」；缺 kind 的旧记录照旧说「未收到回复」 ==');
{
  assert(failedText() === '⏹ 这条消息被你停止了，这一轮不会再回答（可重发或编辑）', '刷新后说的是「被你停止了」', failedText());
  assert(btnsIn(failedNotes()[0]).length === 2, '按钮挂回来（刷新不是死路）', btnsIn(failedNotes()[0]).map(b => b.textContent));
  assert(slotOf(failedNotes()[0]) && slotOf(failedNotes()[0]).dataset.failedText === REFRESH_TEXT, '槽位带原文（补删/重发都要拿它去走原文校验）', slotOf(failedNotes()[0]) && slotOf(failedNotes()[0]).dataset.failedText);

  // 反向对照：没有 kind 的旧记录 ⇒ 旧话术（历史记录不迁移）
  store.set('saudade-chat-failed', JSON.stringify([
    { text: REFRESH_TEXT, ts: NOW, reason: '网络错误: Failed to fetch' }]));
  await fireStorage();
  assert(failedText() === '⏳ 该条消息未收到回复：网络错误: Failed to fetch', '缺 kind ⇒ 回退「未收到回复」（不是「被你停止」）', failedText());

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
  assert(s.retryBtns === 2, '重发/编辑立刻挂上（不是等刷新、也不是等下一趟 reconcile）', s.retryBtns);
  assert((s.errNotes || []).includes('已停止生成'), '半截回复旁标出「已停止生成」', s.errNotes);

  // 落定：DB 拉取回来（DB 里只有那条 user 消息——残缺回复本来就没落库）
  await waitFor(() => failedNotes().length === 1 && btnsIn(failedNotes()[0]).length === 2);
  assert(discardCalls.length === 0, '**一个字节的 discard 都没发**（这一轮不丢）', discardCalls);
  assert(DB.some(r => r.role === 'user' && r.content === M1), 'DB 里那条 user 消息也还在', DB.map(r => r.content));
  assert(userBubbles(M1).length === 1, 'DB 视图回来之后它仍在屏幕上（不是"拉一次历史就没了"）', midEls().map(e => e.dataset.mtext));
  const m = marker();
  assert(!!m && m.kind === 'stopped' && m.text === M1, '标记带 kind=stopped（刷新后的措辞靠它）', m);
  assert(failedText() === '⏹ 这条消息被你停止了，这一轮不会再回答（可重发或编辑）', '提示条说的是「被你停止了」而不是「未收到回复」', failedText());
  assert(btnsIn(failedNotes()[0]).length === 2, '拉取重建之后按钮仍只有一组（钩子幂等）', btnsIn(failedNotes()[0]).map(b => b.textContent));
  // 半截回复的 'l' 项 60s 内不被 DB 视图收走 ⇒ 气泡上那份按钮与提示条这份会同时在场。
  // 屏幕上只该有**一组**（去重以提示条为准——它才是刷新后唯一活下来的那份）
  assert(btnsIn(msgsRoot()).length === 2, '屏幕上只有一组重发/编辑，没有沿气泡再挂一份', btnsIn(msgsRoot()).map(b => b.textContent));
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

console.log('\n== 场景 4：不重发也不编辑，直接说下一句 ⇒ 到那一刻才补删（且先于新消息） ==');
{
  say(M2);
  await waitFor(() => streamCalls === 2 && streamingCount() === 1);
  stop();
  await waitFor(() => failedNotes().length === 1 && marker() && marker().text === M2);
  // 半截回复的 mid（'l' 项）：下面要断言"补删时连它一起收走"。**别用"屏幕上有
  // 没有 'l' 项"当判据**——主人刚说的 M3 也是本地项、id 同样是 'l' 开头（genId
  // 对用户项一样发 'l'），那条本来就该在屏幕上；判据要落到**它自己那个 mid**上。
  // （也别按 `mtype==='agent'` 找：那个 dataset 只有用户气泡在写。）
  const partialEl = midEls().find(el => el.classList.contains('agent')
    && String(el.dataset.mid || '').startsWith('l'));
  const orphanMid = partialEl ? partialEl.dataset.mid : '';
  assert(!!orphanMid, '停下后那条半截回复有了自己的 mid（下面靠它验"一并收走"）', midEls().map(e => e.dataset.mid));
  assert(marker().kind === 'stopped', '第二条打断同样记 stopped', marker());
  assert(discardCalls.length === 1, '停下时仍然不发 discard', discardCalls.length);

  nextMode = 'ignore';   // 这一条连同它的停止一起走场景 5 那条腿
  say(M3);
  await waitFor(() => streamCalls === 3 && userBubbles(M3).length === 1);
  const lastTwo = seq.slice(-2);
  assert(lastTwo.length === 2 && lastTwo[0][0] === 'discard' && lastTwo[0][1] === M2, '补删发的是被打断那条的原文', lastTwo);
  assert(lastTwo[1][0] === 'stream' && lastTwo[1][1] === M3, '**新消息随后才发出去**（顺序反了就会删掉刚发的那条）', lastTwo);
  assert(userBubbles(M2).length === 0, '被打断的那条此刻才从屏幕上消失', midEls().map(e => e.dataset.mtext));
  assert(!midEls().some(el => el.dataset.mid === orphanMid), '它的半截回复也一并收走（不留在新消息旁边当孤儿）', midEls().map(e => e.dataset.mid));
  assert(!DB.some(r => r.content === M2), 'DB 里那条也真删了（不是只抹屏幕）', DB.map(r => r.content));
  assert(!marker(), '标记一并清掉', marker());
  assert(failedNotes().length === 0, '提示条也收走（别在下一轮回复期间还挂着上一条的话）', failedText());
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
  assert(btnsIn(msgsRoot()).length === 2, '重发/编辑同样挂上', btnsIn(msgsRoot()).map(b => b.textContent));
}

assert(unhandled.length === 0, '无未捕获异常', unhandled.slice(0, 2));

function streamingCount() {
  return msgsRoot() ? msgsRoot().querySelectorAll('.msg-streaming').length : 0;
}

console.log('\n' + (failed === 0 ? '✅ 主动打断保留套件通过' : '❌ 主动打断保留套件失败') + `：${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
