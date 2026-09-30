// ═ 文章卡片读数：浏览 / 点赞 / 收藏（20260930）══
//   node tests/article-card-stats.test.mjs
//
// 现场（用户要求）："给文章卡片加上浏览数，点赞数，收藏数和对应图标，
//   就在卡片的图片下方那一行"。
//
// 这套件管**判据与接线**，几何那半边在 `article-card-stats.test.py`（要真浏览器量）。
// 锁三件：
//   ① ★「读不到 ≠ 0」——后端三条聚合查询只挂一条时那个键**根本不存在**，
//      显示成 0 等于在统计出故障的那天让全站文章集体谎报"0 阅读"；
//   ② 三个数**各判各的**（只挂一个也能只显示那一个），`0` 是事实照常显示；
//   ③ 接线：Article.tsx 真的用这条判据（不是自己写三个 `&&`）、图标取自 NoteStatIcons
//      （不再是第二个眼睛 SVG 副本）、且**没有行内写死颜色**（夜间模式的第一号坑）。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

// noteStats.ts 只 `import type`（纯 TS，无 DOM 无 React）⇒ 直接摊平后 import
const out = mkdtempSync(path.join(tmpdir(), 'notestats-'));
const file = path.join(out, 'noteStats.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/noteStats.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const M = await import(pathToFileURL(file).href);

const keys = (item) => M.statCells(item).map((c) => c.key);
const vals = (item) => M.statCells(item).map((c) => c.value);

console.log('\n① 读不到 ≠ 0：键缺席 / null / 非数字 都不产生那一格');
{
    ok(M.statCells({}).length === 0, '空对象 ⇒ 一个数都不显示');
    ok(keys({ views: undefined, likes: null, favorites: undefined }).length === 0,
        'undefined / null ⇒ 不显示（**不是 0**）');
    ok(M.statCells(null).length === 0 && M.statCells(undefined).length === 0, 'null / undefined 入参 ⇒ 空数组');
    ok(keys({ views: '0' }).length === 0, '字符串 "0" 也当"没有"（类型变了宁可少显示一个数）');
    ok(keys({ views: NaN }).length === 0, 'NaN ⇒ 不显示（Infinity 同理）');
    ok(keys({ views: Infinity }).length === 0, 'Infinity ⇒ 不显示');
}

console.log('\n② 0 是事实，照常显示；三个数各判各的');
{
    ok(JSON.stringify(vals({ views: 0, likes: 0, favorites: 0 })) === '[0,0,0]',
        '三个 0 ⇒ 显示三个 0（新站上线第一天就是这样，不能空着）', vals({ views: 0, likes: 0, favorites: 0 }));
    ok(keys({ views: 12 }).join() === 'views', '只挂了阅读 ⇒ 只显示阅读那一格');
    ok(keys({ views: 12, likes: 3, favorites: undefined }).join() === 'views,likes',
        '挂两个、缺一个 ⇒ 显示两个（一个缺席不影响另外两个）');
    const long = M.statCells({ views: 1, likes: 2, favorites: 3 });
    ok(long.every((c) => typeof c.label === 'string' && c.label.length > 0),
        '每格都带人读标签（同时用作 title 悬停说明）', long.map((c) => c.label));
    ok(M.statCells({ favorites: 5, views: 1, likes: 2 }).map((c) => c.key).join() === 'views,likes,favorites',
        '顺序恒为 阅读→点赞→收藏（与卡片上的一致，不受对象键序影响）');
}

console.log('\n③ 接线：Article.tsx 用这条判据，图标与颜色都不各写一份');
{
    /**
     * 断言前先把块注释去掉：这几个文件的**头注本身就在讲**这件事（"不要用 emoji 👁"、
     * "颜色一律 currentColor"、"不如三个 <svg> 直接"）——拿全文去数会把自己的说明文字
     * 数进去，判据变成"注释怎么写"而不是"代码怎么写"。
     */
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const read = (p) => stripComments(readFileSync(path.join(root, p), 'utf8'));

    const src = read('src/frontHome/Content/ContentHome/Article.tsx');
    ok(/statCells\(item\)/.test(src), '卡片调的是 statCells()（唯一判据），不是自己写三个 &&');
    ok(!/typeof item\.(views|likes|favorites)/.test(src), '卡片里没有第二份 typeof 判据');
    ok(/from\s*["'][^"']*components\/NoteStatIcons/.test(src), '图标取自 NoteStatIcons');
    ok(/STAT_ICON/.test(src) && /ArticleStatNum/.test(src), '渲染 .ArticleStat / .ArticleStatNum（几何套件量的是这两个类）');
    // 夜间模式第一号坑：行内 style 特异性最高，`.dark &` 赢不了（见 CLAUDE.md 的记录）
    ok(!/ArticleStat[^>]*style=\{\{/.test(src), '读数格子不写行内 style（配色交给 .ArticleStats 的主题变量）');

    const icons = read('src/components/NoteStatIcons/index.tsx');
    ok((icons.match(/<svg/g) || []).length === 3, '三个图标都是 svg（不是 emoji / 字体图标）',
        (icons.match(/<svg/g) || []).length);
    ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(icons), '图标文件里没有 emoji / 符号字形');
    ok((icons.match(/currentColor/g) || []).length === 3, '三个图标都吃 currentColor（颜色由调用方定）',
        (icons.match(/currentColor/g) || []).length);
    ok(!/#[0-9a-fA-F]{3,6}/.test(icons), '图标文件里没有写死颜色');

    // 详情页那只眼睛必须与卡片同源（否则又会退化成"两处各写一份、改一处忘一处"）
    const readArt = read('src/frontHome/Content/ReadArticle/index.tsx');
    ok(/from\s*["'][^"']*components\/NoteStatIcons/.test(readArt), '详情页的眼睛也取自 NoteStatIcons');
    ok(!/M1\.8 12S5\.6 5\.5 12 5\.5/.test(readArt), '详情页里没有第二份眼睛路径副本');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
