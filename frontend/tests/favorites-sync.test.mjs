// ═ 收藏状态单一真源回归（20260923 三轮）══
//   node tests/favorites-sync.test.mjs
//
// 背景（用户报的）：详情页那颗★与个人中心「收藏的文章」列表各拉各的、各存各的 state，
// 一处改了另一处永远不变（组件常挂载 + `xxx === null` 门控 ⇒ 一次页面生命周期里只拉一次）。
// 现在两份显示共用 src/components/UserCenter/favorites.ts 这一个 store，本套件锁它的行为：
//   · 谁在拉、什么时候拉（0 个消费者一次请求都不发；事件驱动只在有人看时才拉）
//   · 写成功之后的即时结果（取消收藏当场摘行）与**在途读数的作废**（竞态：进页面即拉、
//     用户趁没回来就点掉收藏——不丢旧读数就会把刚点掉的★又点亮）
//   · 读不到 ≠ 空（失败不清空 list，只标记 failed）
//   · chat-stream.js 派发的 'agent-turn-done' 与 store 订阅的常量同名（跨文件契约）
//
// favorites.ts 是 TS 且 import 了 axios 单例：本机不能 vite build（3.7GB 内存，见 CLAUDE.md §2），
// 用 esbuild JS API 把 axios 换成受测可控的假后端（其余依赖都是纯 TS，不需要 stub）。
// 假后端可以**挂起**（`ctl.pending`）——竞态那条腿必须能把"写入之前发出的那份读数"按在手里。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'favsync-'));

const file = path.join(out, 'favorites.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/components/UserCenter/favorites.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
    plugins: [{
        name: 'fake-http',
        setup(build) {
            build.onResolve({ filter: /axios\.tsx$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
            build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
                loader: 'js',
                contents: `
                    export default function http(cfg) {
                        const ctl = globalThis.__favCtl;
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
const TOKEN = 'x.y.z';

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
/** 让微任务/定时器队列跑空（假后端是 Promise 形态，没有真实 IO 要等） */
const tick = () => new Promise((r) => setTimeout(r, 0));

const ROWS = [
    { noteId: 12, title: '架构文档', status: 'published', createdAt: '2026-09-20 10:00:00' },
    { noteId: 22, title: 'ESP32 固件', status: 'published', createdAt: '2026-09-19 09:30:00' },
];

let boot = 0;
/** 每个场景一份全新的模块实例（store 是模块级状态，跨场景会互相污染） */
async function fresh() {
    const ctl = {
        calls: [],
        pending: [],
        /** 默认：立刻回全量收藏（两个场景各自替换） */
        responder: () => ({ status: 200, data: { code: 200, data: ROWS } }),
        respond(cfg) { return this.responder(cfg) },
    };
    globalThis.__favCtl = ctl;
    const mod = await import(pathToFileURL(file).href + '?boot=' + (++boot));
    return { mod, ctl };
}
/** 挂起式假后端：返回的每个请求都要测试自己 resolve（竞态那条腿用） */
const hang = (ctl) => { ctl.pending = []; ctl.responder = () => new Promise((r) => ctl.pending.push(r)) };
const answer = () => ({ status: 200, data: { code: 200, data: ROWS } });
const getCalls = (ctl) => ctl.calls.filter((c) => !c.method || c.method === 'GET');
const ids = (mod) => (mod.favoritesDebug().list || []).map((f) => f.noteId);
const login = () => { store.tokenKey = TOKEN };
const logout = () => { delete store.tokenKey };

// ── ① 谁在拉、什么时候拉 ────────────────────────────────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    await mod.refreshFavorites();
    eq(getCalls(ctl).length, 0, '没有消费者（没人在看收藏）时一次请求都不发');

    // 两个消费者在同一个 commit 里登记（详情页 + 个人中心同时挂载的样子）
    const r1 = mod.retainFavorites();
    const r2 = mod.retainFavorites();
    await tick();
    eq(getCalls(ctl).length, 1, '两个消费者同时要看 → **共用同一个在途请求**（不打两次）');
    eq(mod.favoritesDebug().active, 2, '活着的消费者数 = 2');

    winEvents['favorites-change'].forEach((f) => f({ type: 'favorites-change' }));
    await tick();
    eq(getCalls(ctl).length, 2, 'favorites-change（本站自己改完）→ 对齐一次');

    winEvents['agent-turn-done'].forEach((f) => f({ type: 'agent-turn-done' }));
    await tick();
    eq(getCalls(ctl).length, 3, 'agent-turn-done（看板娘一轮收尾）→ 对齐一次（agent 可能刚写过收藏）');

    document.hidden = true;
    docEvents['visibilitychange'].forEach((f) => f({ type: 'visibilitychange' }));
    await tick();
    eq(getCalls(ctl).length, 3, '切到后台（hidden）不拉');
    document.hidden = false;
    docEvents['visibilitychange'].forEach((f) => f({ type: 'visibilitychange' }));
    await tick();
    eq(getCalls(ctl).length, 4, '切回前台补一次（后台标签页里事件会被降频）');

    r1(); r2();
    eq(mod.favoritesDebug().active, 0, '消费者全走了 → 计数归零（不会掉到负数）');
    winEvents['agent-turn-done'].forEach((f) => f({ type: 'agent-turn-done' }));
    await tick();
    eq(getCalls(ctl).length, 4, '没人看收藏时再来事件也不拉（白花流量）');
}

// ── ② 未登录：不发请求，也不当成"没有收藏" ─────────────────────────────────
{
    const { mod, ctl } = await fresh();
    logout();
    mod.retainFavorites();
    await tick();
    eq(getCalls(ctl).length, 0, '未登录（无 token）→ 一个请求都不发');
    eq(mod.hasFavorite(12), false, '未登录时 hasFavorite = false（按钮显示「收藏」）');
    eq(mod.favoritesDebug().list, null, '未登录时 store 里没有列表可言（不是"空列表"）');
}

// ── ③ 写成功后的即时结果 + 在途读数作废（竞态）──────────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainFavorites();
    await tick();
    eq(mod.hasFavorite(22), true, '全量读数到手：22 在收藏里');

    hang(ctl);
    mod.refreshFavorites();
    await tick();
    eq(ctl.pending.length, 1, '又发了一次对齐（在途，未回）');

    mod.applyLocalFavorite(22, false);
    eq(mod.hasFavorite(22), false, '写成功后当场就是「未收藏」（不等一个往返）');
    await tick();
    eq(ctl.pending.length, 2, '写之后另发一次对齐：在途那份作废，**不复用**');
    eq(getCalls(ctl).length, 3, '总数 = 首次 + 在途那次 + 写之后这次');

    // 在途的那份是**写入之前**的快照（22 还在里面）：它回来时不许把刚点掉的★又点亮
    ctl.pending[0](answer());
    await tick();
    eq(mod.hasFavorite(22), false, '在途旧读数被丢弃：不把刚点掉的★又点亮');
    eq(ids(mod), [12], '旧读数也没把列表塞回去');
    eq(ctl.pending.length, 2, '丢弃旧读数**不会**顺带再发一次请求');

    // 写之后发出的那份（服务端真相：22 已经不在收藏里）
    ctl.pending[1]({ status: 200, data: { code: 200, data: ROWS.filter((r) => r.noteId !== 22) } });
    await tick();
    eq(ids(mod), [12], '新读数落地后列表仍是 1 条');
    eq(mod.hasFavorite(22), false, '仍是未收藏');
    eq(mod.favoritesDebug().failed, false, '成功读数不该被标成"没读到"');
}

// ── ④ 写成功后的列表对齐（取消收藏当场摘行 / 新增不塞空行）─────────────────
{
    const { mod } = await fresh();
    login();
    mod.retainFavorites();
    await tick();
    mod.applyLocalFavorite(22, false);
    eq(ids(mod), [12], '取消收藏 → 列表当场摘掉那一行');
    eq(mod.hasFavorite(12), true, '别的行不受影响');
    mod.applyLocalFavorite(30, true);
    eq(ids(mod), [12], '新增不塞"没有标题的空行"（等全量拉取补上）');
    eq(mod.hasFavorite(30), true, '但★当场就是已收藏');
}

// ── ⑤ 读不到 ≠ 空 ──────────────────────────────────────────────────────────
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainFavorites();
    await tick();
    eq(ids(mod).length, 2, '先成功读到 2 条');

    ctl.responder = () => ({ status: 200, data: { code: 500, message: '未登录' } });
    await mod.refreshFavorites();
    eq(ids(mod).length, 2, '失败**不清空**已有列表（清空会让你以为收藏没了）');
    eq(mod.favoritesDebug().failed, true, '但记住"这次没读到"（界面据此显示「没读到」而非「还没有收藏」）');

    ctl.responder = () => { throw new Error('network down') };
    await mod.refreshFavorites();
    eq(ids(mod).length, 2, '网络异常同样不清空');
    eq(mod.favoritesDebug().failed, true, '网络异常也叫"没读到"');

    ctl.responder = () => answer();
    await mod.refreshFavorites();
    eq(mod.favoritesDebug().failed, false, '下一次读成功 → failed 复位');

    // 未登录是**另一件事**：那不是"没读到"，是这台机器上没有收藏可言 ⇒ 清空且 failed 复位
    logout();
    await mod.refreshFavorites();
    eq(mod.favoritesDebug().list, null, '未登录 → 清空（此时确实没有收藏可言）');
    eq(mod.favoritesDebug().failed, false, '未登录不算"读失败"');
}

// ── ⑥ 每次成功读数都换**新数组实例**（否则界面静默停在旧条数）───────────────
// 20260923 无头沙箱抓到的：假后端把同一个 `state.favorites` 交回来两次，读侧原样存下
// ⇒ 新旧快照 `Object.is` 相等 ⇒ 订阅者的 setSnap 被 React 判为无变化、**不重渲染**：
// store 里已经是 3 条，界面上还是 2 条（列表与页签条数都不动）。真后端一次往返是新对象，
// 但"读接口交回同一个实例"完全可以由缓存/桩/就地改造成，所以拷贝是 store 的责任。
{
    const { mod, ctl } = await fresh();
    login();
    mod.retainFavorites();
    await tick();
    ok(mod.favoritesDebug().list !== ROWS, '落库的列表不是接口交回来的那个数组实例（拷贝过一层）');
    await mod.refreshFavorites();
    const a = mod.favoritesDebug().list;
    await mod.refreshFavorites();
    ok(mod.favoritesDebug().list !== a, '两次成功读数拿到的是两个不同实例（订阅者才会被判为变化）');
    ROWS.push({ noteId: 99, title: '外部就地改的', status: 'published', createdAt: '' });
    eq(ids(mod), [12, 22], '外部就地改那个数组**不影响** store（不是共用同一份内存）');
    ROWS.pop();
    void ctl;
}

// ── ⑦ 跨文件契约（这些引用点改一处、忘一处就会静默失效）───────────────────
{
    const js = readFileSync(path.join(root, 'public/live2d-widgets/chat-stream.js'), 'utf8');
    ok(js.includes("new CustomEvent('agent-turn-done')"),
        "chat-stream.js 在流收尾派发 'agent-turn-done'");
    // 20260924：订阅方从一个变成三个（收藏 / 未读红点 / 个人中心各页签）⇒ 常量搬到
    // agentTurn.ts 单一定义处，三处 import 同一个名字（改名字要三处一起改）
    const turn = readFileSync(path.join(root, 'src/components/UserCenter/agentTurn.ts'), 'utf8');
    ok(turn.includes("AGENT_TURN_DONE_EVENT = 'agent-turn-done'"),
        'agentTurn.ts 是与 chat-stream.js 同名的单一定义处');
    const src = readFileSync(path.join(root, 'src/components/UserCenter/favorites.ts'), 'utf8');
    ok(src.includes('AGENT_TURN_DONE_EVENT') && src.includes('window.addEventListener(AGENT_TURN_DONE_EVENT'),
        '收藏那份仍订阅它（走共用的常量，不再自己定义）');
    const unreadSrc = readFileSync(path.join(root, 'src/components/UserCenter/unread.ts'), 'utf8');
    ok(unreadSrc.includes('window.addEventListener(AGENT_TURN_DONE_EVENT'),
        '未读红点也订阅了（只靠 60 秒轮询 = 用户盯着看一分钟不变，等于没生效）');
    const ucSrc = readFileSync(path.join(root, 'src/components/UserCenter/index.tsx'), 'utf8');
    ok(ucSrc.includes('window.addEventListener(AGENT_TURN_DONE_EVENT')
        && ucSrc.includes("loadTab('notices', true)"),
        '个人中心各页签在收尾后重拉（force 走 loadTab，不是另写一条拉取路径）');
    ok(src.includes("FAVORITES_CHANGED_EVENT = 'favorites-change'"),
        '本地写入的广播名（unread-change 的同族）也锁一下');
    const read = readFileSync(path.join(root, 'src/frontHome/Content/ReadArticle/index.tsx'), 'utf8');
    ok(!read.includes('getFavorites(') && read.includes('useFavorites'),
        '详情页不再自己拉收藏列表（两份状态正是这轮修的洞）');
    ok(read.includes('applyLocalFavorite'), '详情页写成功后把结果交给共享状态');
    const uc = readFileSync(path.join(root, 'src/components/UserCenter/index.tsx'), 'utf8');
    ok(!uc.includes('getFavorites(') && uc.includes('useFavorites'),
        '个人中心也不再自己拉收藏列表');
    ok(uc.includes("key === 'favorites') return"),
        '收藏页签的数据由共享状态负责（loadTab 不再插手，避免两份状态）');
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
