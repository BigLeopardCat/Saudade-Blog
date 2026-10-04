// ═ 换代后的悬空 chunk：识别 + 带闸自愈（20261005，A 案）══
//   node tests/stale-chunk.test.mjs
//
// 现场：部署换代时 dist 按"本次构建的清单"做集合差，把上一代的带哈希分块删掉；而一个
// **一直开着**的标签页还停在老一代（它的 index.html 与主包都是老的），点开首页展示柜
// 时那条 `import()` 指向的文件已经不存在 ⇒ 404 ⇒ `Failed to fetch dynamically imported
// module: …/WordGraphExhibit-<hash>.js`。用户看到兜底卡，而卡上那颗「重试」永远好不了
// （重新挂载子树拿的还是同一个 URL）。
//
// 这套件锁四件：
//   ① 措辞识别 —— 认浏览器**真会这么说**的四句，且不认"看着像"的（误伤 = 好好的页面被刷掉）；
//   ② 自愈闸 —— 一分钟一次、时钟倒退不放行、存储被禁也要能刷（否则就是"刷—坏—刷"死循环）；
//   ③ 两个触发点真接上了，且**判据先于上报**（stale 那一支不许再报 react_error，否则一次
//      事故两行日志；白名单那边看 `monitor-report.test.mjs`）；
//   ④ 兜底卡本身 —— stale 分支给的是「刷新页面」+ `location.reload()`，**不是**「重试」+
//      `setState`（那一颗在这个场景是骗人的）。
//
// ⚠️ 行为测试必须把 `location` / `sessionStorage` / `fetch` 三样替换掉再 import ——
// `staleChunk.ts` 拉进 `utils/report.ts`，而后者按设计"永远不抛"：它会把 ReferenceError
// 吞掉，于是"没刷""没报"在断言里长得一模一样。缺了会显式报错。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..'); // 父仓根（Rust 那半边在这儿）

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

// ── 打包两个模块 ───────────────────────────────────────────────────────────
// `import.meta.env` 在 node 里是 undefined ⇒ `runtimeApi.ts` 那句
// `import.meta.env.VITE_HTTP_BASEURL || window.location.port …` 在 import 期就 TypeError。
// 用 define 把它替换成空对象（值仍是 undefined ⇒ 走 `||` 右边），与构建期行为一致。
const out = mkdtempSync(path.join(tmpdir(), 'stalechunk-'));
async function bundle(entry, name) {
    const file = path.join(out, name);
    await esbuild.build({
        entryPoints: [path.join(root, entry)],
        bundle: true, format: 'esm', platform: 'node', outfile: file,
        define: { 'import.meta.env': '{}' },
        logLevel: 'error',
    });
    return pathToFileURL(file).href;
}

// ── 替身环境（顺序要紧：先摆好再 import）────────────────────────────────────
const FLAG = 'staleChunkReloadAt';
function fakeEnv({ stamp = null, readThrows = false, writeThrows = false } = {}) {
    const store = new Map();
    if (stamp !== null) store.set(FLAG, String(stamp));
    const calls = { reload: 0, stampAtReload: [], fetches: [] };
    const loc = {
        href: 'https://saudade.site/article/19',
        reload() {
            calls.reload++;
            // 刷新**当场**读标记：这是"先写后刷"那条顺序契约的取证方式
            try { calls.stampAtReload.push(store.has(FLAG) ? store.get(FLAG) : null); }
            catch { calls.stampAtReload.push('<throw>'); }
        },
    };
    globalThis.window = { location: loc, addEventListener() {}, removeEventListener() {} };
    globalThis.location = loc;
    globalThis.sessionStorage = {
        getItem(k) {
            if (readThrows) throw new Error('SecurityError: 存储被禁');
            return store.has(k) ? store.get(k) : null;
        },
        setItem(k, v) {
            if (writeThrows) throw new Error('QuotaExceededError');
            store.set(k, String(v));
        },
        removeItem(k) { store.delete(k); },
    };
    globalThis.fetch = (url, init) => {
        calls.fetches.push({ url, init });
        return Promise.resolve({ ok: true, status: 200 });
    };
    return { store, calls };
}
const bodyOf = (f) => { try { return JSON.parse(f.init.body); } catch { return null; } };

const core = await import(await bundle('src/utils/staleChunkCore.ts', 'core.mjs'));
const guardUrl = await bundle('src/utils/staleChunk.ts', 'guard.mjs');
fakeEnv();                                   // 第一份替身必须在 import 之前到位
const G = await import(guardUrl);

// ────────────────────────────────────────────────────────────────────────────
console.log('\n① 措辞识别（认浏览器真会说的那几句，不认"看着像"的）');
{
    // 生产日志里那一行就是第一句（含真实分块名与哈希）
    const REAL = 'Failed to fetch dynamically imported module: https://saudade.site/js/WordGraphExhibit-Ab12Cd34.js';
    ok(core.isStaleChunkMessage(REAL), 'Chrome/Edge 的原话认得出');
    ok(core.isStaleChunkMessage('error loading dynamically imported module'), 'Chromium 另一条分支认得出');
    ok(core.isStaleChunkMessage('Importing a module script failed.'), 'Safari/旧 Chromium 认得出');
    ok(core.isStaleChunkMessage('Unable to preload CSS for /js/index-9f8e7d.css'), 'Vite 预载 CSS 那条认得出');
    ok(core.isStaleChunkMessage('FAILED TO FETCH DYNAMICALLY IMPORTED MODULE: x'), '大小写不敏感');

    // ★ 误伤的代价是"好好的页面被刷掉一次"，所以这两面都要有负空间。
    // 下面每一句都是真实会出现的普通报错/普通网络故障：
    const NOISE = [
        'Failed to fetch',                                   // 普通 fetch 失败（不含"动态导入"）
        'NetworkError when attempting to fetch resource.',   // Firefox 的 fetch 失败
        'TypeError: Cannot read properties of undefined',    // 运行期 JS 异常
        'Loading chunk 5 failed.',                           // webpack 那套（本仓是 Vite，但别认错）
        'ChunkLoadError: Loading chunk 3 failed.',           // 同上
        'Request failed with status code 500',               // axios 的接口失败
        'module script load failed',                         // 少了 importing…failed 的词序
        '',
    ];
    for (const m of NOISE) ok(core.isStaleChunkMessage(m) === false, '不误认：' + JSON.stringify(m.slice(0, 46)));

    // messageOf：抛出来的东西有四种形状（Error / 字符串 / {message} / 其它）
    ok(core.messageOf(new Error('boom')) === 'boom', 'Error → message');
    ok(core.messageOf('boom') === 'boom', '字符串原样');
    ok(core.messageOf({ message: 'boom' }) === 'boom', '带 message 的对象');
    ok(core.messageOf(null) === '', 'null → 空串（不回 "null"）');
    ok(core.messageOf(undefined) === '', 'undefined → 空串');
    ok(core.messageOf({ code: 3 }) === '[object Object]', '认不出的对象不抛（String 兜底）');
    // 判据的入口是 messageOf ⇒ 直接扔一个 Error 进 isStaleChunkMessage 是错的用法
    ok(core.isStaleChunkMessage(core.messageOf(new Error(REAL))), 'Error 包一层也认得（经由 messageOf）');
}

console.log('\n② 自愈闸（一分钟一次；时钟倒退与存储被禁都不许变成死循环）');
{
    const T = 1_700_000_000_000;
    ok(core.RELOAD_GUARD_MS === 60_000, '最小间隔 = 60 秒');
    ok(core.shouldAutoReload(null, T) === true, '从没刷过 → 放行（这就是第一次自愈）');
    ok(core.shouldAutoReload(T, T) === false, '刚刷过（同一毫秒）→ 不放行');
    ok(core.shouldAutoReload(T, T + 1_000) === false, '刷过 1 秒后 → 不放行');
    ok(core.shouldAutoReload(T, T + 59_999) === false, '刷过 59.9 秒后 → 不放行');
    ok(core.shouldAutoReload(T, T + 60_000) === false, '正好 60 秒 → 仍不放行（判据是严格大于）');
    ok(core.shouldAutoReload(T, T + 60_001) === true, '过了 60 秒 → 放行（又发生了一次换代）');
    // 时钟倒退（用户改系统时间 / NTP 回拨）：now - last 是负数 ⇒ 判 false，不刷
    ok(core.shouldAutoReload(T, T - 86_400_000) === false, '时钟倒退到一天前 → 不放行（否则真死循环）');
    // 脏值：sessionStorage 里被塞了非数字
    ok(core.shouldAutoReload(NaN, T) === true, 'NaN 当"没刷过"处理');
    ok(core.shouldAutoReload(Infinity, T) === true, 'Infinity 当"没刷过"处理（负无穷才是刚刷过）');
}

console.log('\n③ 两个触发点接上了，且判据先于上报');
{
    const main = read('src/main.tsx');
    ok(main.includes("from './utils/staleChunk'") || main.includes('from "./utils/staleChunk"'),
        'main.tsx 引入自愈模块', main.match(/.*staleChunk.*/)?.[0]);
    const listener = /window\.addEventListener\(\s*'vite:preloadError'([\s\S]*?)\n\}\)/.exec(main);
    ok(!!listener, "main.tsx 注册了 vite:preloadError 监听（Vite 预载那条路）",
        main.match(/vite:preloadError[\s\S]{0,200}/)?.[0]);
    if (listener) {
        const body = listener[1];
        ok(/if\s*\(\s*recoverFromStaleChunk\(\)\s*\)/.test(body),
            '只有真的刷了才 preventDefault（闸拦住时报错照旧抛给边界）', body.trim());
        ok(body.indexOf('recoverFromStaleChunk(') < body.indexOf('preventDefault()'),
            '先问闸、再拦下（顺序反了会把边界那条路一起堵掉）');
    }

    const boundary = read('src/components/ErrorBoundary/index.tsx');
    ok(boundary.includes('isStaleChunkError') && boundary.includes('recoverFromStaleChunk'),
        'ErrorBoundary 引入判据与自愈（React.lazy 那条路生产里真会走）');
    // componentDidCatch 的**函数体**范围（不能拿全文件的 indexOf 当判据 —— 注释里也写着
    // reportError 这个词，那样比出来的是注释的位置）
    const cdc = /componentDidCatch\([\s\S]*?\n    \}/.exec(boundary);
    ok(!!cdc, '取到 componentDidCatch 的函数体');
    if (cdc) {
        const body = cdc[0];
        const judge = body.indexOf('isStaleChunkError(error)');
        const report = body.indexOf('reportError(');
        ok(judge > 0, '先判是不是换代');
        ok(report > 0 && judge < report, '★ 判据在 reportError 之前（换代那一支不报 react_error）',
            { judge, report });
        // 负空间：stale 分支体内不许出现 reportError（一次事故两行日志的来源就是这个）
        const branch = /if\s*\(\s*isStaleChunkError\([\s\S]*?return\s*\}/.exec(body);
        ok(!!branch && !branch[0].includes('reportError'),
            'stale 分支体内没有 reportError', branch ? branch[0].replace(/\s+/g, ' ').slice(0, 120) : null);
    }

    // 兜底卡：stale 那支必须刷新，不能给"重试"
    const render = /render\(\)\s*\{([\s\S]*?)\n    \}/.exec(boundary);
    ok(!!render, '取到 render 的函数体');
    if (render) {
        const body = render[1];
        ok(/isStaleChunkError\(error\)/.test(body), 'render 也按同一判据分叉');
        ok(body.includes('页面已更新'), 'stale 的标题是「页面已更新」');
        ok(/if\s*\(\s*stale\s*\)\s*location\.reload\(\)/.test(body),
            '★ stale 分支走整页刷新', body.match(/if\s*\(\s*stale[\s\S]{0,120}/)?.[0]);
        ok(/else\s+this\.setState\(\{\s*error:\s*null\s*\}\)/.test(body),
            '非 stale 仍是重挂子树（那一支的重试是有意义的）');
        ok(/\{\s*!stale\s*&&\s*\(/.test(body),
            'stale 不展示原始报错文本（对访客只是一串带哈希的文件名）');
    }

    // 日志这一档在服务端白名单里（闭集，新增 type 必须同步 MONITOR_KINDS；
    // 全量比对在 monitor-report.test.mjs，这里只做本模块这一条的定向锁）
    const rs = readFileSync(path.join(repo, 'src/routes/monitor.rs'), 'utf8');
    ok(/"module_load_fail"/.test(rs), 'module_load_fail 在 MONITOR_KINDS 里（staleChunk 复用了它）');
    const guard = read('src/utils/staleChunk.ts');
    ok(!/type:\s*'(?!module_load_fail)[a-z0-9_]+'/.test(guard),
        'staleChunk.ts 只报这一个 type（别在这里长出新的一档）');
}

console.log('\n④ 行为：只刷一次、先写标记再刷、报一条 keepalive 日志');
{
    const E = fakeEnv();
    const err = new Error('Failed to fetch dynamically imported module: https://saudade.site/js/WordGraphExhibit-Ab12Cd34.js');
    const first = G.recoverFromStaleChunk(err);
    ok(first === true, '第一次撞上 ⇒ 返回 true（调用方据此决定要不要 preventDefault）');
    ok(E.calls.reload === 1, '真的刷了（location.reload 被调用一次）', E.calls.reload);
    ok(E.calls.stampAtReload[0] !== null,
        '★ 刷新发生的那一刻标记**已经**在存储里（先写后刷，避免"刷—坏—刷"死循环）',
        E.calls.stampAtReload);
    ok(Number.isFinite(Number(E.store.get(FLAG))), '标记是一个时间戳', E.store.get(FLAG));

    ok(E.calls.fetches.length === 1, '报了一条 monitor 日志', E.calls.fetches.length);
    const f = E.calls.fetches[0];
    ok(!!f && /\/api\/monitor\/log$/.test(f.url), '打到上报端点', f?.url);
    ok(f?.init?.method === 'POST', '是 POST');
    ok(f?.init?.keepalive === true,
        '★ keepalive: true（这条日志要活过紧接着的那次导航，否则诊断信息全丢）');
    const body = bodyOf(f);
    ok(body?.type === 'module_load_fail', 'type = module_load_fail', body?.type);
    ok(typeof body?.message === 'string' && body.message.includes('stale chunk')
        && body.message.includes('WordGraphExhibit'),
        'message 里带换代说明与原始报错（事后能对上是哪条分块）', body?.message);
    ok(body?.url === 'https://saudade.site/article/19', '带上了出事页面的 URL', body?.url);

    // ★ 闸的第二半：紧接着再撞一次（不同措辞，绕开 report.ts 的会话去重），不许再刷
    const again = G.recoverFromStaleChunk(new Error('error loading dynamically imported module'));
    ok(again === false, '一分钟内第二次 ⇒ 返回 false（闸拦住）');
    ok(E.calls.reload === 1, '★ 没有刷第二次（这就是死循环的锁）', E.calls.reload);
    ok(E.calls.fetches.length === 1, '也没有再报一条（同一事故一行日志）', E.calls.fetches.length);

    // 闸的外侧：又隔了一分钟 ⇒ 那是一次**新的**换代，该再自愈
    const E2 = fakeEnv({ stamp: Date.now() - 60_001 });
    ok(G.recoverFromStaleChunk(new Error('Importing a module script failed.')) === true,
        '过了闸的时间窗 ⇒ 重新放行（隔一分钟的第二次换代仍然自愈）');
    ok(E2.calls.reload === 1, 'E2 刷了一次', E2.calls.reload);

    // 时钟倒退：存储里的标记在未来 ⇒ 不刷（宁可显示兜底卡，也不进死循环）
    const E3 = fakeEnv({ stamp: Date.now() + 86_400_000 });
    ok(G.recoverFromStaleChunk(new Error('Unable to preload CSS for /js/a.css')) === false,
        '时钟倒退（标记在未来）⇒ 不刷');
    ok(E3.calls.reload === 0, 'E3 一次都没刷', E3.calls.reload);

    // 隐私模式：读写 sessionStorage 都抛 ⇒ 仍要能刷一次（只是失去"只刷一次"的记忆）
    const E4 = fakeEnv({ readThrows: true, writeThrows: true });
    ok(G.recoverFromStaleChunk(new Error('Failed to fetch dynamically imported module: x')) === true,
        '存储被禁 ⇒ 当作"从没刷过"，仍放行');
    ok(E4.calls.reload === 1, '存储被禁时也确实调用了 reload', E4.calls.reload);
    ok(E4.calls.fetches.length === 1, '存储被禁不影响那条日志', E4.calls.fetches.length);
}

console.log('\n⑤ 两个入口共用同一份判据（口径：判措辞的只有 isStaleChunkError 一处）');
{
    // `recoverFromStaleChunk` 自己不判措辞 —— 它是"试一次"，不该不该打这个电话由调用方判。
    // 这条断言把那个分工钉住：将来若有人在它内部也加一层措辞判据，会出现"第一道判据
    // 放行、第二道拦下"的半死状态。
    fakeEnv();
    ok(G.recoverFromStaleChunk(new Error('TypeError: x is not a function')) === true,
        'recoverFromStaleChunk 不自己判措辞（调用方先判）');
    ok(G.isStaleChunkError(new Error('TypeError: x is not a function')) === false,
        '★ isStaleChunkError 会拦住它（两个触发点用的都是这一个入口）');
    ok(G.isStaleChunkError(new Error('Failed to fetch dynamically imported module: y')) === true,
        '该放行的照旧放行（负空间不是"一律拒绝"）');
}

console.log(`\n${pass}/${pass + fail} 项通过`);
if (fail) process.exit(1);
