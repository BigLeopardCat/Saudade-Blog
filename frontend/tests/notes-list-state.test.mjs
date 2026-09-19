// ═ 后台文章列表状态机回归 ══
//   node tests/notes-list-state.test.mjs
// 覆盖 20260919 用户反馈「翻页改完配置页码回第一页 / 列表状态丢失」背后的纯逻辑：
//   URL ⇄ ListQuery 的序列化（空值必须 delete）、非法值回落、渲染期钳制（绝不回写 URL）、
//   本地分页切片、行内补丁、标签筛选、请求形状（list vs search）、返回票据。
// 载体是 AllNotes/listState.ts 与 utils/noteTags.ts（都是 TS），本机禁止 vite build
// （见 CLAUDE.md §2），所以用 esbuild 单文件打包后再由 node 断言。
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'nls-'));

// ⚠️ 不能加 --packages=external：临时包落在 /tmp，node 从那里解析不到 frontend/node_modules
function bundle(rel, name) {
    const file = path.join(out, name);
    execFileSync(path.join(root, 'node_modules/.bin/esbuild'), [
        path.join(root, rel), '--bundle', '--format=esm', '--platform=node',
        `--outfile=${file}`, '--log-level=error',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    return file;
}

// listState 里的 saveListReturn/readListReturn 走 window.sessionStorage
const store = new Map();
globalThis.window = {
    sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    },
};

const S = await import(bundle('src/pages/Dashboard/Notes/AllNotes/listState.ts', 'listState.mjs'));
const T = await import(bundle('src/utils/noteTags.ts', 'noteTags.mjs'));

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });

const D = S.DEFAULT_LIST_QUERY;

// ══════════════════════════════════════════════
console.log('== URL ⇄ ListQuery：默认值不落 URL、空值删除 ==');
{
    eq(S.parseListQuery(''), D, '空串解析成默认值');
    eq(S.parseListQuery('?'), D, '裸 ? 解析成默认值');
    eq(S.buildListQuery(D), '', '默认值序列化成空串（tab=1/page=1 不落 URL）');

    const full = { ...D, tab: '2', page: 3, kw: '架构', title: '文档', cat: '技术', top: '1', from: '2026-01-01', to: '2026-02-02', tags: [3, 7] };
    const round = S.parseListQuery(S.buildListQuery(full));
    eq(round, full, 'build → parse 往返一致');

    // 序列化里绝不能出现空串键（会导致 deps 误判为变化 + URL 噪声）
    const noisy = S.buildListQuery({ ...D, title: '', cat: '', top: '' });
    ok(!noisy.includes('title=') && !noisy.includes('cat=') && !noisy.includes('top='), '空字段不写进 URL', noisy);
    ok(!noisy.includes('tags=') , '空标签数组不写进 URL', noisy);
}

console.log('== 非法值回落 ==');
{
    eq(S.parseListQuery('?tab=9').tab, '1', 'tab 非 1/2/3 → 1');
    eq(S.parseListQuery('?tab=2').tab, '2', 'tab=2 保留');
    eq(S.parseListQuery('?page=0').page, 1, 'page=0 → 1');
    eq(S.parseListQuery('?page=-3').page, 1, 'page 负数 → 1');
    eq(S.parseListQuery('?page=abc').page, 1, 'page 非数字 → 1');
    eq(S.parseListQuery('?page=2.5').page, 1, 'page 小数 → 1（不做四舍五入）');
    eq(S.parseListQuery('?top=7').top, '', 'top 非 0/1 → 空');
    eq(S.parseListQuery('?from=2026-1-1').from, '', '不合法日期 → 丢掉');
    eq(S.parseListQuery('?from=2026-01-01').from, '2026-01-01', '合法日期保留');

    // 旧深链 `?keyword=` 必须继续能用（bookmark 不能失效）
    eq(S.parseListQuery('?keyword=测试').kw, '测试', 'keyword 旧别名兼容');
    eq(S.parseListQuery('?kw=a&keyword=b').kw, 'a', 'kw 与 keyword 同现时 kw 优先');

    // 真实深链：Dashboard 搜索框跳过来 + 用户手改的 tab/page 混在一起
    const deep = S.parseListQuery('?keyword=%E6%B5%8B%E8%AF%95&tab=3&page=2');
    eq([deep.kw, deep.tab, deep.page], ['测试', '3', 2], '深链：关键词 + tab + page 同时生效');
}

console.log('== clampPage：渲染期钳制，绝不回写 URL ==');
{
    eq(S.clampPage(5, 10, 8), 2, 'clampPage(5,10,8) === 2（用户说的"改完配置跳回第一页"就发生在这里）');
    eq(S.clampPage(1, 0, 8), 1, 'total=0 → 1（antd 不接受 current=0）');
    eq(S.clampPage(3, 0, 8), 1, 'total=0 且当前页超界 → 1');
    eq(S.clampPage(2, 16, 8), 2, '边界：恰好满页不缩');
    eq(S.clampPage(9, 17, 8), 3, '17 条 = 3 页，第 9 页 → 3');
    eq(S.clampPage(0, 17, 8), 1, '0 → 1');
    eq(S.clampPage(NaN, 17, 8), 1, 'NaN → 1');
    eq(S.clampPage(2, 17, 0), 2, 'pageSize=0 不炸（回落到默认 8）');
}

console.log('== pageSlice：显示第几页与切出哪几行永不脱节 ==');
{
    const rows = Array.from({ length: 19 }, (_, i) => ({ key: i + 1 }));
    eq(S.pageSlice(rows, 1, 8).map(r => r.key), [1, 2, 3, 4, 5, 6, 7, 8], '第 1 页 8 行');
    eq(S.pageSlice(rows, 3, 8).map(r => r.key), [17, 18, 19], '第 3 页 3 行（19 条）');
    eq(S.pageSlice(rows, 9, 8).map(r => r.key), [17, 18, 19], '第 9 页被钳到第 3 页');
}

console.log('== normalizeNoteRows：5 份复制粘贴的收敛 ==');
{
    const rows = S.normalizeNoteRows([
        { noteKey: 11, noteTitle: 'a', noteTags: '1,2' },
        { noteKey: 12, noteTitle: 'b', noteTags: '' },
        { noteKey: 13, noteTitle: 'c', noteTags: null },
        { noteKey: 14, noteTitle: 'd' },
        { noteKey: 15, noteTitle: 'e', noteTags: '3,3,,5,' },
        { noteKey: 16, noteTitle: 'f', noteTags: [7, '8'] },
    ]);
    eq(rows.map(r => r.key), [11, 12, 13, 14, 15, 16], 'key 取自 noteKey');
    eq(rows.map(r => r.noteTags), [[1, 2], [], [], [], [3, 5], [7, 8]], '各种脏值都规整成 number[]');
    eq(S.normalizeNoteRows(null), [], 'null → []');
    eq(S.normalizeNoteRows({}), [], '非数组 → []');
}

console.log('== patchRow：只动目标行，其余行保持同一引用 ==');
{
    const rows = [{ key: 1, status: 'public' }, { key: 2, status: 'public' }, { key: 3, status: 'public' }];
    const next = S.patchRow(rows, 2, { status: 'private' });
    eq(next.map(r => r.status), ['public', 'private', 'public'], '只有目标行被改');
    ok(next[0] === rows[0] && next[2] === rows[2], '非目标行是同一对象引用（少一次 diff）');
    ok(S.patchRow(rows, 99, { status: 'private' }) === rows, 'key 不存在时返回原数组');
    ok(rows[1].status === 'public', '原数组不被就地改写');
    // 行内改配置的真实载荷：状态 + 置顶 + 标签
    const patched = S.patchRow(S.normalizeNoteRows([{ noteKey: 5, noteTags: '1,2', status: 'public', isTop: 0 }]), 5,
        { status: 'private', isTop: 1, noteTags: [9] });
    eq(patched[0].noteTags, [9], '标签可以就地改');
    eq(patched[0].key, 5, '改完仍然是同一行（不因不匹配当前 tab 就被抽走）');
}

console.log('== 标签筛选（前端侧，不进请求体） ==');
{
    const rows = S.normalizeNoteRows([
        { noteKey: 1, noteTags: '1,2' },
        { noteKey: 2, noteTags: '3' },
        { noteKey: 3, noteTags: null },
    ]);
    ok(S.filterRowsByTags(rows, []) === rows, '空选择不过滤（返回同一引用）');
    eq(S.filterRowsByTags(rows, [3]).map(r => r.key), [2], '命中任一选中标签');
    eq(S.filterRowsByTags(rows, [1, 3]).map(r => r.key), [1, 2], '多选是"或"');
    eq(S.filterRowsByTags(rows, [99]).map(r => r.key), [], '没有匹配 → 空');
    const req = S.listRequest({ ...D, tags: [1, 2] });
    eq(req, { mode: 'list' }, '标签筛选是前端的活，不发搜索请求');
}

console.log('== listRequest：list / search 分流 ==');
{
    eq(S.listRequest(D), { mode: 'list' }, '全部文章 + 零条件 → /notes/list');
    eq(S.listRequest({ ...D, tab: '2' }), { mode: 'search', body: { status: 'private' } }, '私密 tab → search(status=private)');
    eq(S.listRequest({ ...D, tab: '3' }), { mode: 'search', body: { status: 'draft' } }, '草稿 tab → search(status=draft)');
    eq(S.listRequest({ ...D, kw: '架构' }), { mode: 'search', body: { keyword: '架构' } }, '关键词 → keyword');
    eq(S.listRequest({ ...D, title: '文档' }), { mode: 'search', body: { title: '文档' } }, '标题筛选 → title（后端 20260919 才真正支持）');
    eq(S.listRequest({ ...D, top: '1' }).body, { is_top: 1 }, '置顶 → is_top 数字');
    eq(S.listRequest({ ...D, top: '0' }).body, { is_top: 0 }, 'is_top=0 不能被当成"没填"丢掉');
    eq(S.listRequest({ ...D, cat: '技术', from: '2026-01-01', to: '2026-01-31' }).body,
        { categories: '技术', start_date: '2026-01-01', end_date: '2026-01-31' }, '分类 + 日期区间');
    eq(S.listRequest({ ...D, tab: '2', title: 'x' }).body, { title: 'x', status: 'private' }, '条件与 tab 叠加');
    // 第 1 页也是 page=1（URL 不写），但请求形状不受 page 影响
    eq(S.listRequest({ ...D, page: 5 }), { mode: 'list' }, '翻页本身不改变请求形状');
}

console.log('== 返回票据（编辑器 → 列表） ==');
{
    eq(S.readListReturn(), null, '没存过 → null');
    S.saveListReturn('?tab=2&page=3');
    eq(S.readListReturn(), '?tab=2&page=3', '存什么读什么');
    S.saveListReturn('');
    eq(S.readListReturn(), '', '空串是合法票据（= 列表首页）');
    store.set(S.LIST_RETURN_KEY, '{"恶意":"对象"}');
    eq(S.readListReturn(), null, '非法票据被拒（当没有，走兜底）');
    store.set(S.LIST_RETURN_KEY, 'https://evil.example/');
    eq(S.readListReturn(), null, '外部 URL 被拒（绝不能拿它去 navigate）');
    store.delete(S.LIST_RETURN_KEY);
}

console.log('== noteTags 编解码 ==');
{
    eq(T.parseNoteTags('1,2,3'), [1, 2, 3], '正常串');
    eq(T.parseNoteTags('1,1,2,'), [1, 2], '去重 + 丢空片');
    eq(T.parseNoteTags(''), [], '空串 → []');
    eq(T.parseNoteTags(null), [], 'null → []');
    eq(T.parseNoteTags(undefined), [], 'undefined → []');
    eq(T.parseNoteTags(' 4 , 5 '), [4, 5], '两侧空白');
    eq(T.parseNoteTags('12abc,0,-3,NaN'), [], '脏值全丢（parseInt 会把 12abc 悄悄当 12）');
    eq(T.parseNoteTags([1, '2', 2]), [1, 2], '数组入参也去重');
    eq(T.joinNoteTags([3, 1, 3]), '3,1', '写出串（去重，保持选择顺序）');
    eq(T.joinNoteTags([]), '', '空数组 → 空串（后端据此清空标签，是明确意图）');
    eq(T.joinNoteTags(null), '', 'null → 空串');
    ok(T.sameTagSet([1, 2], [2, 1]), '同一集合顺序不同算相同');
    ok(!T.sameTagSet([1, 2], [1, 2, 3]), '多一个不算相同');
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
