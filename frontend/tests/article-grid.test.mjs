// ═ 文章网格：一格一张卡 · 卡必须填满那一格（20261001 九轮）══
//   node tests/article-grid.test.mjs      （CI 秒级套件，靠 `npm test` 自动带上）
//
// 现场（用户第六报）：「某些分辨率下会出现文章卡片大小不一。」
//
// 根因是量出来的（真 sass + 真 Chromium 逐档扫 375→2560，见 `article-grid.test.py`）：
//   `.allArticles` 是网格、`.article` 是 `display: flex` —— 但那条 flex 只为**纵轴**而写
//   （同行卡片拉齐到整行高），横轴上谁也没说话。于是卡按 `flex-basis: auto` 取**内容宽度**：
//   内容比格子宽的卡被压回格子宽，内容短的卡就停在原地 ⇒ 同一排里窄一截。
//   实测修复前：1440 屏三列（格子 412px）时，短标题 + 空简介那张只有 265px；
//   1280 屏同一排里出现过三种宽度（265 / 344 / 364）。
//
// **分工**（与 `article-card-hover` 那对同构）：
//   · 几何行为（每一档视口下同排是否等宽、卡宽是否等于轨道宽、负空间）由
//     `article-grid.test.py` 在无头 Chrome 里量 —— 那支要 Playwright，进不了 CI 的秒级 job；
//   · 本套件管**结构有没有写在该在的地方**：`flex: 1 1 auto` 这条声明少一次，页面不报错、
//     只是静默回到"按内容宽度排版"，只有拿尺子量才看得见。CI 每天都能跑的就是这一半。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sass from 'sass';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SASS_FILE = path.join(root, 'src/frontHome/Content/ContentHome/index.sass');

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

/** 选择器 → 声明块（同名选择器出现多次时并入，顺便能看出重复定义） */
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
    return { found: true, value: m[1].trim(), match: value === undefined || m[1].trim() === value };
};

const CARD = '.ContentContainer .allArticles .ArticleCard';
const ITEM = '.ContentContainer .allArticles > .article';

console.log('\n① 卡要填满网格格子的**主轴**（`flex: 1 1 auto` —— 这一条就是用户报的那条）');
{
    // `.article` 是 flex 行容器：纵轴（等高）由它管，横轴得靠卡自己长满。
    // 少了这条，卡宽 = **内容宽度**（`flex-basis: auto`）⇒ 内容短的卡窄一截。
    const f = decl(CARD, 'flex');
    ok(f.found && /^1\s+1\s+auto$/.test(f.value),
        '普通卡：`flex: 1 1 auto`（主轴长满格子，宽度只由列数决定、与卡里写了什么无关）', f);
    // ⚠️ 反面：任何一条作用在 `.ArticleCard` 上的 `flex` / `flex-grow` 都不许把 grow 写成 0
    // ——手机档那种"给卡换成别的排版"的覆盖最容易顺手写成 `flex: 0 1 auto`（= 初始值，
    // 也就是这个缺陷本身），写下来就静默回退，页面照样不报错。
    const bad = [];
    for (const [sel, body] of rules) {
        if (!/\.ArticleCard$/.test(sel)) continue;
        for (const m of body.matchAll(/(?:^|;)\s*(flex|flex-grow)\s*:\s*([^;]+)/gi)) {
            const v = m[2].trim();
            const grow = m[1].toLowerCase() === 'flex-grow' ? parseFloat(v)
                : (v.startsWith('none') || v === 'initial' ? 0 : parseFloat(v));
            if (grow === 0) bad.push(`${sel} { ${m[1]}: ${v} }`);
        }
    }
    ok(bad.length === 0, '没有任何一条 `.ArticleCard` 规则把 flex-grow 写成 0（含手机档覆盖）', bad);
}

console.log('\n② 纵轴那条老契约仍在（改宽度别把等高/轨道一起带歪）');
{
    const d = decl(ITEM, 'display', 'flex');
    ok(d.found && d.match,
        '`.article` 仍是 `display: flex`（同行卡片被拉伸到**整行高**的支点）', d);
    const mw = decl(ITEM, 'min-width', '0');
    ok(mw.found && mw.match,
        '`.article` 仍 `min-width: 0`（否则长分类名会把轨道下限顶上去、轨道比邻居宽）', mw);
    const cmw = decl(CARD, 'min-width', '0');
    ok(cmw.found && cmw.match, '`.ArticleCard` 仍 `min-width: 0`（内容不顶住格子）', cmw);
    // 封面在手机档被写成 `width: 100% !important` —— 那条是**格子内**的百分比、
    // 与卡自己填不填满主轴是两件事，别把两者混成一条改法。
    const src = readFileSync(SASS_FILE, 'utf8');
    ok(/\.ArticleCard\b/.test(src) && /flex: 1 1 auto/.test(src),
        '源码里那条声明是字面 `flex: 1 1 auto`（改写法之前先看 `article-grid.test.py`）');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
