// ═ 标签树/标签渲染回归 ══
//   node tests/tag-tree.test.mjs
// 覆盖 20260919「标签设置交互难用而且有错误」背后的纯逻辑：
//   · 建树按 fatherKey（一级改名后二级标签不许消失、同名一级标签不许共享子标签）
//   · 扁平选项（二级显示自己的名字、`keywords` 里带父名、两级 id 重号丢弃后者）
//   · 渲染加固（悬空 id 不渲染空白块、去重、折叠 +N、载体是管理页那套 antd Tag）
// 载体是 src/apis/TagMethods.tsx —— 它 import 了 antd 与 axios 单例，本机不能在 node 里
// 真加载 antd（cssinjs/DOM），所以用 esbuild JS API + onResolve 把它们换成极简 stub，
// 只断言数据结构（React 元素是普通对象，直接走 props 即可）。
import * as esbuild from 'esbuild';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'tagtree-'));
const stubAntd = path.join(here, 'stubs', 'antd.mjs');
const stubAxios = path.join(here, 'stubs', 'axios.mjs');

const stub = {
    name: 'stub-heavy-deps',
    setup(build) {
        build.onResolve({ filter: /^antd$/ }, () => ({ path: stubAntd }));
        build.onResolve({ filter: /axios\.tsx$/ }, () => ({ path: stubAxios }));
    },
};

const file = path.join(out, 'TagMethods.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/apis/TagMethods.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: file,
    logLevel: 'error',
    plugins: [stub],
});

const TM = await import(file);
// ⚠️ 不能拿 stub 模块对象做身份比较：它已被 esbuild 打进 bundle，bundle 里是**另一份副本**；
// 也不能靠函数名（重名时 esbuild 会把内部函数改名 Tag → Tag2），所以认 stub 上的标记属性。
const isTag = (n) => n?.type?.__isTag === true;
// 20260930 五轮曾把**公开面**的标签（首页卡片 + articleRecord，走 `renderNoteTags`）换成
// 手账 chip `<span className="tagChip">`；20261001 用户要求「回到标签管理页的样式」，
// 于是全仓（公开面 + 后台折叠渲染）统一回 antd `<Tag color=…>` —— 只剩一种载体。
const labelOf = (n) => String(n.props.children);

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });

// 在 React 元素树里收集所有标签的 label（stub Tag 是普通函数，可当哨兵比较；chip 认 className）
function tagsOf(node, acc = []) {
    if (Array.isArray(node)) { node.forEach(n => tagsOf(n, acc)); return acc; }
    if (!node || typeof node !== 'object') return acc;
    if (isTag(node)) acc.push(labelOf(node));
    if (node.props) Object.values(node.props).forEach(v => tagsOf(v, acc));
    return acc;
}
// 展平嵌套数组但**不进元素的 props**：折叠组件的 children 形如
// span > [ [Tag,Tag,Tag], <Popover> ]，只展开数组这一层才能拿到"真正露出来的"那几个
function shallow(node) {
    const out = [];
    const walk = (k) => { if (Array.isArray(k)) k.forEach(walk); else out.push(k); };
    walk(node?.props?.children);
    return out;
}
const topLevelTags = (node) => shallow(node).filter(isTag).map(k => String(k.props.children));
const popoverOf = (node) => shallow(node).find(k => k?.type?.__isPopover === true);
// JSX 的 `+{rest.length}` 会编成 children 数组 ['+', 1]，拼起来才是 "+1"
const triggerTag = (po) => [].concat(po?.props?.children?.props?.children ?? []).join('');

const ONE = [
    { key: 10, title: '编程', level: 1, color: '#1677ff' },
    { key: 11, title: '生活', level: 1, color: '#52c41a' },
];
const TWO = [
    { key: 5, title: 'Python', level: 2, color: '#1677ff', fatherKey: 10, fatherTag: '编程' },
    { key: 6, title: 'Rust', level: 2, color: '#eb2f96', fatherKey: 10, fatherTag: '编程' },
];

// ══════════════════════════════════════════════
console.log('== 建树：fatherKey 权威（一级标签改名后二级标签不许消失）==');
{
    const renamed = [{ ...ONE[0], title: '编程语言' }, ONE[1]];
    const tree = TM.buildTagTree(renamed.map(t => ({ ...t })), TWO.map(t => ({ ...t })));
    eq(tree[0].children.map(c => c.title), ['Python', 'Rust'], '父级改名后子标签仍挂在这个父下');
    eq(tree[1].children.length, 0, '不会被别的父级抢走');
}
{
    // 同名一级标签：旧逻辑按名字 filter 会让两个父级共享同一批子标签
    const dup = [
        { key: 10, title: '编程', level: 1, color: '#1677ff' },
        { key: 20, title: '编程', level: 1, color: '#000' },
    ];
    const tree = TM.buildTagTree(dup.map(t => ({ ...t })), TWO.map(t => ({ ...t })));
    eq(tree[0].children.length, 2, '第一个「编程」拿到自己的子标签');
    eq(tree[1].children.length, 0, '同名但不同 id 的另一个不共享');
}
{
    // 老数据（后端没回 fatherKey 时）仍能按名字兜底
    const legacy = TWO.map(({ fatherKey, ...rest }) => rest);
    const tree = TM.buildTagTree(ONE.map(t => ({ ...t })), legacy);
    eq(tree[0].children.map(c => c.title), ['Python', 'Rust'], 'fatherKey 缺失时按 fatherTag 名字回退');
}

console.log('== 扁平选项：二级标签显示自己的名字、重号丢弃后者 ==');
{
    const tree = TM.buildTagTree(ONE.map(t => ({ ...t })), TWO.map(t => ({ ...t })));
    const opts = TM.flattenTagOptions(tree);
    eq(opts.map(o => [o.value, o.label]),
       [[10, '编程'], [5, 'Python'], [6, 'Rust'], [11, '生活']],
       '顺序与标签文案（二级不再拼成「父 / 子」）');
    eq(opts.map(o => o.level), [1, 2, 2, 1], '层级标注正确');
    // ⚠️ 显示名与搜索词是**两个字段**：显示名去掉了父名，但"搜父名也能列出子标签"
    // 这条能力必须留着（原来靠 `编程 / Python` 那个拼接串白捡的）。
    // `NoteTagSelect` 的 `optionFilterProp` 指的就是 `keywords`。
    eq(opts.map(o => o.keywords), ['编程', '编程 Python', '编程 Rust', '生活'],
       '搜索词仍带父名（二级标签搜得到父名）');
    ok(opts.every(o => !o.label.includes(' / ')),
       '不变量：两级标签的 label 都不带「父 / 子」那种拼接',
       opts.map(o => o.label));
}
{
    // tag_two 的 id 5 与某个 tag_one 的 id 5 重号（两张表各自自增，迁移前的真实风险）
    const one = [{ key: 5, title: '重号一级', level: 1, color: '#000' }, { key: 10, title: '编程', level: 1, color: '#1677ff' }];
    const tree = TM.buildTagTree(one.map(t => ({ ...t })), TWO.map(t => ({ ...t })));
    const warn = console.warn; const seen = [];
    console.warn = (...a) => seen.push(a.join(' '));
    const opts = TM.flattenTagOptions(tree);
    console.warn = warn;
    eq(opts.filter(o => o.value === 5).length, 1, '重号 id 只留一个（先出现的一级标签）');
    ok(seen.some(s => s.includes('重号')), '重号时打 warn 而不是静默');
    eq(TM.tagLabelMap(tree).get(5).label, '重号一级', '按 id 找名字时一级优先（与旧行为一致）');
}
{
    const opts = TM.flattenTagOptions([{ key: 0, title: '非法' }, { key: NaN, title: '非法2' }, null, undefined]);
    eq(opts, [], '非法/空选项不进列表（旧版会渲染出空值选项）');
}

console.log('== 渲染加固：悬空 id 不渲染空白块 ==');
{
    const tree = TM.buildTagTree(ONE.map(t => ({ ...t })), TWO.map(t => ({ ...t })));
    eq(tagsOf(TM.renderNoteTags([10, 5], tree)), ['编程', 'Python'], '正常渲染');
    eq(tagsOf(TM.renderNoteTags([10, 10, 5], tree)), ['编程', 'Python'], '按 id 去重');
    eq(tagsOf(TM.renderNoteTags([99, 1, 12], tree)), [], '全是悬空 id → 一个空白块都不渲染（线上 12 篇的老毛病）');
    eq(tagsOf(TM.renderNoteTags([99, 11], tree)), ['生活'], '悬空 id 夹在中间也不影响其余标签');
    // 「样式回到标签管理页的样式」这条要求的**结构性**那一半：载体回到 antd Tag、
    // 颜色取标签自己的。管理页树上渲染的是 `<Tag color={node.color}>{node.title}</Tag>`，
    // 这里断言的是同一个形状 —— 至于"看起来像不像"，那是 sass/组件本身的事。
    const rendered = TM.renderNoteTags([5], tree);
    ok(rendered.length === 1 && isTag(rendered[0]), '公开面标签的载体是 antd Tag（不再是手账 chip）', rendered.map(n => n?.type));
    eq(rendered[0]?.props?.color, '#1677ff', '用的是标签自己的颜色（二级不再借用父色）');
}

console.log('== 折叠渲染（后台列表列）==');
{
    const tree = TM.buildTagTree(ONE.map(t => ({ ...t })), TWO.map(t => ({ ...t })));
    eq(topLevelTags(TM.renderNoteTagsCollapsed([10, 5, 6, 11], tree, 3)), ['编程', 'Python', 'Rust'], '只显示前 3 个');
    const po = popoverOf(TM.renderNoteTagsCollapsed([10, 5, 6, 11], tree, 3));
    eq(triggerTag(po), '+1', '第 4 个收进 Popover，触发器显示 +1');
    eq(tagsOf(po.props.content), ['编程', 'Python', 'Rust', '生活'], 'Popover 里能展开看到全部（含被折叠的那个）');
    eq(String(TM.renderNoteTagsCollapsed([], tree).props.children), '—', '没标签 → 占位符');
    eq(String(TM.renderNoteTagsCollapsed([99, 1, 12], tree).props.children), '—', '全是悬空 id → 也是占位符（不是空白小块）');
    eq(topLevelTags(TM.renderNoteTagsCollapsed([99, 10, 5, 6, 11], tree, 3)), ['编程', 'Python', 'Rust'],
       '悬空 id 不占名额（否则真实标签会被挤进 Popover）');
}

console.log(`\n${failed ? '有失败' : '全部通过'}：${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
