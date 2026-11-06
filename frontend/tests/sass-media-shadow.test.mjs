import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sass from 'sass';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/
const SRC = path.join(root, 'src');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 把编译产物拆成 [是否在 @media 里, 选择器, 声明体, 在 css 里的下标]；@media 展开一层 */
function flatBlocks(css) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    let i = 0;
    for (;;) {
        const j = css.indexOf('{', i);
        if (j < 0) break;
        const head = css.slice(i, j).trim();
        let depth = 1, k = j + 1;
        while (depth && k < css.length) {
            if (css[k] === '{') depth++;
            else if (css[k] === '}') depth--;
            k++;
        }
        const body = css.slice(j + 1, k - 1);
        if (head.startsWith('@media')) {
            for (const [, s, d, pos] of flatBlocks(body)) out.push([true, s, d, j + 1 + pos]);
        } else if (!head.startsWith('@')) {
            out.push([false, head, body, i]);
        }
        i = k;
    }
    return out;
}

/** 声明体 → { 属性: 是不是 !important } */
function props(decl) {
    const m = {};
    for (const x of decl.matchAll(/(?:^|;)\s*([a-z-]+)\s*:([^;]*)/g)) m[x[1]] = /important/.test(x[2]);
    return m;
}

/** 声明体 → { 属性: 取值（剥掉 !important 与空白，只用于"两边取值一样吗"）} */
function values(decl) {
    const m = {};
    for (const x of decl.matchAll(/(?:^|;)\s*([a-z-]+)\s*:([^;]*)/g)) {
        m[x[1]] = x[2].replace(/!important/g, '').replace(/\s+/g, ' ').trim();
    }
    return m;
}

/** → [[选择器, [被判死的属性…]], …]（判据 ①：同特异度 + 源序） */
function shadowedDecls(css) {
    const flat = flatBlocks(css);
    const plain = new Map();
    for (const [inMedia, sel, decl, pos] of flat) {
        if (!inMedia) plain.set(sel, [...(plain.get(sel) || []), [pos, decl]]);
    }
    const bad = [];
    for (const [inMedia, sel, decl, pos] of flat) {
        if (!inMedia) continue;
        const after = (plain.get(sel) || []).filter(([p]) => p > pos);
        if (!after.length) continue;
        const dead = Object.entries(props(decl))
            .filter(([pr, imp]) => after.some(([, d2]) => pr in props(d2) && (!imp || props(d2)[pr])))
            .map(([pr]) => pr);
        if (dead.length) bad.push([sel, dead.sort()]);
    }
    return bad;
}

/** 选择器 → 候选"简单序列"（按逗号拆开；带 `> + ~` 的整条跳过，宁可漏报） */
function seqs(sel) {
    return sel.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => (/[>+~]/.test(s) ? null : s.split(/\s+/).filter(Boolean)))
        .filter(Boolean);
}

/** a2 是以 a1 为后缀、且更长的序列 ⇒ 匹配 a2 的元素必然也匹配 a1，且特异性严格更高 */
function suffixSuperset(a2, a1) {
    if (a2.length <= a1.length) return false;
    const off = a2.length - a1.length;
    return a1.every((t, i) => a2[off + i] === t);
}

// 状态伪类：带这类条件的选择器**不恒真**（只在悬停/聚焦等状态下匹配），媒体档在其余
// 状态下照常生效 ⇒ 它压不住整档，不能算死。
const STATEFUL = /:(hover|focus|focus-visible|focus-within|active|target|visited|checked|disabled)\b/;

/** → [{sel, dead: [{prop, mine, theirs, killer}]}]（判据 ②：特异性被压） */
function specShadowedDecls(css) {
    const flat = flatBlocks(css);
    const plain = flat.filter(([m]) => !m);
    const out = [];
    for (const [inMedia, sel, decl] of flat) {
        if (!inMedia) continue;
        const s1 = seqs(sel);
        if (!s1.length) continue;
        const p1 = props(decl), v1 = values(decl);
        const dead = [];
        for (const pr of Object.keys(p1)) {
            const killer = plain.find(([, sel2, d2]) => {
                const p2 = props(d2);
                if (!(pr in p2)) return false;
                if (p1[pr] && !p2[pr]) return false;        // 媒体档 !important、对面不是 ⇒ 媒体赢
                if (values(d2)[pr] === v1[pr]) return false; // 取值相同只是冗余，不是缺陷
                if (STATEFUL.test(sel2)) return false;       // 对面是状态档 ⇒ 不恒真
                return seqs(sel2).some((a2) => s1.some((a1) => suffixSuperset(a2, a1)));
            });
            if (killer) dead.push({ prop: pr, mine: v1[pr], theirs: values(killer[2])[pr], killer: killer[1] });
        }
        // 按属性名排序：命中清单要可逐字比对（否则"声明里谁先写"会漂进断言与报告）
        if (dead.length) out.push({ sel, dead: dead.sort((a, b) => (a.prop < b.prop ? -1 : 1)) });
    }
    return out;
}

console.log('\n① 判据①自带牙：喂一份"父规则写在媒体档后面"的样本，必须被报出来');
{
    const BAD = `
@media screen and (max-width: 768px) {
  .SelfDescription { gap: 28px; padding: 104px 5% 56px; }
}
.SelfDescription { min-height: 100vh; gap: 48px; padding: 112px 6% 148px 8%; }
`;
    const hits = shadowedDecls(BAD);
    ok(hits.length === 1 && hits[0][0] === '.SelfDescription'
        && JSON.stringify(hits[0][1]) === '["gap","padding"]',
        '★ 报出 `["gap","padding"]`（且不提 min-height —— 父规则没声明过它）', hits);

    const GOOD = `
.SelfDescription { min-height: 100vh; gap: 48px; padding: 112px 6% 148px 8%; }
@media screen and (max-width: 768px) {
  .SelfDescription { gap: 28px; padding: 104px 5% 56px; }
}
`;
    ok(shadowedDecls(GOOD).length === 0, '  顺序正确（媒体档在父规则之后）时零命中');

    const IMP = `
@media screen and (max-width: 768px) { .T { height: auto !important; display: block; } }
.T { height: 640px; display: grid; }
`;
    const h2 = shadowedDecls(IMP);
    ok(h2.length === 1 && JSON.stringify(h2[0][1]) === '["display"]',
        '★ `!important` 的媒体声明不算死（只有不带 `!important` 的 `display` 被判死）', h2);

    const IMP2 = `
@media screen and (max-width: 768px) { .T { height: auto !important; } }
.T { height: 640px !important; }
`;
    const h3 = shadowedDecls(IMP2);
    ok(h3.length === 1 && JSON.stringify(h3[0][1]) === '["height"]',
        '  两边都 `!important` 时仍按源序算死（后写者赢，`!important` 只挡不带 `!important` 的）', h3);
}

console.log('\n② 判据②自带牙：特异性被压的样本（父类里那条 —— 挪位置也救不回来）');
{
    const BAD = `
.readContainer .readContent { width: 80%; padding: 20px; }
@media only screen and (max-width: 768px) {
  .readContent { width: 100%; padding: 12px 10px; }
}
`;
    const hits = specShadowedDecls(BAD);
    ok(hits.length === 1 && hits[0].sel === '.readContent'
        && JSON.stringify(hits[0].dead.map((d) => d.prop)) === '["padding","width"]',
        '★ 报出 `width` / `padding`（媒体档写在**后面**也照样死）',
        hits.map((h) => [h.sel, h.dead.map((d) => d.prop)]));
    const w = hits[0]?.dead.find((d) => d.prop === 'width');
    ok(w?.killer === '.readContainer .readContent' && w?.theirs === '80%' && w?.mine === '100%',
        '  连"被谁压的、两边各是什么取值"一起报出来（照这条去改）', hits[0]?.dead);

    const GOOD = `
.readContainer .readContent { width: 80%; }
@media only screen and (max-width: 768px) {
  .readContent { width: 100% !important; }
}
`;
    ok(specShadowedDecls(GOOD).length === 0, '  加 `!important` 之后零命中（这就是本仓采用的修法）');

    const SAME = `
.readContainer .readContent { width: 80%; }
@media only screen and (max-width: 768px) { .readContent { width: 80%; } }
`;
    ok(specShadowedDecls(SAME).length === 0,
        '  两边取值相同的**不算**（冗余不是缺陷；等对面改了值，它当场变成上面那条）');

    const HOVER = `
.panel.is-open:hover .panel-veil, .panel.is-open:focus-within .panel-veil { opacity: 1; }
.panel-veil { opacity: 0; }
@media (hover: none) { .panel-veil { opacity: 1; } }
`;
    ok(specShadowedDecls(HOVER).length === 0,
        '★ 状态伪类（`:hover` / `:focus-within`）不恒真 ⇒ 压不住整档，不报');

    const CHILD = `
.ContentContainer .allArticles .ArticleCard .ArticleTitle { margin-bottom: 10px; }
@media screen and (max-width: 768px) {
  .allArticles .ArticleCard .ArticleTitle { margin-bottom: 6px; }
}
`;
    const h4 = specShadowedDecls(CHILD);
    ok(h4.length === 1 && h4[0].dead[0].prop === 'margin-bottom',
        '  只比序列后缀：`.allArticles … .ArticleTitle` 被 `.ContentContainer .allArticles …` 压死'
        + '（前面的 token 多出来就够了，不必逐字相同）', h4);

    const COMB = `
.a > .b { width: 10px; }
@media screen and (max-width: 768px) { .b { width: 20px; } }
`;
    ok(specShadowedDecls(COMB).length === 0,
        '  带 `>` 的选择器整条跳过（宁可漏报，不做子组合器的集合推理）');
}

console.log('\n③ 全仓扫描：`src/**/*.sass` 与 `src/**/*.css` 的编译产物里不许有这个形状');
{
    const files = [];
    const walk = (d) => {
        for (const f of readdirSync(d)) {
            const p = path.join(d, f);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.(sass|css)$/.test(f)) files.push(p);
        }
    };
    walk(SRC);
    ok(files.length >= 40, `扫到 ${files.length} 个样式文件（少了就是枚举断了）`);

    const orderHits = [];
    const specHits = [];
    const skipped = [];
    for (const f of files.sort()) {
        let css;
        // 逐文件静音 logger：全仓扫描只报告顺序/特异度命中，不重复输出 Sass 的依赖告警。
        const silent = f.endsWith('.css') ? null : { logger: sass.Logger.silent };
        try {
            css = f.endsWith('.css')
                ? readFileSync(f, 'utf8')
                : sass.compile(f, silent).css.toString();
        } catch (e) {
            skipped.push(path.relative(root, f) + '：' + String(e.message).split('\n')[0]);
            continue;
        }
        const rel = path.relative(root, f);
        for (const [sel, dead] of shadowedDecls(css)) {
            orderHits.push(`${rel}  ${sel}  →  ${dead.join(', ')}`);
        }
        for (const { sel, dead } of specShadowedDecls(css)) {
            specHits.push(`${rel}  ${sel}  →  ` + dead.map((d) =>
                `${d.prop}: ${d.mine} ← 被 \`${d.killer}\` 的 ${d.theirs} 压掉`).join('；'));
        }
    }

    ok(skipped.length === 0, '每个样式文件都能单独编译（编译不过 = 判据对它失效）', skipped);
    if (orderHits.length) {
        console.log('    下面这些媒体档声明**不会生效**（把那段挪到父规则声明之后即可）：');
        for (const h of orderHits) console.log('      · ' + h);
    }
    if (specHits.length) {
        console.log('    下面这些媒体档声明被**更高特异性**的普通规则压掉（挪位置没用，给那几条加 `!important`）：');
        for (const h of specHits) console.log('      · ' + h);
    }
    ok(orderHits.length === 0, `源序型零命中（当前 ${files.length} 个文件）`, orderHits);
    ok(specHits.length === 0, `特异性型零命中（当前 ${files.length} 个文件）`, specHits);
}

console.log(`\n${fail ? '✗' : '✓'} sass-media-shadow：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
