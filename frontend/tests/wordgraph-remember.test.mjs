// ═ 图谱检索态恢复（URL + sessionStorage）纯逻辑回归 ══
//   node tests/wordgraph-remember.test.mjs
// 覆盖：URL 参数解析与截断、缓存序列化/解析（脏数据一律丢弃）、
// decideBoot 的优先级与"缓存是另一次检索"分支、sessionStorage 读写与异常兜底。
// remember.ts 是 TS，用 esbuild 打成 ESM 再 import（本机禁止 vite build）。
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'wgr-'));

function bundle(rel, name) {
    const file = path.join(out, name);
    execFileSync(path.join(root, 'node_modules/.bin/esbuild'), [
        path.join(root, rel), '--bundle', '--format=esm', '--platform=neutral',
        `--outfile=${file}`, '--log-level=error',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    return file;
}

const W = 'src/frontHome/Content/ContentHome/Vitrine/wordgraph/';
const R = await import(bundle(W + 'remember.ts', 'remember.mjs'));

// ── 断言小工具（与 wordgraph-engine.test.mjs 同款）──
let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) passed++;
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, exp, name) => ok(got === exp, name, { got, exp });

// ── 假 sessionStorage：可控、可注入异常 ──
let store = new Map();
let boom = false;
globalThis.sessionStorage = {
    getItem: (k) => { if (boom) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (boom) throw new Error('denied'); store.set(k, String(v)); },
    removeItem: (k) => { if (boom) throw new Error('denied'); store.delete(k); },
};

// ── ① queryFromUrl ──
const getter = (o) => (k) => (k in o ? o[k] : null);
eq(R.queryFromUrl(getter({})), '', 'URL 无参数 → 空串');
eq(R.queryFromUrl(getter({ wg: '  物联网  ' })), '物联网', 'URL 参数 trim');
eq(R.queryFromUrl(getter({ wg: '   ' })), '', 'URL 参数全空白 → 空串');
eq(R.queryFromUrl(getter({ wg: 'x'.repeat(200) })).length, 64, 'URL 参数截断到 64');
eq(R.queryFromUrl(getter({ other: 'x' })), '', '只认 wg 参数名');

// ── ② serialize / parseSaved ──
const hits = [{ w: '遥测', s: 0.388 }, { w: 'esp32', s: 0.345 }];
const round = R.parseSaved(R.serialize('物联网', hits, 'esp32'));
eq(round.q, '物联网', '往返：查询串');
eq(round.hits.length, 2, '往返：命中数');
eq(round.hits[0].w, '遥测', '往返：命中词');
eq(round.sel, 'esp32', '往返：选中词');

eq(R.parseSaved(null), null, '无缓存 → null');
eq(R.parseSaved('{'), null, '坏 JSON → null');
eq(R.parseSaved('null'), null, 'JSON null → null');
eq(R.parseSaved('{"q":"   "}'), null, '空查询串 → null');
eq(R.parseSaved(JSON.stringify({ q: 'x'.repeat(200) })).q.length, 64, '缓存里的超长查询串也截断');
eq(R.parseSaved(JSON.stringify({ q: 'a', hits: [] })).hits, null, '空命中数组 → null（与"没查过"同义）');
eq(R.parseSaved(JSON.stringify({ q: 'a', hits: 'nope' })).hits, null, '命中不是数组 → null');
eq(R.parseSaved(JSON.stringify({ q: 'a', hits: [{ w: 'x' }, { w: 'y', s: 1 }, null, 7] })).hits.length, 1,
    '脏命中项被逐条过滤');
eq(R.parseSaved(JSON.stringify({ q: 'a', sel: 42 })).sel, null, 'sel 非字符串 → null');
eq(R.parseSaved(JSON.stringify({ q: 'a', hits: Array.from({ length: 99 }, (_, i) => ({ w: 'w' + i, s: 1 })) })).hits.length,
    32, '命中列表上限 32');

// ── ③ decideBoot：URL 优先，其次缓存 ──
const cached = { q: '物联网', hits, sel: 'esp32' };
eq(R.decideBoot(''  , null), null, '无 URL 无缓存 → 不恢复');
eq(R.decideBoot('物联网', null).q, '物联网', '有 URL 无缓存 → 只恢复查询串');
eq(R.decideBoot('物联网', null).hits, null, '有 URL 无缓存 → 命中列表待重查');
eq(R.decideBoot('', cached), cached, '无 URL 有缓存 → 用缓存（点站内首页回来这条路）');
eq(R.decideBoot('物联网', cached), cached, 'URL 与缓存同一次检索 → 用缓存（不必再等网络）');
const other = R.decideBoot('单片机', cached);
eq(other.q, '单片机', 'URL 与缓存不同 → 用 URL 的查询串');
eq(other.hits, null, 'URL 与缓存不同 → 命中列表重新检索');
eq(other.sel, null, 'URL 与缓存不同 → 不带上次的选中词');

// ── ④ sessionStorage 读写与异常兜底 ──
store = new Map();
R.writeSaved({ q: '向量', hits: [{ w: '向量', s: 0.58 }], sel: null });
const back = R.readSaved();
eq(back.q, '向量', 'sessionStorage 往返：查询串');
eq(back.hits[0].w, '向量', 'sessionStorage 往返：命中词');
R.clearSaved();
eq(R.readSaved(), null, 'clearSaved 之后读不到');
eq(R.parseSaved(store.get('wgSearchState') ?? null), null, '清空确实删了键');

boom = true;
eq(R.readSaved(), null, '存储抛异常时 readSaved 返回 null（不炸）');
let threw = false;
try { R.writeSaved({ q: 'x', hits: null, sel: null }); R.clearSaved(); } catch { threw = true; }
ok(!threw, '存储抛异常时 writeSaved/clearSaved 不抛');
boom = false;

console.log(`\nwordgraph-remember: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
