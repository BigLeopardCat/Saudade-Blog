// ═ 展示身份（头像/昵称）的跨标签页同步（20261001 用户第 5 条）══
//   node tests/identity-sync.test.mjs
//
// 现场（用户报的）：「主页右上角头像变更不及时，切换登录帐号了还显示着上次账号的头像，
// 必须刷新网页才同步」。
//
// 根因不是"没拉"，而是"**别的标签页**拉了没人听"：`useViewerProfile` 此前是普通 hook，
// 每实例一份 useState，刷新时机只有挂载 + `auth-change` + `profile-change`——后两个都是
// 挂在 `window` 上的自定义事件，**只在本 document 里跑**。用户在另一个标签页登录/退出之后，
// 本标签页唯一能知道这件事的通道是 `storage` 事件（同源 localStorage 是共享的），
// 而全仓没有任何一处听过它（`grep -rn "'storage'" src/` 曾为空）⇒ 头像停在旧账号、
// 必须刷新网页。现在身份收成 `identity.ts` 里一个 store（与 favorites/unread 同一套形态），
// 监听在模块加载时挂一次，本套件锁它的行为：
//   · **★ 别的标签页换了账号 ⇒ 当场重拉、头像当场换**（本轮改动本体）
//   · 反向对照：不挂 storage 监听（= 改动前的模块）⇒ 同一串动作下去头像纹丝不动
//   · **不许跟着自己写的那两把键一起反应**（`lastUser`/`knownUsers` 每次拉取成功都回写，
//     跟着反应会让两个标签页 ping-pong 不停）
//   · 在途读数会作废（退登/换账号之后姗姗来迟的旧回包不许把旧账号写回 `mine`）
//   · 三态不回归（未登录访客不打后端、退回本机记住的那个账号、没有记录才用默认头像）
//
// identity.ts 是 TS 且 import 了 axios 单例与 `import.meta.env`：本机不能 vite build
// （3.7GB 内存，见 CLAUDE.md §2），用 esbuild JS API 把 axios 换成受测可控的假后端、
// 把 `import.meta.env` 定义成空对象（= 两个环境变量都没配，仓库默认档）。
// `window`/`document`/`localStorage` 是**模块加载时**就被读的，必须先装好再 import；
// store 状态是模块级的，所以每个场景用 `?boot=N` 取一份全新实例。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'idsync-'));

const file = path.join(out, 'identity.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/components/UserCenter/identity.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
    // runtimeApi.ts 顶层读 `import.meta.env.VITE_HTTP_BASEURL`（vite 的编译期注入），
    // node 里没有这个对象 ⇒ 定义成空对象。必须写成合法 JSON（`({})` 会被 esbuild 拒掉）。
    define: { 'import.meta.env': '{}' },
    plugins: [{
        name: 'fake-http',
        setup(build) {
            build.onResolve({ filter: /axios\.tsx$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
            build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
                loader: 'js',
                contents: `
                    export default function http(cfg) {
                        const ctl = globalThis.__idCtl;
                        ctl.calls.push({ url: cfg.url, method: cfg.method });
                        return ctl.respond(cfg);
                    }
                `,
            }));
        },
    }],
});

// ── 假浏览器（模块加载时就会读 window/document/localStorage，所以必须先装好再 import）──
const store = {};
/** `drop` 里的那几种事件**不登记**——反向对照用（模拟"没听过 storage"的改动前模块） */
function fakeEventTarget(bag, drop = []) {
    return {
        addEventListener(type, fn) {
            if (drop.includes(type)) return;
            (bag[type] = bag[type] || []).push(fn);
        },
        removeEventListener(type, fn) { bag[type] = (bag[type] || []).filter((f) => f !== fn) },
    };
}
let winEvents = {}, docEvents = {};
function installBrowser(drop = []) {
    winEvents = {}; docEvents = {};
    globalThis.window = fakeEventTarget(winEvents, drop);
    // runtimeApi 顶层读 `window.location.port`（判"是不是 vite 开发端口"）⇒ 假的也得有
    globalThis.window.location = { port: '', protocol: 'https:', hostname: 'saudade.site' };
    globalThis.document = Object.assign(fakeEventTarget(docEvents), { hidden: false });
}
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
};
const fireWin = (type, ev) => (winEvents[type] || []).forEach((fn) => fn(ev || { type }));
const fireDoc = (type, ev) => (docEvents[type] || []).forEach((fn) => fn(ev || { type }));

const TOKEN_A = 'jwt.AAAA';
const TOKEN_B = 'jwt.BBBB';
const A = { username: 'sora', nickname: '泠月', avatar: '/uploads/a.png' };
const B = { username: 'lin', nickname: '林陌', avatar: '/uploads/b.png' };
const DEFAULT_AVATAR = '/default-avatar.png';
const prof = (u) => ({ status: 200, data: { code: 200, message: 'ok', data: u } });

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
const tick = () => new Promise((r) => setTimeout(r, 0));

let boot = 0;
/** 每个场景一份全新的模块实例 + 全新的假浏览器（store 是模块级状态，跨场景会互相污染） */
async function fresh(drop = []) {
    for (const k of Object.keys(store)) delete store[k];
    installBrowser(drop);
    const ctl = {
        calls: [],
        /** 挂起模式：在途请求按在手里，由 `release()` 放行（竞态那条腿要用） */
        hold: false,
        held: [],
        responder: () => prof(A),
        respond(cfg) {
            if (this.hold) {
                // ⚠️ 回包在**挂起的那一刻**就定下来：放行时再问 responder 的话，
                // 测试中途换过的 responder 会把早先那份回包也一起换掉（B 冒充了 A）
                const payload = this.responder(cfg);
                return new Promise((res) => { this.held.push(() => res(payload)) });
            }
            return Promise.resolve(this.responder(cfg));
        },
        release() { this.hold = false; const h = this.held; this.held = []; h.forEach((f) => f()); },
    };
    globalThis.__idCtl = ctl;
    const mod = await import(pathToFileURL(file).href + '?boot=' + (++boot));
    return { mod, ctl };
}
const login = (t) => { store.tokenKey = t };
const logout = () => { delete store.tokenKey };
const remember = (u, at = '2026-09-30 20:00:00') =>
    ({ [`saudade.lastUser`]: JSON.stringify({ ...u, at }) });

console.log('\n① 三态不许回归（未登录访客不打后端；没有记录才用默认头像）');
{
    const { mod, ctl } = await fresh();
    eq(mod.viewerDebug().profile, { avatar: DEFAULT_AVATAR, nickname: '' },
        '从没有过账号记录 → 默认头像 / 空昵称（第 ③ 态）');
    eq(mod.viewerDebug().active, 0, '  还没人看 → 0 个消费者');

    await mod.refreshViewer();
    eq(ctl.calls.length, 0, '0 个消费者时一次请求都不发');

    const release = mod.retainViewer();
    await tick();
    eq(ctl.calls.length, 0, '未登录的访客头也不打后端（展示身份不等于身份）');
    eq(mod.viewerDebug().active, 1, '登记了 1 个消费者');

    // 第 ② 态：本机记住过账号（令牌过期 / 手动退出登录，人还挂在这台机器上等输密码）
    Object.assign(store, remember(A, '2026-09-30 20:00:00'));
    fireWin('storage', { key: 'tokenKey' });
    await tick();
    eq(ctl.calls.length, 0, '退出登录也一样不请求');
    eq(mod.viewerDebug().profile, { avatar: '/uploads/a.png', nickname: '泠月' },
        '退回本机记住的那个账号（头像不跟着令牌一起失忆）');

    release();
    eq(mod.viewerDebug().active, 0, '消费者走光 → 计数归零（不掉到负数）');
    release();
    eq(mod.viewerDebug().active, 0, '重复取消也不变负');
}

console.log('\n② 登录后拉一次，拿到的是自己的资料');
{
    const { mod, ctl } = await fresh();
    login(TOKEN_A);
    ctl.responder = () => prof(A);
    const release = mod.retainViewer();
    await tick();
    eq(ctl.calls.length, 1, '挂了消费者就拉一次 /api/protected/profile');
    eq(mod.viewerDebug().profile, { avatar: '/uploads/a.png', nickname: '泠月' }, '头像 = 自己的');
    eq(JSON.parse(store['saudade.lastUser']).username, 'sora',
        '顺手把本机那份刷成最新（三态的第 ② 态靠它）');

    console.log('\n③ ★ 另一个标签页换了账号 ⇒ 本标签页当场重拉（本轮修复本体）');
    // 另一个标签页登录成了 B：那边只是把 tokenKey 写进共享的 localStorage，
    // 本标签页能收到的唯一信号就是 storage 事件
    login(TOKEN_B);
    ctl.responder = () => prof(B);
    fireWin('storage', { key: 'tokenKey', oldValue: TOKEN_A, newValue: TOKEN_B });
    await tick();
    eq(ctl.calls.length, 2, '★ storage（tokenKey 变了）⇒ 当场重拉');
    eq(mod.viewerDebug().profile, { avatar: '/uploads/b.png', nickname: '林陌' },
        '★ 头像当场跟着换 —— 此前必须刷新网页才同步');
    eq(JSON.parse(store['saudade.lastUser']).username, 'lin', '  本机那份也跟着刷成 B');
    release();
}

console.log('\n③b 反向对照：不挂 storage 监听（= 改动前那个模块）⇒ 头像纹丝不动');
{
    // `drop: ['storage']` = 模块的 addEventListener 对 storage 不登记，等价于"没听过这件事"
    const { mod, ctl } = await fresh(['storage']);
    login(TOKEN_A);
    ctl.responder = () => prof(A);
    mod.retainViewer();
    await tick();
    eq(mod.viewerDebug().profile.avatar, '/uploads/a.png', '起点：A 的头像');
    eq(ctl.calls.length, 1, '  起点：拉过一次');

    login(TOKEN_B);
    ctl.responder = () => prof(B);
    fireWin('storage', { key: 'tokenKey', oldValue: TOKEN_A, newValue: TOKEN_B });
    await tick();
    eq(ctl.calls.length, 1, '  没挂 storage 监听 ⇒ 一次都不重拉');
    eq(mod.viewerDebug().profile.avatar, '/uploads/a.png',
        '  头像仍停在 A —— 这正是用户报的「必须刷新网页」（③ 不是空断言）');
}

console.log('\n④ 防 ping-pong：本模块自己会写的那两把键，不许触发重拉');
{
    const { mod, ctl } = await fresh();
    login(TOKEN_A);
    ctl.responder = () => prof(A);
    const release = mod.retainViewer();
    await tick();
    const n = ctl.calls.length;

    // refreshViewer 每次成功都回写 lastUser（`at` 是秒级钟面，隔一秒写两次就是"值变了"）
    // ⇒ 跟着这两个键反应的话，两个标签页会互相触发、永不停
    fireWin('storage', { key: 'saudade.lastUser' });
    fireWin('storage', { key: 'saudade.knownUsers' });
    await tick();
    eq(ctl.calls.length, n, '  lastUser / knownUsers 的改动**不**触发重拉');

    fireWin('storage', { key: 'saudade.isDarkMode' });   // 别的键照拉
    await tick();
    eq(ctl.calls.length, n + 1, '  其余键的改动照常重拉一次');
    fireWin('storage', { key: null });                    // localStorage.clear()
    await tick();
    eq(ctl.calls.length, n + 2, '  clear()（key=null）也算一次改动');
    release();
}

console.log('\n⑤ 回到本标签页时补一次（visibilitychange）');
{
    const { mod, ctl } = await fresh();
    login(TOKEN_A);
    ctl.responder = () => prof(A);
    const release = mod.retainViewer();
    await tick();
    const n = ctl.calls.length;

    document.hidden = true;
    fireDoc('visibilitychange');
    await tick();
    eq(ctl.calls.length, n, '切到后台不拉');
    document.hidden = false;
    fireDoc('visibilitychange');
    await tick();
    eq(ctl.calls.length, n + 1, '切回来补一次（也顺带补上"别处改了昵称"这种令牌没变的改动）');
    release();
    const n2 = ctl.calls.length;
    fireDoc('visibilitychange');
    await tick();
    eq(ctl.calls.length, n2, '没有消费者时切回来也不拉（0 消费者 = 一次请求都不发）');
}

console.log('\n⑥ 在途读数作废：退登/换账号之后，姗姗来迟的旧回包不许把旧账号写回去');
{
    const { mod, ctl } = await fresh();
    login(TOKEN_A);
    ctl.responder = () => prof(A);
    const release = mod.retainViewer();
    await tick();
    eq(ctl.calls.length, 1, '起点：拉过一次');

    ctl.hold = true;                                   // 慢网络：这一次按在手里
    fireWin('storage', { key: 'saudade.isDarkMode' });
    await tick();
    eq(ctl.calls.length, 2, '第二次拉取已在途（还没回来）');

    logout();                                          // 另一个标签页退出登录
    fireWin('storage', { key: 'tokenKey' });
    await tick();
    login(TOKEN_B);                                    // 旋即登录成 B
    ctl.responder = () => prof(B);
    fireWin('storage', { key: 'tokenKey' });
    await tick();
    eq(ctl.calls.length, 3, '★ 换账号后**必须重新拉**（不许复用退登前那次在途请求）');

    ctl.release();                                     // A 的回包姗姗来迟（挂起时就定稿了）
    await tick();
    eq(mod.viewerDebug().profile, { avatar: '/uploads/b.png', nickname: '林陌' },
        '★ 晚到的 A 回包被作废：`mine` 仍是 B（否则头像闪回旧账号）');
    release();
}

console.log('\n⑦ 同一刻 storage 与 visibility 一起到 → 只发一个请求（在途去重）');
{
    const { mod, ctl } = await fresh();
    login(TOKEN_A);
    ctl.responder = () => prof(A);
    const release = mod.retainViewer();
    await tick();
    const n = ctl.calls.length;

    ctl.hold = true;
    fireWin('storage', { key: 'saudade.isDarkMode' });
    fireDoc('visibilitychange');
    await tick();
    eq(ctl.calls.length, n + 1, '两个事件落在同一刻 ⇒ 复用同一个在途请求');
    ctl.release();
    await tick();
    release();
}

console.log('\n⑧ 源码契约：修复真的落在 identity.ts，四个调用点仍只认这一个入口');
{
    const src = readFileSync(path.join(root, 'src/components/UserCenter/identity.ts'), 'utf8');
    ok(/window\.addEventListener\('storage'/.test(src), "identity.ts 听了 storage（本轮修复的落点）");
    ok(/e\.key === LAST_USER_KEY \|\| e\.key === KNOWN_USERS_KEY/.test(src),
        '  且把本模块自己写的那两把键排除在外（防 ping-pong）');
    ok(/document\.addEventListener\('visibilitychange'/.test(src), '  切回标签页时补一次');
    ok(/export function retainViewer/.test(src) && /export function refreshViewer/.test(src),
        '消费者登记 / 唯一拉取入口都导出着（测试与排障用）');
    const hook = src.slice(src.indexOf('export function useViewerProfile'));
    ok(/subscribe\(/.test(hook) && /retainViewer\(\)/.test(hook),
        'useViewerProfile 是 store 的薄绑定：订阅快照 + 登记消费者');
    ok(!/useState<\{ avatar/.test(src), '  旧那套"每个实例各持一份 mine/remembered"已经拆掉');
    for (const [f, name] of [['src/frontHome/Head/index.tsx', '首页头部'],
                             ['src/pages/Login/index.tsx', '登录页'],
                             ['src/pages/Dashboard/index.tsx', '后台侧栏'],
                             ['src/pages/Dashboard/Home/index.tsx', '后台首页']]) {
        const s = readFileSync(path.join(root, f), 'utf8');
        ok(/useViewerAvatar|useViewerProfile/.test(s), `${name} 仍从本模块取展示身份（没有自己再写一份）`);
    }
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}（通过 ${passed}）`);
process.exit(failed === 0 ? 0 : 1);
