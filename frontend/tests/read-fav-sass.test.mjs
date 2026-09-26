// ═ 文章横幅「收藏」按钮竖排 · sass 编译契约（20260926）══
//   node tests/read-fav-sass.test.mjs
//
// 现场：`.readInfo` 是 flex 行，标题一长就把 `.readFavWrap` 挤窄，「已收藏」被折成两行
// （用户报的「已收」「藏」）。修法两条都在 `ReadArticle/index.sass` 里：wrapper 不许收缩
// （`flex: 0 0 auto`）、文案竖排（`.readFavLabel`），另有 `.readFavBtn` 改列向。
//
// 为什么这条要进 CI（而这套的其它判据在 `.test.py` 沙箱里）：**sass 缩进嵌套已经咬过两次**
// （见记忆里那条"个人中心/红点"的根因）——缩进错一级，编译产物里选择器就挂到别的父级下面，
// 语法完全合法、构建不报错、页面也不会崩，只是样式静默失效。这里用真 sass 编译真 `.sass`，
// 断言每条规则落在**完整的选择器链**上：缩进错了链就变了，链对不上即红。
//
// 布局行为（竖排真的生效、挤不挤）由 tests/read-fav-vertical.test.py 在无头 Chrome 里验，
// 那边能算 flex 收缩后的真实宽度；本套件只管"CSS 有没有写在该在的地方"。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sass from 'sass';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SASS_FILE = path.join(root, 'src/frontHome/Content/ReadArticle/index.sass');
const TSX_FILE = path.join(root, 'src/frontHome/Content/ReadArticle/index.tsx');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

let css = '';
try {
    css = sass.compile(SASS_FILE).css.toString();
} catch (e) {
    console.error('  ✗ FAIL: sass 编译失败 → ' + e.message);
    process.exit(1);
}

/** selector → 声明块（同名选择器出现多次时并入，顺便能看出重复定义） */
const rules = new Map();
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    rules.set(sel, (rules.get(sel) || '') + ';' + m[2]);
}
const decl = (sel, prop, value) => {
    const body = rules.get(sel);
    if (body === undefined) return { found: false, why: '选择器不在编译产物里' };
    const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
    if (!m) return { found: false, why: prop + ' 不在这个选择器下' };
    return { found: true, value: m[1].trim(), match: m[1].trim() === value };
};

const WRAP = '.readContainer .readCover .readInfo .readFavWrap';
const BTN = WRAP + ' .readFavBtn';
const LABEL = BTN + ' .readFavLabel';

console.log('\n① wrapper：不许被 flex 挤小（挤窄是「折成两行」的机制本身）');
{
    const r = decl(WRAP, 'flex', '0 0 auto');
    ok(r.found, WRAP + ' 有 flex 声明', r);
    ok(r.match, '  值是 0 0 auto（不收缩的那一份）', r);
    const m = decl(WRAP, 'margin-top', '6px');
    ok(m.match, '  原有的 margin-top: 6px 还在', m);
}

console.log('\n② 按钮：★ 在上、文案在下（列向）');
{
    const r = decl(BTN, 'flex-direction', 'column');
    ok(r.found && r.match, BTN + ' 是 flex-direction: column', r);
    const a = decl(BTN, 'align-items', 'center');
    ok(a.match, '  仍然居中（align-items: center）', a);
    const g = decl(BTN, 'gap', '2px');
    ok(g.match, '  间距 2px', g);
    const p = decl(BTN, 'padding', '6px 8px');
    ok(p.match, '  内边距 6px 8px（竖排后改小横向、加大纵向）', p);
    ok(!/flex-direction:\s*row/.test(rules.get(BTN) || ''), '  没有别处再把它改回 row');
}

console.log('\n③ 文案：竖排（★ 直立、不折第二列）');
{
    const w = decl(LABEL, 'writing-mode', 'vertical-rl');
    ok(w.found && w.match, LABEL + ' 是 writing-mode: vertical-rl', w);
    const o = decl(LABEL, 'text-orientation', 'upright');
    ok(o.found && o.match, '  text-orientation: upright（★ 也跟着直立）', o);
    const n = decl(LABEL, 'white-space', 'nowrap');
    ok(n.found && n.match, '  white-space: nowrap（竖排下不许再折成第二列）', n);
}

console.log('\n④ 缩进陷阱：`.readFavLabel` 只许挂在它该在的那条链上');
{
    const withLabel = [...rules.keys()].filter((s) => s.includes('readFavLabel'));
    ok(withLabel.length === 1, '编译产物里只有一条规则提到 readFavLabel', withLabel);
    ok(withLabel[0] === LABEL, '  且选择器链完整（少一级/多一级都说明缩进错了）', withLabel[0]);
    // 反面：常见错法会长成这两样——分别断言它们**不**存在
    ok(!rules.has('.readFavLabel'), '  没有挂在顶层的 .readFavLabel（缩进少了）');
    ok(!rules.has(WRAP + ' .readFavLabel'), '  没有跳过按钮直接挂 wrap（缩进多/少一级）');
}

console.log('\n⑤ 三态色与描边一字未改（这批只动布局）');
{
    const f = decl(BTN + '.isFaved', 'background', '#ffcc7c');
    ok(f.found && f.match, '已收藏：河灯金 #ffcc7c 实心', f);
    const ft = decl(BTN + '.isFaved', 'color', '#1c2754');
    ok(ft.match, '  深蓝字（#1c2754）', ft);
    const b = decl(BTN, 'border', '1px solid rgba(255, 241, 235, 0.55)');
    ok(b.found, '未收藏：浅色描边还在', b);
    ok(!!rules.get(BTN + ':hover') !== undefined, 'hover 规则还在');
    ok(!!rules.get(BTN + ':disabled') !== undefined, 'disabled 规则还在（提交中会有）');
}

console.log('\n⑥ 源码契约：文案包在 span.readFavLabel 里，★ 仍是独立的 aria-hidden span');
{
    const tsx = readFileSync(TSX_FILE, 'utf8');
    ok(/<span className="readFavLabel">\{(faved|fav)[^}]*\}<\/span>/.test(tsx),
        'index.tsx 里文案包在 <span className="readFavLabel"> 内（类名与 sass 对齐）');
    ok(/<span aria-hidden="true">\{faved \? '★' : '☆'\}<\/span>/.test(tsx),
        '★ 仍是单独的 span 且 aria-hidden（读屏只念"已收藏"）');
    ok(!/aria-hidden[^>]*readFavLabel/.test(tsx), '  两者没有合并成一个 span');
    // 类名对不上是这类改动最哑的失败：sass 写了、tsx 没挂，页面上不动声色
    const sassSrc = readFileSync(SASS_FILE, 'utf8');
    ok(sassSrc.includes('.readFavLabel') && tsx.includes('readFavLabel'),
        '两份文件里的类名一致（sass 写了、tsx 挂上了）');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
