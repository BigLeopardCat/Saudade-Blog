// ═ 首页每页条数：窄屏一次给四行（20261006 用户第 5 条）══
//   node tests/home-paging.test.mjs      （CI 秒级套件，靠 `npm test` 自动带上）
//
// 现场（用户原话）：「在移动端点 MORE 按钮文章卡片只多加载两行，让人很容易失去耐心，
// 一次加载卡片数量太少」。
//
// 这个数**不是配置项、是算出来的**：`ContentHome/index.tsx` 的 `colsOf()` 量出栅格真实
// 列数，`pageSizeFor(cols)` 再按列数折算 —— 所以"一次几张"在手机上等于"一次几行 × 2 列"，
// 写死一个 8 会在换断点/换列数的那天静默错位。本套件因此**执行那个真表达式**（把它从
// 源码里抠出来求值），而不是核对"源码里有没有 8 这个字面量"。
//
// 分工与本仓其它套件一致：
//   · 栅格几何（列宽、同排等宽）由 `article-grid.test.py` 量；
//   · 这里管**折算规则**与它的**前提**——前提之一（手机档是 2 列）住在 `index.sass` 里，
//     判据在这边就得**连前提一起看着**：哪天手机档改成 3 列，"8 张 = 四行"这句话就失效了，
//     而代码一个字都不用改（同族教训：判据的前提住在别人手里，搬家时没人提醒）。
//
// 为什么要抠出来求值而不是只做正则：`cols <= NARROW_COLS ? NARROW_ROWS : DESKTOP_ROWS`
// 这种式子写错了（比如三元两头调换、或漏掉 `Math.min` 钳位）在源码里**长得仍然很像**，
// 只有把它跑一遍才知道 2 列的屏到底会拉几张。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/
const HOME_TSX = path.join(root, 'src/frontHome/Content/ContentHome/index.tsx');
const HOME_SASS = path.join(root, 'src/frontHome/Content/ContentHome/index.sass');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 剥注释：下面既要"读出常量值"又要判"有没有第二处折算"，
 *  注释里逐字写着用户原话与旧写法，不剥就会量到注释自己。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const tsx = strip(readFileSync(HOME_TSX, 'utf8'));
const sass = strip(readFileSync(HOME_SASS, 'utf8'));

/** 从源码里读一个 `const NAME = 数字;`。读不出一律 null —— 后面的断言会当场报出来，
 *  不会拿一个假的值继续算（"缺键绝不编 0"）。 */
const numConst = (name) => {
    const m = tsx.match(new RegExp(`const ${name} = (\\d+);`));
    return m ? Number(m[1]) : null;
};

/** 把 `pageSizeFor` 的**函数体表达式原文**抠出来（`=>` 之后、下一个顶格语句之前）。 */
function pageSizeExpr() {
    const lines = tsx.split('\n');
    const head = lines.findIndex((l) => l.startsWith('const pageSizeFor'));
    if (head < 0) return null;
    const body = [];
    for (const l of lines.slice(head + 1)) {
        if (l.trim() !== '' && !/^\s/.test(l)) break;   // 顶格 ⇒ 下一个顶层语句
        body.push(l);
    }
    const expr = body.join('\n').trim();
    return expr || null;
}

const expr = pageSizeExpr();
const FALLBACK = numConst('FALLBACK_PAGE_SIZE');
const MAXP = numConst('MAX_PAGE_SIZE');
const DROWS = numConst('DESKTOP_ROWS');
const NCOLS = numConst('NARROW_COLS');
const NROWS = numConst('NARROW_ROWS');

/** 用源码里读到的常量把真表达式装成一个可调用的函数（表达式里引用的名字就是这些）。 */
const buildPageSizeFor = (source) => new Function(
    'FALLBACK_PAGE_SIZE', 'MAX_PAGE_SIZE', 'DESKTOP_ROWS', 'NARROW_COLS', 'NARROW_ROWS',
    `return (cols) => ${source}`,
)(FALLBACK, MAXP, DROWS, NCOLS, NROWS);

console.log('\n① 把真表达式从源码里抠出来（抠不到就不算测过）');
ok(expr !== null, '从 `ContentHome/index.tsx` 读到了 `pageSizeFor` 的实现', expr);
ok([FALLBACK, MAXP, DROWS, NCOLS, NROWS].every((v) => typeof v === 'number' && v > 0),
    '五个常量都读出来了（回退值 / 上限 / 桌面行数 / 窄屏列数 / 窄屏行数）',
    { FALLBACK_PAGE_SIZE: FALLBACK, MAX_PAGE_SIZE: MAXP, DESKTOP_ROWS: DROWS, NARROW_COLS: NCOLS, NARROW_ROWS: NROWS });

if (expr === null || [FALLBACK, MAXP, DROWS, NCOLS, NROWS].some((v) => !v)) {
    console.log('\n✗ 首页分页条数：读不到实现，后续断言无法进行');
    process.exit(1);
}

const pageSizeFor = buildPageSizeFor(expr);
/** 手机档的列数 = `index.sass` 手机档写死的那个数（下面的前提断言会核对它还是 2）。 */
const MOBILE_COLS = 2;

console.log('\n② 窄屏一次四行（用户第 5 条的主判据）');
{
    ok(pageSizeFor(MOBILE_COLS) === MOBILE_COLS * NROWS,
        `2 列的手机一页 ${MOBILE_COLS * NROWS} 张 = 四行（从前是 ${MOBILE_COLS * DROWS} 张两行）`,
        { got: pageSizeFor(MOBILE_COLS), want: MOBILE_COLS * NROWS });
    ok(pageSizeFor(MOBILE_COLS) === 8, '就是用户看到的那个数：一次多加载 8 张', pageSizeFor(MOBILE_COLS));
    ok(NROWS === 4, '`NARROW_ROWS` = 4（改它是允许的，但上面两条会跟着报出新数）', NROWS);
    // 单列（比手机更窄的档，比如极窄视口退化成一列）：仍按"四行"算 ⇒ 4 张。
    // 这里不钉 4 这个数，钉的是"只跟行数有关、不跟列数乘第二遍"。
    ok(pageSizeFor(1) === NROWS * 1, '一列的档 = 一行一张 × 四行', pageSizeFor(1));
}

console.log('\n③ 桌面档不受影响（仍是两行）');
{
    for (const cols of [3, 4, 5, 6]) {
        ok(pageSizeFor(cols) === cols * DROWS,
            `${cols} 列 ⇒ ${cols * DROWS} 张（两行）`, pageSizeFor(cols));
    }
    ok(pageSizeFor(NCOLS + 1) === (NCOLS + 1) * DROWS,
        `窄屏那一档只吃 ${NCOLS} 列及以下：${NCOLS + 1} 列已经按桌面两行算`,
        pageSizeFor(NCOLS + 1));
}

console.log('\n④ 边界：量不到列数走回退、超宽钳在上限');
{
    ok(pageSizeFor(0) === FALLBACK, '0 列（容器没量出来）⇒ 回退值', pageSizeFor(0));
    ok(pageSizeFor(NaN) === FALLBACK, 'NaN ⇒ 回退值', pageSizeFor(NaN));
    ok(pageSizeFor(-1) === FALLBACK, '负数（脏读数）⇒ 回退值', pageSizeFor(-1));
    ok(pageSizeFor(Infinity) === FALLBACK, 'Infinity ⇒ 回退值（不做成"一次拉全部"）', pageSizeFor(Infinity));
    ok(pageSizeFor(100) === MAXP && pageSizeFor(1000) === MAXP,
        `列数再大也钳在 ${MAXP} 张（后端 PageQuery 是 clamp(1,1000)，前端别自己冲上去）`,
        { 100: pageSizeFor(100), 1000: pageSizeFor(1000) });
    ok(MAXP >= MOBILE_COLS * NROWS * 2,
        '上限至少是窄屏一页的两倍（否则"窄屏四行"在超宽列数下会被钳回两行）', MAXP);
}

console.log('\n⑤ 前提：手机档真的是 2 列（这条住在 index.sass，不在这页 TSX 里）');
{
    // 判据的前提搬到别人家里 —— 手机档哪天改成 3 列，"8 张 = 四行"就不成立了，
    // 而 TSX 一个字都不用改。所以在这里就地看一眼。
    const mobile = sass.match(/@media screen and \(max-width: 768px\)[\s\S]*?\.allArticles\s*\n\s*grid-template-columns:\s*repeat\((\d+),\s*1fr\)/);
    ok(!!mobile, '在手机档（≤768px）里找到了 `.allArticles` 的列数声明', mobile && mobile[0].slice(-60));
    ok(mobile && Number(mobile[1]) === MOBILE_COLS,
        `手机档就是 ${MOBILE_COLS} 列 ⇒「一页 8 张」读作四行这句话才成立`,
        mobile && mobile[1]);
}

console.log('\n⑥ 接线：首屏与 MORE 用同一个折算，没有第二处"每页几张"');
{
    // `pageSizeFor(` 只数**调用**：定义那一处写的是 `const pageSizeFor = (cols…`，不含这个串。
    const calls = [...tsx.matchAll(/pageSizeFor\(/g)].length;
    ok(tsx.includes('const pageSizeFor = (cols: number): number =>'),
        '折算仍然是这一个纯函数（不是散在各处的表达式）');
    ok(calls === 2, '调用恰好 2 处（首屏 fetchFirst 与列数变化回调），没有第三处自己算条数', calls);
    ok(/pageSizeFor\(colsOf\(measureRef\.current\)\)/.test(tsx),
        '首屏走 `pageSizeFor(colsOf(...))`');
    ok(/const ps = pageSizeFor\(colsOf\(el\)\)/.test(tsx),
        '列数变化时走同一个函数（拆成两个条数会让已渲染条数与页偏移错位）');
    ok(!/\b(pageSize|per_page)\s*[:=]\s*\d+\b/.test(tsx.replace(/cachedPageSize\s*=\s*FALLBACK_PAGE_SIZE/g, '')),
        '没有把"每页几张"再写死成一处的数字（缓存初值那次例外，它用的是 FALLBACK 常量）');
}

console.log('\n⑦ 负控：把窄屏那一档摘掉，① ② 的断言必须变红（判据没牙 = 没测）');
{
    // 把三元里"窄屏给四行"那半摘掉（留着桌面那半），模拟"有人把这一轮改回去了"。
    const patch = expr.replace(/cols\s*<=\s*NARROW_COLS\s*\?\s*NARROW_ROWS\s*:\s*/,'');
    ok(patch !== expr, '负控真的改动到了源码表达式（改不动说明形状变了，这条负控本身要修）', patch);
    const before = buildPageSizeFor(patch);
    ok(before(MOBILE_COLS) === MOBILE_COLS * DROWS,
        '摘掉之后手机档掉回两行 ⇒ ② 里那两条会转红', before(MOBILE_COLS));
    ok(before(MOBILE_COLS) !== pageSizeFor(MOBILE_COLS),
        '两版在手机档上的读数不同（这正是那两条断言量的东西）',
        { 改前: before(MOBILE_COLS), 改后: pageSizeFor(MOBILE_COLS) });
    ok(before(4) === pageSizeFor(4), '桌面档两版一致 ⇒ ② 的断言量的确实是窄屏那一档', before(4));
}

console.log(`\n${pass}/${pass + fail} 项通过`);
if (fail > 0) process.exit(1);
