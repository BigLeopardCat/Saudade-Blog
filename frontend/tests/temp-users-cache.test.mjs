// ═ 后台账号列表内存缓存回归（20261002）══
//   node tests/temp-users-cache.test.mjs
//
// 背景（用户报的）：「后台管理的用户管理是不是每次点都重新拉数据」——这一页原来在挂载时
// `setTimeout(loadTempUsers, 500)` 拉一次，切走再切回来又是同一套"先空一下再填上"，
// 而两次的数据几乎一模一样。现在列表本体住 `src/pages/Dashboard/Users/tempUsers.ts`
// 这一个 module 级 store，本套件锁它的行为：
//   · 谁在拉、什么时候拉（0 个消费者一次请求都不发；事件驱动只在有人看时才拉）
//   · 消费者登记时发一次刷新 → **切回页签首帧就是缓存值**（`useTempUsers` 的初值取模块级
//     `list`，所以这里断言 store 的 list 在登记后**当场**就非空，而不是等一个往返）
//   · 写成功之后 `invalidateTempUsers()`：**作废在途读数**（竞态：点了冻结、恰好一个 20 秒前
//     的读数晚到——不丢旧读数就会把界面翻回旧状态）且**只发一次**新请求（事件与直接调用去重）
//   · 读不到 ≠ 空（失败不清空 list，只标记 failed）
//   · **裸数组**契约：这一页的接口回的是数组本身，不是 `{code,message,data}` 那层壳
//     （判据写错成 `res.data.data` 会恒空，而 axios 不报错、页面不红）
//
// tempUsers.ts 是 TS 且 import 了 axios 单例：本机不能 vite build（3.7GB 内存，见 CLAUDE.md §2），
// 用 esbuild JS API 把 axios 换成受测可控的假后端。假后端可以**挂起**（`ctl.pending`）——
// 竞态那条腿必须能把"写入之前发出的那份读数"按在手里。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'tucache-'));

const file = path.join(out, 'tempUsers.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/pages/Dashboard/Users/tempUsers.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
    plugins: [{
        name: 'fake-http',
        setup(build) {
            build.onResolve({ filter: /axios\.tsx$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
            build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
                loader: 'js',
                contents: `
                    const http = {
                        get(url) {
                            const ctl = globalThis.__tuCtl;
                            ctl.calls.push({ url, method: 'GET' });
                            return Promise.resolve().then(() => ctl.respond({ url, method: 'GET' }));
                        },
                        // 本 store 只读；写操作由页面自己发（缓存只在写成功后作废重拉），
                        // 这里放一个会炸的实现，免得将来悄悄多出写路径而测试看不出来
                        post() { throw new Error('tempUsers.ts 不该发写请求（写操作在页面里）'); },
                    };
                    export default http;
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
globalThis.window = Object.assign(fakeEventTarget(winEvents), {
    // store 用 CustomEvent 派发"列表变了"，而页面里订阅的也是它；假环境给一个最小实现，
    // 让"派发 → 监听器 → 再拉一次"这条真实链路能在测试里跑起来（不是直接调函数绕开它）
    dispatchEvent(ev) { winEvents[ev.type] = winEvents[ev.type] || []; (winEvents[ev.type] || []).forEach((fn) => fn(ev)); return true },
});
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type } };
globalThis.document = Object.assign(fakeEventTarget(docEvents), { hidden: false });
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
};
const TOKEN = 'x.y.z';

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
/** 让微任务/定时器队列跑空（假后端是 Promise 形态，没有真实 IO 要等） */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 与 `/api/temp-users` 的真实回包同形：**裸数组**（src/routes/temp_user.rs::list_temp_users） */
const ROWS = [
    { id: 2, username: 'sora', role: 'admin', status: 0, chatQuotaUsed: 3, chatQuotaLimit: 0 },
    { id: 7, username: 'guest', role: 'user', status: 0, chatQuotaUsed: 12, chatQuotaLimit: 500 },
];

let boot = 0;
/** 每个场景一份全新的模块实例（store 是模块级状态，跨场景会互相污染）。
 *
 *  **事件袋必须一起清空**：模块在加载时往 `winEvents`/`docEvents` 里挂监听（见 tempUsers.ts
 * 头注"挂一次"那段），而 `fresh()` 会再 import 一份新实例——旧实例的监听器不会自己摘掉，
 * 于是同一个 agent-turn-done 会打到**所有历史模块**上，它们各自按自己的 active 计数发请求，
 * 落到 `globalThis.__tuCtl`（永远是当前场景那个）。结果是当前场景凭空多出几次调用。
 * 就地清空键（闭包持有的是同一个对象，不能整个替换）＝只留本次 import 挂上的那些。 */
async function fresh() {
    for (const bag of [winEvents, docEvents]) {
        for (const k of Object.keys(bag)) delete bag[k];
    }
    const ctl = {
        calls: [],
        pending: [],
        responder: () => ({ status: 200, data: ROWS }),
        respond(cfg) { return this.responder(cfg) },
    };
    globalThis.__tuCtl = ctl;
    const mod = await import(pathToFileURL(file).href + '?boot=' + (++boot));
    return { mod, ctl };
}
/** 挂起式假后端：返回的每个请求都要测试自己 resolve（竞态那条腿用） */
const hang = (ctl) => { ctl.pending = []; ctl.responder = () => new Promise((r) => ctl.pending.push(r)) };
const answer = () => ({ status: 200, data: ROWS });
const calls = (ctl) => ctl.calls.length;
const ids = (mod) => (mod.tempUsersDebug().list || []).map((u) => u.id);
const login = () => { store.tokenKey = TOKEN };
const logout = () => { delete store.tokenKey };

// ── ① 谁在拉、什么时候拉 ────────────────────────────────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    await mod.refreshTempUsers();
    eq(calls(ctl), 0, '没有消费者（没人在看账号列表）时一次请求都不发');

    mod.retainTempUsers();
    mod.retainTempUsers();
    await tick();
    eq(calls(ctl), 1, '两个消费者同时要看 → **共用同一个在途请求**（不打两次）');
    eq(mod.tempUsersDebug().active, 2, '活着的消费者数 = 2');

    winEvents['temp-users-change'].forEach((f) => f({ type: 'temp-users-change' }));
    await tick();
    eq(calls(ctl), 2, 'temp-users-change（本站自己改完）→ 对齐一次');

    winEvents['agent-turn-done'].forEach((f) => f({ type: 'agent-turn-done' }));
    await tick();
    eq(calls(ctl), 3, 'agent-turn-done（看板娘一轮收尾）→ 对齐一次（刚冻结/改过账号）');

    document.hidden = true;
    docEvents['visibilitychange'].forEach((f) => f({ type: 'visibilitychange' }));
    await tick();
    eq(calls(ctl), 3, '切到后台（hidden）不拉');
    document.hidden = false;
    docEvents['visibilitychange'].forEach((f) => f({ type: 'visibilitychange' }));
    await tick();
    eq(calls(ctl), 4, '切回前台补一次（后台标签页里事件会被降频）');

    const stop = mod.retainTempUsers();
    stop();
    mod.tempUsersDebug().active === 2;   // 记下：此刻仍有 2 个消费者
    winEvents['agent-turn-done'].forEach((f) => f({ type: 'agent-turn-done' }));
    await tick();
    eq(calls(ctl), 5, '还有人在看 → 事件照常触发');
    eq(mod.tempUsersDebug().active, 2, '登记/撤销成对，计数回到 2（不会因为一次撤销就误判成没人看）');
}

// ── ② 没人看了：计数归零 → 事件不再发请求（白花流量）────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    const r1 = mod.retainTempUsers();
    const r2 = mod.retainTempUsers();
    await tick();
    eq(calls(ctl), 1, '两个消费者 → 一次请求');
    r1(); r2();
    eq(mod.tempUsersDebug().active, 0, '消费者全走了 → 计数归零（不会掉到负数）');
    winEvents['agent-turn-done'].forEach((f) => f({ type: 'agent-turn-done' }));
    await tick();
    eq(calls(ctl), 1, '没人看账号列表时再来事件也不拉');
}

// ── ③ 切回页签：**首帧就是缓存值**（这正是"每次点都重新拉"要修的那件事）──────
{
    const { mod, ctl } = await fresh();
    login();
    const stop1 = mod.retainTempUsers();
    await tick();
    eq(ids(mod), [2, 7], '第一次进页签：读到 2 个账号');
    stop1();
    eq(mod.tempUsersDebug().active, 0, '离开页签（切走）→ 消费计数归零');

    // 切走期间列表**不被清空**——这正是"回来即显示"的前提
    eq(ids(mod), [2, 7], '切走之后缓存还在（不是 null、不是空数组）');

    // 切回来：登记的那一刻就发一次静默刷新，但**首帧值已经是缓存**
    const before = calls(ctl);
    const stop2 = mod.retainTempUsers();
    eq(ids(mod), [2, 7], '切回页签：**登记当场**就有数据可渲染（没有 500ms 空窗）');
    await tick();
    eq(calls(ctl), before + 1, '登记时后台静默刷新一次');
    stop2();
}

// ── ④ 写成功后的作废：在途旧读数不许把界面翻回去，且只发一次新请求 ───────────
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainTempUsers();
    await tick();
    eq(ids(mod), [2, 7], '全量读数到手');

    hang(ctl);
    mod.refreshTempUsers();
    await tick();
    eq(ctl.pending.length, 1, '又发了一次对齐（在途，未回）');

    mod.invalidateTempUsers();
    await tick();
    eq(ctl.pending.length, 2, '作废之后另发一次：在途那份作废，**不复用**');
    eq(calls(ctl), 3, '总数 = 首次 + 在途那次 + 作废后这次（事件与直接调用**去重成一次**）');

    // 在途的那份是**写入之前**的快照（7 还没被冻结/还是旧的样子）：它回来时不许覆盖新读数
    ctl.pending[0](answer());
    await tick();
    eq(ids(mod), [2, 7], '在途旧读数被丢弃（不把界面翻回旧状态）');
    eq(ctl.pending.length, 2, '丢弃旧读数**不会**顺带再发一次请求');

    // 写之后发出的那份（服务端真相：7 已经被删掉了）
    ctl.pending[1]({ status: 200, data: ROWS.filter((r) => r.id !== 7) });
    await tick();
    eq(ids(mod), [2], '新读数落地后列表剩 1 条');
    eq(mod.tempUsersDebug().failed, false, '成功读数不该被标成"没读到"');
}

// ── ⑤ 读不到 ≠ 空（失败清空会让账号列表空一屏，比"旧数据"糟得多）────────────
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainTempUsers();
    await tick();
    eq(ids(mod).length, 2, '先成功读到 2 条');

    ctl.responder = () => ({ status: 200, data: { code: 500, message: '未登录' } });
    await mod.refreshTempUsers();
    eq(ids(mod).length, 2, '**非数组回包**（错误信封）不清空已有列表');
    eq(mod.tempUsersDebug().failed, true, '但记住"这次没读到"（界面据此显示「读取失败」而非「暂无账号」）');

    ctl.responder = () => { throw new Error('network down') };
    await mod.refreshTempUsers();
    eq(ids(mod).length, 2, '网络异常同样不清空');
    eq(mod.tempUsersDebug().failed, true, '网络异常也叫"没读到"');

    ctl.responder = () => answer();
    await mod.refreshTempUsers();
    eq(mod.tempUsersDebug().failed, false, '下一次读成功 → failed 复位');

    // 未登录是**另一件事**：那不是"没读到"，是这台机器上看不到账号列表 ⇒ 清空且 failed 复位
    logout();
    await mod.refreshTempUsers();
    eq(mod.tempUsersDebug().list, null, '未登录 → 清空（此时确实没有列表可言）');
    eq(mod.tempUsersDebug().failed, false, '未登录不算"读失败"');
}

// ── ⑥ 每次成功读数都换**新数组实例**（否则界面静默停在旧条数）───────────────
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainTempUsers();
    await tick();
    ok(mod.tempUsersDebug().list !== ROWS, '落库的列表不是接口交回来的那个数组实例（拷贝过一层）');
    await mod.refreshTempUsers();
    const a = mod.tempUsersDebug().list;
    await mod.refreshTempUsers();
    ok(mod.tempUsersDebug().list !== a, '两次成功读数拿到的是两个不同实例（订阅者才会被判为变化）');
    ROWS.push({ id: 99, username: '外部就地改的' });
    eq(ids(mod), [2, 7], '外部就地改那个数组**不影响** store（不是共用同一份内存）');
    ROWS.pop();
    void ctl;
}

// ── ⑦ 源码契约（这些引用点改一处、忘一处就会静默失效）─────────────────────
{
    const page = readFileSync(path.join(root, 'src/pages/Dashboard/Users/index.tsx'), 'utf8');
    const store = readFileSync(path.join(root, 'src/pages/Dashboard/Users/tempUsers.ts'), 'utf8');
    // 断言"代码里没有 X"时必须先剥注释：这两个文件的头注里**刻意**写着旧实现的样子
    // （"原来这里 `setTimeout(loadTempUsers, 500)`"、"别顺手写成 `res.data.data`"），
    // 那是给后来人看的护栏，不是残留代码。不剥就会把护栏本身判成违规。
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const pageCode = strip(page), storeCode = strip(store);

    ok(!pageCode.includes('loadTempUsers'),
        '页面里不再有自己那份 loadTempUsers（列表本体只有 store 一份）');
    ok(!/setTimeout\(/.test(pageCode),
        '那个 500ms 空窗的 setTimeout 已删除（它就是"每次点都重新拉"的观感来源）');
    ok(/useLiveRefresh\(\(\)\s*=>\s*refreshTempUsers\(\)/.test(page),
        '轮询接的是 store 的 refreshTempUsers（轮询不拥有数据，只是叫醒它）');
    ok(page.includes('useTempUsers(tab === \'accounts\')'),
        'enabled 跟着页签走（不在账号页签时消费计数归零 → 一次请求都不发）');

    // 五个写入口成功之后必须**作废**（不是 refresh）：在途旧读数会把界面翻回去
    const invalidations = (page.match(/invalidateTempUsers\(\)/g) || []).length;
    ok(invalidations >= 6,
        '写成功后作废 + 手动刷新按钮 + 空态重试都走 invalidateTempUsers（实测 ' + invalidations + ' 处）');
    ok(!/loadTempUsers/.test(pageCode),
        '页面里没有残留的旧刷新调用');

    // 裸数组契约：判据是 res.data 本身
    ok(storeCode.includes('Array.isArray(res?.data)'),
        'store 判的是裸数组（res.data 本身）');
    ok(!storeCode.includes('res.data.data'),
        'store 里**没有** res.data.data（这个接口没有 {code,message,data} 那层壳，写错就恒空且不报错）');
    ok(store.includes("AGENT_TURN_DONE_EVENT"),
        '订阅看板娘收尾事件（agent 刚冻结/改过账号，不该等下一次轮询）');
}
{
    const page = readFileSync(path.join(root, 'src/pages/Dashboard/Users/index.tsx'), 'utf8');
    // 空态**三分**：缓存没到手 ≠ 账号是 0 个（把"读不到"讲成"暂无账号"是本仓反复栽过的谎）
    ok(page.includes('cachedUsers === null'), '空态判据里缓存为 null 单独成一支');
    ok(page.includes('读取失败'), '读失败有独立文案（不是「暂无账号」）');
    ok(page.includes('正在读取…'), '首次读取有独立文案');
    ok(page.includes('正在读取账号…'),
        '筛选栏那个计数也跟着三态走（缓存没到手时不写「共 0 个账号」——挂在筛选栏右边的那个数字扫一眼就是结论）');
    ok(page.includes("'暂无账号'") && page.includes("'没有匹配的账号'"),
        '缓存到手后才分「暂无账号」/「没有匹配的账号」');
}

console.log(`\ntemp-users-cache: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
