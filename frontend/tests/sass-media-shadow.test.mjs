// ═ 编译产物扫描：媒体查询里的声明不许被**后面**同选择器的普通规则压掉（20260930）══
//   node tests/sass-media-shadow.test.mjs      （CI 秒级套件，靠 `npm test` 自动带上）
//
// 症状：整档手机档 / reduced-motion 档**静默失效**——页面不报错、控制台不说话、别处的
// 判据照样绿，只是那一档的样式没生效。属于本仓反复吃亏的那一类「写了但没接上」。
//
// 机制：sass 把嵌套的 `@media` 按**源码位置**原样吐进编译产物，块里的选择器与外面那条
// 父规则是同一个选择器、同一特异度 ⇒ 谁在后面谁赢。于是"把手机档写在父规则声明之前"
// 就等于没写。修改方式永远是把那段挪到父规则**声明之后**，不是加 `!important`。
//
// 20260930 当天在本仓抓到两处，都是真缺陷不是理论风险：
//   · `ContentHome/index.sass` 的 `.SelfDescription` 手机档：`padding` / `gap` /
//     `justify-content` 全被父规则压掉 ⇒ 375px 下内边距实测仍是桌面的
//     `112px 6% 148px 8%`、文字与手账内页的间距是 48px 不是 28px；
//   · 同文件 `.TopArticle` 手机档：`width: 95%` 被父规则的 `width: 80%` 压掉
//     ⇒ 手机上置顶卡比普通卡（后段 `.allArticles` 那条 95%）窄一圈，两边对不齐。
// 两处都不是"看得出来的错"，是逐像素量几何 + 出图核对时才发现的。
//
// 判据：对每个 `@media` 块里的每条规则，找出**同选择器**的普通规则中出现在它**之后**、
// 且声明了同一个属性的那些 ⇒ 该属性被判死。带 `!important` 的媒体声明只有被后面同样
// 带 `!important` 的普通规则压掉才算死（`!important` 不受源序影响）。
//
// 已知盲区（写在这里，免得下次当成判据漏了）：
//   ① 只与**普通规则**比：两条媒体档互相压（例如后段一条 `display: block !important`
//      压掉前段的 `display: flex`）看不出来——那种靠源码注释管；
//   ② `@supports` / `@keyframes` 块整体跳过（只会漏报，不会误报）；
//   ③ 不判 `@layer`（本仓没用）。
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

/** → [[选择器, [被判死的属性…]], …] */
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

console.log('\n① 判据自带牙：喂一份"父规则写在媒体档后面"的样本，必须被报出来');
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

console.log('\n② 全仓扫描：`src/**/*.sass` 与 `src/**/*.css` 的编译产物里不许有这个形状');
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

    const hits = [];
    const skipped = [];
    for (const f of files.sort()) {
        let css;
        // 逐文件静音 logger：全仓扫描会把每条 warning 都刷一遍（`.phoneSide` 那条空规则
        // 之类），而这里要看的是命中清单
        const silent = f.endsWith('.css') ? null : { logger: sass.Logger.silent };
        try {
            css = f.endsWith('.css')
                ? readFileSync(f, 'utf8')
                : sass.compile(f, silent).css.toString();
        } catch (e) {
            skipped.push(path.relative(root, f) + '：' + String(e.message).split('\n')[0]);
            continue;
        }
        for (const [sel, dead] of shadowedDecls(css)) {
            hits.push(`${path.relative(root, f)}  ${sel}  →  ${dead.join(', ')}`);
        }
    }

    ok(skipped.length === 0, '每个样式文件都能单独编译（编译不过 = 判据对它失效）', skipped);
    if (hits.length) {
        console.log('    下面这些媒体档声明**不会生效**（把那段挪到父规则声明之后即可）：');
        for (const h of hits) console.log('      · ' + h);
    }
    ok(hits.length === 0, `全仓零命中（当前 ${files.length} 个文件）`, hits);
}

console.log(`\n${fail ? '✗' : '✓'} sass-media-shadow：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
