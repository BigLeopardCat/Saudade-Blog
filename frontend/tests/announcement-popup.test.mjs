// ═ 公告弹窗的判据／已读落点／复查时机回归（20260926）══
//   node tests/announcement-popup.test.mjs
//
// 用户报的两条：①「公告是只有刷新才能弹出」——弹窗原来挂在首页 ContentHome 里，
// 一次页面生命周期只查一次；②「公告修改弹窗会出现一次，并且认定用户没读吧」——
// 已读记在 localStorage 水位 `announcement_seen_id`，与个人中心那份**按账号**记的
// 已读是两本互不通气的账（那里标了已读，这里照弹；换浏览器，同一批又弹一遍）。
//
// 判据现在收口在 src/components/AnnouncementModal/pending.ts，本套件锁它：
//   · 登录用户读**服务端通知行**（公告发布时逐用户展开的那行）的 isRead，关窗 POST 已读
//     ⇒ "弹过的公告"与"红点里的未读公告"变成同一件事的两种显示
//   · 只弹"最新的那条公告且它未读"——多条未读时**不连环弹**（关掉 #5 不再弹 #4、#3）
//   · 游客没有账号可挂 ⇒ 仍走本机水位（键名沿用，老访客不因这次改动重弹一遍）
//   · **读不到 ≠ 没有**：接口失败一律不弹（旧实现"换个浏览器重弹一遍"正是这里演出来的）
//   · 复查时机：挂载即查 + 四类事件 + 可见时 60 秒一拍 + 卸载全撤（"发出来当场收到"的落点）
// 外加三条**接线锁**（判据再对，没接上也白搭）：
//   · 后台公告页发/改后确实调了 notifyAnnouncementPublished
//   · 两处挂载（App 壳 + 后台壳）在位，首页那个旧挂载点已摘
//   · Rust update_announcement 只同步标题/正文——不插通知行、不碰 is_read（编辑必不重弹）
//
// pending.ts 是 TS 且 import 了 axios 单例与 unread.ts：本机不能 vite build（3.7GB 内存，
// 见 CLAUDE.md §2），用 esbuild JS API 把 axios 换成受测可控的假后端。
// setInterval 也换成受测自己触发的假实现：不换的话"每 60 秒那一拍"要么真等一分钟、
// 要么根本验不出到底挂没挂、撤没撤。Node 18 没有 CustomEvent 全局，得自己补一个
// ——少了它 pending.ts 的 dispatch 会被 try/catch 静默吞掉，事件那条腿就成了空跑。
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
const notifRes = (items) => ({ status: 200, data: { code: 200, data: { unread: items.filter((i) => !i.isRead).length, items } } });
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
        if (cfg.url === '/api/protected/notifications') return notifRes([]);
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
    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications' ? notifRes(items) : failRes) });
    const p = await fetchPendingAnnouncement();
    eq(p && { id: p.id, source: p.source, title: p.title, content: p.content, time: p.time },
        { id: 9, source: 'server', title: 'T9', content: 'C9', time: '2026-09-26 10:00:00' },
        '登录：取最新那条公告行，id 是**通知行 id**（已读要 POST 的就是它）');
    eq(urls(), ['GET /api/protected/notifications'], '登录用户走通知接口，不打公开公告接口');

    // 多条未读：只弹最新的那条，且**不把更旧的标成已读**——它们照旧在个人中心里未读
    eq(ctl.calls[0].data, undefined, '登录：列表是 GET，没有请求体');

    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications' ? notifRes([annRow(9, { isRead: true }), annRow(4)]) : failRes) });
    eq(await fetchPendingAnnouncement(), null, '最新那条已读 ⇒ 不弹（更旧的未读也不连环弹——这就是"关掉 #5 不再弹 #4"）');

    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications' ? notifRes([noticeRow(20)]) : failRes) });
    eq(await fetchPendingAnnouncement(), null, '通知里没有公告行（只有站内通知）⇒ 不弹');

    reset({ token: 'x.y.z', responder: () => failRes });
    eq(await fetchPendingAnnouncement(), null, '登录：通知接口失败 ⇒ 不弹（读不到 ≠ 没有）');
    reset({ token: 'x.y.z', responder: (c) => failWithStaleBody(c.url) });
    eq(await fetchPendingAnnouncement(), null,
        '登录：失败信封里带着未读公告行也不弹（token 过期时就长这样——照弹等于把"读不到"演成"你没读过"）');

    // 本机水位对登录用户不再作数：判据在服务端按账号
    reset({ token: 'x.y.z', responder: (c) => (c.url === '/api/protected/notifications' ? notifRes([annRow(9)]) : failRes) });
    store[ANNOUNCEMENT_SEEN_KEY] = '99999';
    ok((await fetchPendingAnnouncement()) !== null, '登录：本机水位再高也不影响（换浏览器不再重弹、本机标过也不冒充已读）');
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

    // 编辑不重弹的机制保证在 Rust 那半：只同步标题/正文，不插行、不碰 is_read
    const rs = readFileSync(path.join(repo, 'src/routes/announcements.rs'), 'utf8');
    const upd = rs.slice(rs.indexOf('pub async fn update_announcement'), rs.indexOf('pub async fn delete_announcement'));
    ok(upd.length > 0 && !/IsRead/.test(upd) && !/\.insert\(/.test(upd) && /update_many\(\)/.test(upd),
        'Rust update_announcement：只 update_many 标题/正文——不插通知行、不碰 is_read ⇒ 改过的公告不会重弹',
        { hasIsRead: /IsRead/.test(upd), hasInsert: /\.insert\(/.test(upd) });
    ok(/ANN_ROW_KIND|KIND_ANNOUNCEMENT/.test(rs) && /user_notification::ActiveModel/.test(rs.slice(rs.indexOf('async fn fan_out'), rs.indexOf('pub async fn list_announcements'))),
        '公告发布时逐用户展开成通知行（登录用户的弹窗与红点读的是同一批行）');
}

console.log(`\n${passed}/${passed + failed} 通过`);
if (failed) { console.error(`失败 ${failed} 条`); process.exit(1); }
