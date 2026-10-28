// Announcement selection, read acknowledgements and refresh lifecycle.
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');          // 父仓（Rust 那半在这里）
const out = mkdtempSync(path.join(tmpdir(), 'annpop-'));

const file = path.join(out, 'pending.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/components/AnnouncementModal/pending.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
    plugins: [{
        name: 'fake-http',
        setup(build) {
            build.onResolve({ filter: /axios\.tsx$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
            build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
                loader: 'js',
                contents: `
                    export default function http(cfg) {
                        const ctl = globalThis.__apCtl;
                        ctl.calls.push({ url: cfg.url, method: cfg.method, data: cfg.data });
                        return Promise.resolve().then(() => ctl.responder(cfg));
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
        /** 测试主动发一个事件（等价于真实浏览器里别处派发的自定义事件） */
        fire(type) { (bag[type] || []).slice().forEach((fn) => fn({ type })) },
        /** 模块自己派发的事件（notifyAnnouncementPublished / notifyUnreadChanged）也真的送达监听者 */
        dispatchEvent(ev) { (bag[ev.type] || []).slice().forEach((fn) => fn(ev)); return true },
        listenerCount(type) { return (bag[type] || []).length },
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
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
};

// ── 假 setInterval：挂没挂、多久、撤没撤，测试说了算 ───────────────────────
const intervals = [];
globalThis.setInterval = (fn, ms) => {
    const rec = { ms, cleared: false, fn: () => { if (!rec.cleared) fn(); } };
    intervals.push(rec);
    return rec;
};
globalThis.clearInterval = (rec) => { if (rec) rec.cleared = true; };
/** 跑空微任务队列（假后端是 Promise 形态，没有真实 IO 要等） */
const tick = () => new Promise((r) => setTimeout(r, 0));

const ctl = { calls: [], responder: null };
globalThis.__apCtl = ctl;

const summary = { notifications: 0, messages: 0, total: 0, pendingReview: 0 };
const notifRes = (items) => ({ status: 200, data: { code: 200, data: items.find(item => item.type === 'announcement') ?? null } });
const annRes = (list) => ({ status: 200, data: { code: 200, data: list } });
const failRes = { status: 200, data: { code: 500, message: '未登录' } };
/**
 * 失败信封**带着一份能弹的内容**——这是"读不到 ≠ 没有"唯一有杀伤力的形态。
 * 真实的 200+code=500 正文里没有 data，所以"去掉那道判据"也能碰巧不弹（data 取到 undefined
 * ⇒ 没有可弹的），测试就会变成假绿：实测把那道判据改成 `if (false)` 时，只带 message 的
 * 失败样例**杀不掉**。token 过期/后端半死时正文里带不带旧数据不由前端决定，所以这里按
 * 最坏形态锁：`code !== 200` 就是读不到，正文里有什么都不许当真。
 */
const failWithStaleBody = (url) => ({
    status: 200,
    data: { code: 500, message: '未登录', data: url.includes('notifications') ? { unread: 1, items: [annRow(9)] } : [{ id: 99, title: '过期的公告', content: 'C99', createdAt: '2026-09-26 08:00:00' }] },
});

/** 一条公告展开出来的通知行（kind='announcement'） */
const annRow = (id, { isRead = false, title = '标题' + id, content = '正文' + id, createdAt = '2026-09-26 10:00:00' } = {}) =>
    ({ id, type: 'announcement', title, content, link: null, isRead, createdAt });
const noticeRow = (id) => ({ id, type: 'notice', title: '有人回复了你', content: 'x', link: '/talk?lid=1', isRead: false, createdAt: '2026-09-26 11:00:00' });

function reset({ token = null, responder = null } = {}) {
    for (const k of Object.keys(store)) delete store[k];
    if (token) store.tokenKey = token;
    ctl.calls.length = 0;
    intervals.length = 0;
    ctl.responder = responder || ((cfg) => {
        if (cfg.url === '/api/public/announcements') return annRes([]);
        if (cfg.url === '/api/protected/notifications/announcement') return notifRes([]);
        if (cfg.url === '/api/protected/notifications/read') return { status: 200, data: { code: 200, data: summary } };
        return { status: 404, data: { code: 404, message: '没有这个接口' } };
    });
}

const mod = await import(pathToFileURL(file).href);
const {
    fetchPendingAnnouncement, markAnnouncementRead, watchAnnouncements, notifyAnnouncementPublished,
    ANNOUNCEMENT_SEEN_KEY, ANNOUNCEMENT_PUBLISHED_EVENT, ANNOUNCEMENT_RECHECK_MS,
} = mod;

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
const urls = () => ctl.calls.map((c) => c.method + ' ' + c.url);

// ═══ 一、游客：没有账号可挂，仍按本机水位（键名沿用）═══
console.log('\n── 游客（无 token）──');
{
    const withUpdates = [{ id: 7, title: 'T7', content: 'C7', createdAt: '2026-09-26 09:00:00', updatedAt: '2026-09-26 12:00:00' }];
    reset({ responder: (c) => (c.url === '/api/public/announcements' ? annRes(withUpdates) : failRes) });
    const p = await fetchPendingAnnouncement();
    eq(p && { id: p.id, source: p.source, title: p.title, content: p.content, time: p.time },
        { id: 7, source: 'local', title: 'T7', content: 'C7', time: '2026-09-26 12:00:00' },
        '游客：新公告（id 大于水位）该弹，正文取自公告本体、时间取编辑时间');
    eq(urls(), ['GET /api/public/announcements'], '游客只打公开接口，不碰 /api/protected/notifications');

    store[ANNOUNCEMENT_SEEN_KEY] = '7';
    eq(await fetchPendingAnnouncement(), null, '游客：水位已到 7 ⇒ 不再弹（老访客不因这次改动重弹一遍）');

    delete store[ANNOUNCEMENT_SEEN_KEY];
    const got = await fetchPendingAnnouncement();
    await markAnnouncementRead(got);
    eq(store[ANNOUNCEMENT_SEEN_KEY], '7', '游客关窗：已读落在本机水位上');
    eq(ctl.calls.filter((c) => c.method !== 'GET').length, 0, '游客关窗：不发任何写请求（服务端没有他的身份）');

    reset({ responder: () => failRes });
    eq(await fetchPendingAnnouncement(), null, '游客：接口失败（code=500）⇒ 不弹（读不到 ≠ 没有）');
    reset({ responder: (c) => failWithStaleBody(c.url) });
    eq(await fetchPendingAnnouncement(), null, '游客：失败信封里**带着一份能弹的公告**也不弹（code ≠ 200 就是读不到）');
}

// ═══ 二、登录用户：读服务端通知行，已读 POST 回服务端（按账号）═══
console.log('\n── 登录用户（有 token）──');
{
    const items = [noticeRow(20), annRow(9, { title: 'T9', content: 'C9' }), annRow(4)];
    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications/announcement' ? notifRes(items) : failRes) });
    const p = await fetchPendingAnnouncement();
    eq(p && { id: p.id, source: p.source, title: p.title, content: p.content, time: p.time },
        { id: 9, source: 'server', title: 'T9', content: 'C9', time: '2026-09-26 10:00:00' },
        '登录：取最新那条公告行，id 是**通知行 id**（已读要 POST 的就是它）');
    eq(urls(), ['GET /api/protected/notifications/announcement'], '登录用户只读取单条最新公告，不拉完整通知列表');

    // 多条未读：只弹最新的那条，且**不把更旧的标成已读**——它们照旧在个人中心里未读
    eq(ctl.calls[0].data, undefined, '登录：列表是 GET，没有请求体');

    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications/announcement' ? notifRes([annRow(9, { isRead: true }), annRow(4)]) : failRes) });
    eq(await fetchPendingAnnouncement(), null, '最新那条已读 ⇒ 不弹（更旧的未读也不连环弹——这就是"关掉 #5 不再弹 #4"）');

    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications/announcement' ? notifRes([noticeRow(20)]) : failRes) });
    eq(await fetchPendingAnnouncement(), null, '通知里没有公告行（只有站内通知）⇒ 不弹');

    reset({ token: 'x.y.z', responder: () => failRes });
    eq(await fetchPendingAnnouncement(), null, '登录：通知接口失败 ⇒ 不弹（读不到 ≠ 没有）');
    reset({ token: 'x.y.z', responder: (c) => failWithStaleBody(c.url) });
    eq(await fetchPendingAnnouncement(), null,
        '登录：失败信封里带着未读公告行也不弹（token 过期时就长这样——照弹等于把"读不到"演成"你没读过"）');

    // 本机水位对登录用户不再作数：判据在服务端按账号
    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications/announcement' ? notifRes([annRow(9)]) : failRes) });
    store[ANNOUNCEMENT_SEEN_KEY] = '99999';
    ok((await fetchPendingAnnouncement()) !== null, '登录：本机水位再高也不影响（换浏览器不再重弹、本机标过也不冒充已读）');

    for (const data of [[], {}, { unread: 1, items: [annRow(9)] },
        { ...annRow(9), id: 0 }, { ...annRow(9), isRead: undefined },
        { ...annRow(9), content: undefined }]) {
        reset({ token: 'x.y.z', responder: () => ({ status: 200, data: { code: 200, data } }) });
        eq(await fetchPendingAnnouncement(), null,
            '异常或不完整的公告响应不能弹出空窗口，也不能把未知状态当成未读');
    }
}

console.log('\n── 登录用户关窗 = 标服务端已读 ──');
{
    reset({ token: 'x.y.z' });
    let unreadChange = 0;
    window.addEventListener('unread-change', () => { unreadChange++; });
    await markAnnouncementRead({ id: 9, source: 'server', title: 't', content: 'c', time: '' });
    eq(urls(), ['POST /api/protected/notifications/read'], '关窗：POST 一次已读');
    eq(ctl.calls[0].data, { ids: [9], all: false }, '关窗：只标**弹过的那一行**，不是 all（更旧的未读该留着）');
    ok(unreadChange === 1, '关窗：派发 unread-change ⇒ 红点当场重算（不必等下一拍轮询）', { unreadChange });
    eq(store[ANNOUNCEMENT_SEEN_KEY], undefined, '登录用户不写本机水位（免得留下第二本账）');

    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications/read' ? failRes : failRes) });
    unreadChange = 0;
    await markAnnouncementRead({ id: 9, source: 'server', title: 't', content: 'c', time: '' });
    ok(unreadChange === 0, '关窗：写失败就不派发 unread-change（没有新事实，别骗红点重算）', { unreadChange });
}

// ═══ 三、复查时机（"只有刷新才弹"的落点）═══
console.log('\n── 复查时机 ──');
{
    reset({});
    let n = 0;
    // 基线：unread.ts 自己也在 window 上挂了 agent-turn-done / unread-change（红点那颗心跳），
    // 所以"撤干净"要跟**登记前**比，不能跟 0 比。
    const base = [window.listenerCount('agent-turn-done'), window.listenerCount('unread-change'), window.listenerCount(ANNOUNCEMENT_PUBLISHED_EVENT)];
    const stop = watchAnnouncements(() => { n++; });
    eq([window.listenerCount('agent-turn-done'), window.listenerCount('unread-change'), window.listenerCount(ANNOUNCEMENT_PUBLISHED_EVENT)],
        base.map((c) => c + 1), '登记复查：三类事件各挂一个监听（同一个 check 收口）');
    eq(intervals.length, 1, '登记复查：挂且只挂一个定时器（多个触发源共用一个）');
    eq(intervals[0].ms, ANNOUNCEMENT_RECHECK_MS, '复查周期 = 60 秒（与未读轮询同一档）');

    document.hidden = false;
    const before = n;
    window.fire('agent-turn-done');      // 看板娘刚发过公告／刚标过已读
    window.fire('unread-change');        // 用户刚在个人中心点了全部已读
    window.fire(ANNOUNCEMENT_PUBLISHED_EVENT);  // 后台刚发布/编辑
    document.fire('visibilitychange');   // 标签页切回来
    eq(n - before, 4, '四类事件各触发一次复查（事件名对不上就是这里挂）');

    document.hidden = true;
    const hiddenBefore = n;
    document.fire('visibilitychange');
    intervals[0].fn();
    eq(n - hiddenBefore, 0, '标签页隐藏时不查（切回来会补一次，不必在后台空转）');

    document.hidden = false;
    intervals[0].fn();
    eq(n - hiddenBefore, 1, '可见时那一拍会查（跨浏览器/跨设备唯一能靠的就是它）');

    stop();
    ok(intervals[0].cleared, '卸载：定时器撤掉');
    const afterStop = n;
    window.fire('agent-turn-done');
    window.fire('unread-change');
    window.fire(ANNOUNCEMENT_PUBLISHED_EVENT);
    document.fire('visibilitychange');
    intervals[0].fn();
    eq(n - afterStop, 0, '卸载：事件与定时器全撤（SPA 换壳不会留下第二份监听）');
    eq([window.listenerCount('agent-turn-done'), window.listenerCount('unread-change'), window.listenerCount(ANNOUNCEMENT_PUBLISHED_EVENT)],
        base, '卸载：window 上的监听者回到登记前的数量（只撤自己那份，不碰红点那颗心跳）');
}

console.log('\n── 发布事件能送达（跨文件契约）──');
{
    reset({});
    let hit = 0;
    const stop = watchAnnouncements(() => { hit++; });
    notifyAnnouncementPublished();
    eq(hit, 1, 'notifyAnnouncementPublished 派发的事件正是 watcher 订阅的那个');
    ok(ANNOUNCEMENT_PUBLISHED_EVENT === 'announcement-published', '事件名字面量', ANNOUNCEMENT_PUBLISHED_EVENT);
    stop();
}

// ═══ 四、接线锁：判据再对，没接上也白搭 ═══
console.log('\n── 接线与机制锁（源码层）──');
{
    const read = (p) => readFileSync(path.join(root, p), 'utf8');

    const page = read('src/pages/Dashboard/Announcement/index.tsx');
    ok(/notifyAnnouncementPublished/.test(page) && /from '\.\.\/\.\.\/\.\.\/components\/AnnouncementModal\/pending\.ts'/.test(page),
        '后台公告页：发/改成功后调 notifyAnnouncementPublished（按同一浏览器当场复查）');

    const app = read('src/App.tsx');
    ok(/<AnnouncementModal\s*\/>/.test(app) && /import AnnouncementModal from "\.\/components\/AnnouncementModal"/.test(app),
        '公共页壳 App.tsx：挂上了公告弹窗');
    const dash = read('src/pages/Dashboard/index.tsx');
    ok(/<AnnouncementModal\s*\/>/.test(dash), '后台壳 pages/Dashboard/index.tsx：单独挂了一份（后台不在 App 那棵树里）');
    ok(dash.indexOf('<AnnouncementModal') > dash.lastIndexOf('<ConfigProvider'),
        '后台那份挂在 ConfigProvider 里面（后台是 darkAlgorithm，配色取 token 才读得出来）');
    const home = read('src/frontHome/Content/ContentHome/index.tsx');
    ok(!/AnnouncementModal/.test(home), '首页 ContentHome 那个旧挂载点已摘（挂着它就只能刷新才查一次）');

    // 两个出口的分工（20260926 用户拍板）：点「我知道了」才记已读；从弹窗外关掉
    // **不**记已读（那行照旧未读 ⇒ 红点与个人中心照旧未读、下次刷新照旧会弹）。
    // 源码层锁：这两个函数体里各只该出现一次 markAnnouncementRead，且在 handleRead 里。
    const modal = read('src/components/AnnouncementModal/index.tsx');
    const body = (startMarker, endMarker) => modal.slice(modal.indexOf(startMarker), modal.indexOf(endMarker));
    const closeFn = body('const handleClose = () => {', 'return (');
    const readFn = body('const handleRead = () => {', 'const handleClose');
    ok(/markAnnouncementRead\(p\)/.test(readFn),
        '点「我知道了」⇒ 记已读（唯一会记已读的出口）');
    ok(!/markAnnouncementRead/.test(closeFn),
        '从弹窗外关掉（遮罩/Esc/×）⇒ **不记已读**！仍是未读：红点照旧亮、个人中心照旧未读');
    ok((modal.match(/markAnnouncementRead\(/g) || []).length === 1,
        'markAnnouncementRead 在组件里只被调用一处（两个出口不许各写一遍）',
        { calls: (modal.match(/markAnnouncementRead\(/g) || []).length });
    ok(/onCancel=\{handleClose\}/.test(modal) && /onClick=\{handleRead\}/.test(modal)
       && /我知道了/.test(modal),
        '遮罩/Esc/× 走 handleClose、「我知道了」按钮走 handleRead（接线别接反）');

    // Database fanout and read-state preservation are exercised against PostgreSQL by
    // src/routes/announcement_actions/tests.rs, shared by native and legacy writes.

}

console.log(`\n${passed}/${passed + failed} 通过`);
if (failed) { console.error(`失败 ${failed} 条`); process.exit(1); }
