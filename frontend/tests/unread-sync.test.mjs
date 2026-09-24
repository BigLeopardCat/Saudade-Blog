// ═ 未读红点单一真源回归（20260924 四轮）══
//   node tests/unread-sync.test.mjs
//
// 背景：红点有**两处**显示位置——头部头像（常驻）与个人中心「公告和通知」页签角标
// （开窗时）。此前 `useUnread` 是普通 hook，每个调用点各持一份 state + 各挂一个
// `setInterval` ⇒ 开着个人中心时同一张表每分钟被同一个浏览器打两次（实测：站内真轮询
// 只有两条接口、一天约 1300 次请求，99.4% 来自主人自己那一个 IP）。现在两份显示共用
// src/components/UserCenter/unread.ts 这一个 store、一个定时器、一个在途请求，本套件锁它：
//   · **全站只有一个轮询定时器**（挂几次？撤没撤？）——这是本轮改动的本体
//   · 谁在拉、什么时候拉（0 个消费者一次请求都不发；事件驱动只在有人看时才拉）
//   · 未登录/失败按 0 处理（红点是提示不是状态，读不到就不显示）
//   · 没有新事实就不换引用（EMPTY 复用）——否则订阅者会被 React 判为"变了"而白渲染
//
// unread.ts 是 TS 且 import 了 axios 单例：本机不能 vite build（3.7GB 内存，见 CLAUDE.md §2），
// 用 esbuild JS API 把 axios 换成受测可控的假后端（其余依赖都是纯 TS，不需要 stub）。
// `setInterval` 换成受测自己触发的假实现：不假的话这条套件要么真等 60 秒、要么根本
// 验不出"到底挂了一个还是两个定时器"。
import * as esbuild from 'esbuild';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'unreadsync-'));

const file = path.join(out, 'unread.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/components/UserCenter/unread.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
    plugins: [{
        name: 'fake-http',
        setup(build) {
            build.onResolve({ filter: /axios\.tsx$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
            build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
                loader: 'js',
                contents: `
                    export default function http(cfg) {
                        const ctl = globalThis.__unreadCtl;
                        ctl.calls.push({ url: cfg.url, method: cfg.method });
                        return Promise.resolve().then(() => ctl.respond(cfg));
                    }
                `,
            }));
        },
    }],
});

// ── 假浏览器（模块加载时就会挂 window/document 监听，所以必须先装好再 import）──
const store = {};
function fakeEventTarget(bag) {
    return {
        addEventListener(type, fn) { (bag[type] = bag[type] || []).push(fn) },
        removeEventListener(type, fn) { bag[type] = (bag[type] || []).filter((f) => f !== fn) },
        fire(type) { (bag[type] || []).forEach((fn) => fn({ type })) },
    };
}
const winEvents = {}, docEvents = {};
globalThis.window = fakeEventTarget(winEvents);
globalThis.document = Object.assign(fakeEventTarget(docEvents), { hidden: false });
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
};

// ── 假 setInterval：谁挂了定时器、挂了几次，测试说了算 ──────────────────────
// 只换 setInterval（不换 setTimeout——那会把下面的 `tick()` 一起换掉）。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms };
    timers.push(handle);
    return handle;
};
// 按**句柄身份**撤（真实现的语义：撤的是那次 setInterval 返回的那个东西）
globalThis.clearInterval = (handle) => {
    const i = timers.indexOf(handle);
    if (i >= 0) timers.splice(i, 1);
};
let timers = [];
/** 触发一次轮询（真跑 60 秒是不可能的） */
const tickTimer = () => timers.forEach((t) => t.fn());

const TOKEN = 'x.y.z';
const ROWS = { notifications: 2, messages: 1, total: 3 };

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
/** 让微任务队列跑空（假后端是 Promise 形态，没有真实 IO 要等） */
const tick = () => new Promise((r) => setTimeout(r, 0));

let boot = 0;
/** 每个场景一份全新的模块实例（store 与定时器都是模块级状态，跨场景会互相污染） */
async function fresh() {
    timers = [];
    const ctl = {
        calls: [],
        responder: () => ({ status: 200, data: { code: 200, message: 'ok', data: ROWS } }),
        respond(cfg) { return this.responder(cfg) },
    };
    globalThis.__unreadCtl = ctl;
    const mod = await import(pathToFileURL(file).href + '?boot=' + (++boot));
    return { mod, ctl };
}
const gets = (ctl) => ctl.calls.filter((c) => !c.method || c.method === 'GET').length;
const login = () => { store.tokenKey = TOKEN };
const logout = () => { delete store.tokenKey };

// ── ① 全站只有一个轮询定时器（本轮的改动本体）──────────────────────────────
{
    const { mod, ctl } = await fresh();
    login();

    // 头部头像是常驻的（isLogin===1），个人中心开窗时是第二个消费者
    const head = mod.retainUnread();
    await tick();
    eq(timers.length, 1, '第一个消费者出现 → 挂上轮询定时器');
    eq(mod.unreadDebug().polling, true, 'store 自报"在轮询"');
    eq(gets(ctl), 1, '登记时立刻拉一次（红点不能等 60 秒才亮）');
    eq(mod.unreadDebug().counts, ROWS, '读数落地');

    const modal = mod.retainUnread();
    await tick();
    // ★ 这就是本轮修的东西：旧实现里每个 useUnread 各挂一个 setInterval ⇒ 这里是 2
    eq(timers.length, 1, '第二个消费者**不再**多挂一个定时器（旧实现这里 = 2）');
    eq(mod.unreadDebug().active, 2, '活着的消费者数 = 2');

    let n = gets(ctl);
    tickTimer();
    await tick();
    eq(gets(ctl), n + 1, '轮询一跳只打一次后端（旧实现：两个副本各打一次）');

    head();
    eq(timers.length, 1, '走掉一个、还有一个在看 → 定时器留着');
    modal();
    eq(timers.length, 0, '最后一个消费者走掉 → 定时器撤掉（不留空转的轮询）');
    eq(mod.unreadDebug().polling, false, 'store 自报"没在轮询"');
    eq(mod.unreadDebug().active, 0, '计数归零（不会掉到负数）');
    mod.retainUnread()(); // 登记又立刻取消
    eq(timers.length, 0, '登记再取消也不留定时器');
    eq(mod.unreadDebug().active, 0, '计数仍是 0');
}

// ── ② 谁在拉：没人在看就一次都不发 ─────────────────────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    await mod.refreshUnread();
    eq(gets(ctl), 0, '没有消费者（头部未登录 / 窗口没开）时一次请求都不发');
    eq(timers.length, 0, '没消费者时不挂轮询');

    mod.retainUnread();
    await tick();
    eq(gets(ctl), 1, '有消费者 → 发一次');

    winEvents['unread-change'].forEach((f) => f({ type: 'unread-change' }));
    await tick();
    eq(gets(ctl), 2, 'unread-change（个人中心点了"全部已读"）→ 当场重算');

    winEvents['agent-turn-done'].forEach((f) => f({ type: 'agent-turn-done' }));
    await tick();
    eq(gets(ctl), 3, 'agent-turn-done（看板娘刚标了已读）→ 当场重算，不等下一跳轮询');

    document.hidden = true;
    docEvents['visibilitychange'].forEach((f) => f({ type: 'visibilitychange' }));
    await tick();
    eq(gets(ctl), 3, '切到后台（hidden）不拉');
    document.hidden = false;
    docEvents['visibilitychange'].forEach((f) => f({ type: 'visibilitychange' }));
    await tick();
    eq(gets(ctl), 4, '切回前台补一次（后台标签页里定时器会被降频）');
}

// ── ③ 未登录：不发请求，红点按 0 处理 ──────────────────────────────────────
{
    const { mod, ctl } = await fresh();
    logout();
    mod.retainUnread();
    await tick();
    eq(gets(ctl), 0, '未登录（无 token）→ 一个请求都不发');
    eq(mod.unreadDebug().counts, { notifications: 0, messages: 0, total: 0 }, '未登录时读数是 0');
}

// ── ④ 读不到 ≠ 编一个数字（红点是提示不是状态）────────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainUnread();
    await tick();
    eq(mod.unreadDebug().counts, ROWS, '先有一次成功读数');

    // 后端那族接口"没做成"时返回 HTTP 200 + code=500 + 中文 message（见 ProfileMethods 头注）
    ctl.responder = () => ({ status: 200, data: { code: 500, message: '未登录', data: null } });
    winEvents['unread-change'].forEach((f) => f({ type: 'unread-change' }));
    await tick();
    eq(mod.unreadDebug().counts, { notifications: 0, messages: 0, total: 0 },
       'code=500 → 归零（不把上一次的数字继续挂在红点上）');

    ctl.responder = () => { throw new Error('network down') };
    winEvents['unread-change'].forEach((f) => f({ type: 'unread-change' }));
    await tick();
    eq(mod.unreadDebug().counts, { notifications: 0, messages: 0, total: 0 }, '抛异常也是 0，不是"卡住"');

    ctl.responder = () => ({ status: 200, data: { code: 200, message: 'ok', data: ROWS } });
    winEvents['unread-change'].forEach((f) => f({ type: 'unread-change' }));
    await tick();
    eq(mod.unreadDebug().counts, ROWS, '下一次轮询还能自己恢复（不是一次失败就再也不显示）');
}

// ── ⑤ 没有新事实就不换引用（否则订阅者白渲染一轮）──────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainUnread();
    await tick();
    const before = mod.unreadDebug().counts;
    winEvents['unread-change'].forEach((f) => f({ type: 'unread-change' }));
    await tick();
    eq(gets(ctl) >= 2, true, '又拉了一次（读数没变也一样要把请求发出去）');
    ok(mod.unreadDebug().counts === before,
       '读到的还是同样的数 → **同一个引用**（订阅者不会因为多渲染一轮而白跑）');
}

globalThis.setInterval = realSetInterval;

console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
