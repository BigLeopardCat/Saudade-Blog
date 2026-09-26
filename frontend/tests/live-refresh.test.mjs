// ═ 跨端同步触发器（20260926）══
//   node tests/live-refresh.test.mjs
//
// 现场（用户报的）：后台开着评论管理页，让看板娘驳回一条留言 —— 页面不动，得刷新网页。
// 同族的毛病散在用户列表 / 文章 / 标签 / 分类 / 前台河灯，成因同一个：那些列表只在挂载时
// 拉一次，而 agent 是从服务端改的那一笔，浏览器没有任何理由知道。
//
// 本套件锁 `src/utils/liveRefresh.ts` 的**四条纪律**（挂载不拉 / 在途不叠加 / 事件与轮询
// 共用节流窗口 / skip 优先），以及消费者的生命周期（第一个出现才挂定时器、最后一个离开
// 就撤）。判据全是"发了几次请求"与"定时器在不在"，不锁任何页面文案。
//
// liveRefresh.ts 是 TS，唯一的外部依赖是 agentTurn.ts（纯常量）。先摊平成一个 .mjs 再 import
// ——本机不能 vite build（3.7GB 内存，见 CLAUDE.md §2），模块级监听又必须在 import 之前
// 装好假 window/document（同 favorites-sync.test.mjs 的姿势）。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'liverefresh-'));

const file = path.join(out, 'liveRefresh.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/liveRefresh.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
    // react 只是 `useLiveRefresh` 那层薄壳用的；本套件测的是不依赖 React 的 `retainLive`，
    // 但仍要把 import 解析掉（否则整个模块 import 不进来）。
    plugins: [{
        name: 'stub-react',
        setup(build) {
            build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                loader: 'js',
                contents: 'export function useEffect(){} export function useRef(v){return {current:v}}',
            }));
        },
    }],
});

// ── 假浏览器 + 可控定时器（模块加载时就挂 window/document 监听，必须先装好再 import）──
const winEvents = {}, docEvents = {};
function fakeEventTarget(bag) {
    return {
        addEventListener(type, fn) { (bag[type] = bag[type] || []).push(fn) },
        removeEventListener(type, fn) { bag[type] = (bag[type] || []).filter((f) => f !== fn) },
        fire(type) { (bag[type] || []).forEach((fn) => fn({ type })) },
    };
}
globalThis.window = fakeEventTarget(winEvents);
globalThis.document = Object.assign(fakeEventTarget(docEvents), { hidden: false });

/** 可控定时器：把 setInterval 的回调收在手里，测试自己决定"过了 20 秒" */
let intervals = [];
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { const id = { fn, ms, cleared: false }; intervals.push(id); return id; };
globalThis.clearInterval = (id) => { if (id && typeof id === 'object') id.cleared = true; else realClearInterval(id); };
const tickTimers = () => { intervals.filter((i) => !i.cleared).forEach((i) => i.fn()) };
const liveTimers = () => intervals.filter((i) => !i.cleared);

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
const tick = () => new Promise((r) => setTimeout(r, 0));
/** 时间冻结在测试手里：`Date.now()` 被节流窗口用着，`await tick()` 会真的走真实时间 */
let nowMs = 1_000_000;
const realNow = Date.now;
Date.now = () => nowMs;
const advance = (ms) => { nowMs += ms; };
const fireWin = (t) => (winEvents[t] || []).forEach((f) => f({ type: t }));
const fireDoc = (t) => (docEvents[t] || []).forEach((f) => f({ type: t }));

let boot = 0;
/** 每个场景一份全新的模块实例（consumers/timer 都是模块级状态，跨场景会互相污染） */
async function fresh() {
    intervals = [];
    const mod = await import(pathToFileURL(file).href + '?boot=' + (++boot));
    return mod;
}
/** 计数式 reload：同步 + 异步两种形态都要能测 */
const counter = () => {
    const c = { n: 0, hang: false, pending: [] };
    c.fn = () => {
        c.n += 1;
        if (!c.hang) return undefined;
        return new Promise((r) => c.pending.push(r));
    };
    return c;
};

console.log('\n① 挂载不拉、事件才拉（挂载期加载是调用方自己的事）');
{
    const mod = await fresh();
    const c = counter();
    const off = mod.retainLive(c.fn);
    eq(c.n, 0, '登记消费者本身**不发请求**（调用方挂载时已经拉过一次了）');
    fireWin('agent-turn-done');
    eq(c.n, 1, 'agent-turn-done（看板娘一轮收尾）→ 拉一次');

    advance(5000);
    fireWin('focus');
    eq(c.n, 2, 'focus → 拉一次（可见性与焦点不是一回事）');
    advance(5000);
    document.hidden = true;
    fireDoc('visibilitychange');
    eq(c.n, 2, '切到后台（hidden）不拉');
    document.hidden = false;
    fireDoc('visibilitychange');
    eq(c.n, 3, '切回可见 → 立刻补一次（后台标签页里定时器被降频）');
    off();
}

console.log('\n② 事件与轮询**共用**一个节流窗口（挨在一起的三件事只该变成一次）');
{
    const mod = await fresh();
    const c = counter();
    const off = mod.retainLive(c.fn);
    fireWin('agent-turn-done');
    fireWin('focus');
    fireDoc('visibilitychange');
    eq(c.n, 1, '同一毫秒里到齐的三个事件 → 只有一次请求');
    advance(mod.MIN_GAP_MS);
    fireWin('focus');
    eq(c.n, 2, `过了 MIN_GAP_MS（${mod.MIN_GAP_MS}ms）→ 允许下一次`);
    off();
}

console.log('\n③ 在途不叠加（异步 reload 没回来之前不发起第二次）');
{
    const mod = await fresh();
    const c = counter();
    c.hang = true;
    const off = mod.retainLive(c.fn);
    fireWin('agent-turn-done');
    eq(c.n, 1, '第一次发出去');
    advance(60_000);
    fireWin('focus');
    tickTimers();
    eq(c.n, 1, '在途期间：事件与轮询都**不**叠加成第二次');
    c.pending.forEach((r) => r());          // 放行在途请求
    await tick();
    advance(60_000);
    fireWin('focus');
    eq(c.n, 2, '在途结束之后才允许下一次');
    off();
}

console.log('\n④ skip() 优先：本地正在编辑时一次都不拉');
{
    const mod = await fresh();
    const c = counter();
    let editing = true;
    const off = mod.retainLive(c.fn, { skip: () => editing });
    fireWin('agent-turn-done');
    tickTimers();
    eq(c.n, 0, '弹窗开着（skip 真）→ 事件与轮询都不拉（绝不覆盖主人正在编辑的东西）');
    editing = false;
    fireWin('focus');
    eq(c.n, 1, '关掉弹窗后下一次事件**立刻**生效（skip 不吃掉节流窗口）');
    off();
}

console.log('\n⑤ 定时器生命周期：第一个消费者挂、最后一个撤');
{
    const mod = await fresh();
    const c = counter();
    const off1 = mod.retainLive(c.fn, { pollMs: 5000 });
    eq(liveTimers().length, 1, '第一个消费者 → 挂上定时器');
    eq(liveTimers()[0].ms, 5000, '  间隔取的是消费者给的那个值');
    const off2 = mod.retainLive(c.fn);
    eq(liveTimers().length, 1, '第二个消费者 → **共用**同一个定时器（不各挂一个）');
    eq(mod.liveRefreshDebug().consumers, 2, '消费者计数 = 2');

    advance(60_000);
    tickTimers();
    eq(c.n, 2, '定时器醒来 → 每个消费者各拉一次（各有各的数据）');

    off1();
    eq(liveTimers().length, 1, '还剩一个消费者 → 定时器留着');
    advance(60_000);
    tickTimers();
    eq(c.n, 3, '剩下的那个照常被叫醒');
    off2();
    eq(liveTimers().length, 0, '最后一个消费者离开 → 撤掉定时器（没人在看的页面不轮询）');
    eq(mod.liveRefreshDebug().consumers, 0, '消费者计数回到 0');
    advance(60_000);
    tickTimers();
    eq(c.n, 3, '撤掉之后不再有任何请求');
    fireWin('agent-turn-done');
    eq(c.n, 3, '没有消费者时事件也不做事');
}

console.log('\n⑥ poll:false（访客页面）只吃事件，绝不轮询');
{
    const mod = await fresh();
    const c = counter();
    const off = mod.retainLive(c.fn, { poll: false });
    eq(liveTimers().length, 0, 'poll:false → 一个定时器都不挂');
    fireWin('agent-turn-done');
    eq(c.n, 1, '但事件照拉（agent 改过之后访客页面也该跟上）');
    const off2 = mod.retainLive(c.fn);        // 混一个要轮询的消费者
    eq(liveTimers().length, 1, '再进来一个要轮询的页面 → 定时器才挂上');
    advance(60_000);
    tickTimers();
    eq(c.n, 2, '  叫醒时**只**叫要轮询的那部分（访客页面不被轮询叫醒）',
        { n: c.n });
    off(); off2();
    eq(liveTimers().length, 0, '都走了 → 定时器撤掉');
}

console.log('\n⑦ 卸载即撤：注销之后再来的事件不落在已卸载的组件上');
{
    const mod = await fresh();
    const c = counter();
    const off = mod.retainLive(c.fn);
    fireWin('agent-turn-done');
    eq(c.n, 1, '卸载前正常');
    off();
    advance(60_000);
    fireWin('agent-turn-done');
    fireDoc('visibilitychange');
    tickTimers();
    eq(c.n, 1, '注销之后一次都不再拉（否则 setState 落在已卸载的组件上）');
}

console.log('\n⑧ 跨文件契约：事件名与 chat-stream.js 派发的那个常量同名');
{
    const src = readFileSync(path.join(root, 'src/components/UserCenter/agentTurn.ts'), 'utf8');
    const m = src.match(/AGENT_TURN_DONE_EVENT\s*=\s*'([^']+)'/);
    eq(m && m[1], 'agent-turn-done', '常量值仍是 agent-turn-done');
    const chat = readFileSync(path.join(root, 'public/live2d-widgets/chat-stream.js'), 'utf8');
    ok(chat.includes('agent-turn-done'), 'chat-stream.js 里确实派发它（改名字要三处一起改）');
    const mod = await fresh();
    fireWin('agent-turn-done');
    ok(mod.liveRefreshDebug().consumers === 0, '（本场景只为读常量，无消费者）');
}

Date.now = realNow;
globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}（通过 ${passed}）`);
process.exit(failed === 0 ? 0 : 1);
