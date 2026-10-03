// ═ 首页顶带：左轮播 / 右公告栏两栏 + 公告栏纸壳（20261004 用户第十二报）══
//   node tests/home-top-band.test.mjs      （CI 秒级套件，靠 `npm test` 自动带上）
//
// 现场（用户原话）：「置顶卡片细长太丑还占一整行，改为左半部分置顶轮播图，右半部分公告栏，
// 公告栏UI符合博客设计语言」。
//
// 这一轮的改动有一个**结构性风险**：顶带那两层裁剪壳/轨道原来是**内联样式**，要搬进类名。
// 搬的过程里三件事都可能静默出错，页面都不报错：
//   ① 类名提了、内联没删 ⇒ 内联（特异性最高）照旧赢，新规则写了等于没写；
//   ② `.TopArticle` 上那条 `display: grid` 一直是被内联 `display:flex` 压着的**死声明**
//      —— 内联一搬走它就会醒来变脸（这层是网格还是弹性，决定了卡里的绝对定位件怎么排）；
//   ③ 轨道那条 `transition` 不搬进类名，reduced-motion 就永远关不掉它（本仓判过三次
//      同族案：`@media` 不改特异性、CSS 盖不动内联）。
//
// 另一半是公告栏：它**只读**。站点级"未读提醒"归 `components/AnnouncementModal`（那颗
// 「我知道了」是记已读的唯一入口）；首页这张卡点开一条只是看看，顺手标已读＝替用户表态。
// 还有"读不到 ≠ 没有"——接口失败落成空列表就是替服务端说"公告就是没有"。
// 这两条都写不坏编译、跑不红别的套件，只有源码结构拦得住。
//
// **分工**（与 `article-card-hover` / `article-grid` 那几对同构）：
//   · 几何行为（两栏底边差、宽比、点与封面中心对齐、浮层没跑出卡）由
//     `home-top-band.test.py` 在无头 Chrome 里量 —— 那支要 Playwright，进不了 CI 的秒级 job；
//   · 本套件管**结构有没有写在该在的地方**（真 sass 编译，断言落在完整选择器链上）。
//
// 媒体档的源序型/特异性型遮蔽由 `sass-media-shadow.test.mjs` 全仓扫（含本文件两个 sass），
// 这里不重复判"手机档会不会被基础规则压掉"，只判"那几条声明在不在、取值对不对"。
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sass from 'sass';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/

const HOME_SASS = path.join(root, 'src/frontHome/Content/ContentHome/index.sass');
const HOME_TSX = path.join(root, 'src/frontHome/Content/ContentHome/index.tsx');
const AB_DIR = path.join(root, 'src/frontHome/Content/ContentHome/AnnounceBoard');
const AB_TSX = path.join(AB_DIR, 'index.tsx');
const AB_SASS = path.join(AB_DIR, 'index.sass');
const ANNOUNCE_MODAL = path.join(root, 'src/components/AnnouncementModal/index.tsx');
const CN_TIME = path.join(root, 'src/utils/cnTime.ts');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const read = (p) => readFileSync(p, 'utf8');
/** 剥注释再判结构：源码注释里**逐字写着**旧写法（"原来是内联的 `borderRadius:15px`"之类），
 *  不剥的话每条负空间断言都会命中注释自己 —— 判据变成"注释里有没有这句话"。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const home = strip(read(HOME_TSX));
const ab = strip(read(AB_TSX));

let homeCss = '', abCss = '';
try {
    homeCss = sass.compile(HOME_SASS, { logger: sass.Logger.silent }).css.toString();
    abCss = sass.compile(AB_SASS, { logger: sass.Logger.silent }).css.toString();
} catch (e) {
    console.error('  ✗ FAIL: sass 编译失败 → ' + e.message);
    process.exit(1);
}

/** 编译产物 → [{media, sel, body}]。`@media` 展开一层并**保留条件串**——`sass-media-shadow`
 *  那套把媒体块摊平进同一张表的做法在这里不够用：`.TopBand` 桌面档与手机档**同名不同值**，
 *  摊平后 `decl()` 只会读到先出现的那一条（桌面），手机档断言就成了"永远绿"。 */
function flat(css) {
    // ⚠️ 先剥 CSS 注释：sass 把源文件里的大段 `/* … */` 原样吐进产物，而注释块**紧贴**在
    // 选择器前面 ⇒ 不剥的话"选择器"会变成一段注释 + 选择器（`@media` 那张脸也一样，
    // 于是整组媒体档断言全落空）。这里剥的是产物，不影响上面 `strip()` 对源码的那份。
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    let i = 0;
    for (;;) {
        const j = css.indexOf('{', i);
        if (j < 0) break;
        // `@charset "UTF-8";` 之类的序言会紧贴第一个选择器 ⇒ 取最后一个 `;` 之后那段
        // （选择器与 `@media` 条件串里都不含 `;`，这么切是安全的）
        const raw = css.slice(i, j);
        const head = raw.slice(raw.lastIndexOf(';') + 1).trim();
        let depth = 1, k = j + 1;
        while (depth && k < css.length) {
            if (css[k] === '{') depth++;
            else if (css[k] === '}') depth--;
            k++;
        }
        const body = css.slice(j + 1, k - 1);
        if (head.startsWith('@media')) {
            // ⚠️ 展开顺序不能写成 `{media: head, ...r}`：内层块的 `media` 是空串，
            // 展开会**把条件串擦掉**（初版就是这个形状，于是"768px 档"整组假红）。
            for (const r of flat(body)) out.push({ media: r.media ? `${head} and ${r.media}` : head, sel: r.sel, body: r.body });
        } else if (!head.startsWith('@')) {
            out.push({ media: '', sel: head, body });
        }
        i = k;
    }
    return out;
}

/** 选择器 → 声明体（同一档内同名出现多次时并入）
 *  `within = null` 只看**普通规则**（不在任何 `@media` 里）；传条件子串（如 `'768px'`、
 *  `'prefers-reduced-motion'`）则只看条件串里含它的那一档 —— 档与档已经分开了，
 *  所以键就用选择器本身（把条件串拼进键反而要调用方回填完整条件串，纯属自找）。 */
function makeRules(css, within = null) {
    const map = new Map();
    for (const r of flat(css)) {
        if (within === null ? r.media !== '' : !r.media.includes(within)) continue;
        map.set(r.sel, (map.get(r.sel) || '') + ';' + r.body);
    }
    return map;
}
/** 声明取值的统一入口：`media` 传条件子串（如 '768px' / 'prefers-reduced-motion'） */
function decl(css, media, sel, prop) {
    const body = makeRules(css, media).get(sel);
    if (body === undefined) return { found: false, why: '选择器不在编译产物里' };
    const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
    if (!m) return { found: false, why: prop + ' 不在这个选择器下' };
    return { found: true, value: m[1].trim() };
}
/** 允许 sass 把 `0px` 压成 `0` / 空白归一 —— 比数值别比字符串 */
const norm = (v) => String(v).replace(/\s+/g, ' ').replace(/\b0(px|em|rem)\b/g, '0').trim();
const is = (css, media, sel, prop, value, name) => {
    const d = decl(css, media, sel, prop);
    ok(d.found && norm(d.value) === norm(value), name, d.found ? d.value : d.why);
};
const has = (css, media, sel, prop, name) => {
    const d = decl(css, media, sel, prop);
    ok(d.found, name, d.why);
};
const missing = (css, media, sel, prop, name) => {
    const d = decl(css, media, sel, prop);
    ok(!d.found, name, d.found ? d.value : undefined);
};

const BAND = '.ContentContainer .TopBand';
const TOP = '.ContentContainer .TopArticle';
const TOP_CONTENT = '.ContentContainer .TopArticle .topContent';

console.log('\n① 行容器 `.TopBand`：两栏栅格 + 同高的唯一来源，行高仍是 460');
{
    is(homeCss, null, BAND, 'position', 'relative', '`position: relative`（`.topDotsContainer` 的定位上下文仍在这条链上）');
    is(homeCss, null, BAND, 'width', '90%', '宽 90%（与 `.allArticles` 对齐；旧的 80% 与网格右缘不齐）');
    is(homeCss, null, BAND, 'display', 'grid', '`display: grid`（两栏靠栅格轨道，不靠 flex-basis）');
    const cols = decl(homeCss, null, BAND, 'grid-template-columns');
    ok(cols.found && /minmax\(0,\s*1\.82fr\)\s+minmax\(0,\s*1fr\)/.test(norm(cols.value)),
        '两轨 = `minmax(0, 1.82fr) minmax(0, 1fr)`（≈64%/36%，两轨都带 `minmax(0,…)` 防内容顶开）', cols.value);
    is(homeCss, null, BAND, 'gap', '30px', '`gap: 30px`（与 `.allArticles` 同值，上下两段列距一个节奏）');
    is(homeCss, null, BAND, 'height', '460px', '`height: 460px`（首屏节奏的锚：与 20261001 第九报定下的行高一字不差）');
    is(homeCss, null, BAND, 'align-items', 'stretch', '`align-items: stretch` —— 两栏等高的**唯一来源**');
    // 行高**必须显式钉住**：隐式行是 auto = 内容 max-content ⇒ 右栏公告一多就把 460 顶穿
    // （几何套件实测塞 60 条时整行 2269px、右栏根本不滚）。钉死之后右栏才有确定高度，
    // 里面 `.abBody` 的 `flex:1 1 auto; min-height:0` 才真的封顶可滚。
    is(homeCss, null, BAND, 'grid-template-rows', '100%', '`grid-template-rows: 100%`（行高钉死 = 容器那条 460，右栏才有确定高度）');
}

console.log('\n② 左栏 `.TopArticle`：老锚点（`article-card-hover` 那批判据挂在这里）');
{
    is(homeCss, null, TOP, 'height', '460px', '桌面档仍是 `height: 460px`');
    is(homeCss, null, TOP, 'border-radius', '15px', '`border-radius: 15px` 不变（`.topCarouselViewport` 的圆角要跟它对齐）');
    is(homeCss, null, TOP, 'min-width', '0', '`min-width: 0`（栅格项能收窄的前提，否则最窄内容尺寸把轨道顶开）');
    const disp = decl(homeCss, null, TOP, 'display');
    ok(disp.found && disp.value === 'flex',
        '`display: flex` —— 是**真实生效值**（那条 `display:grid` 从来被内联压着，内联搬走就得按真值写）', disp.value);
    missing(homeCss, null, TOP, 'width',
        '★ 负空间：`.TopArticle` 上不再有 `width`（旧的 `width:80%` 与手机档 `95%` 都归 `.TopBand` 了）');
}

console.log('\n③ 手机档：叠成单列，行高交还内容（宽度也归行容器）');
{
    is(homeCss, '768px', BAND, 'grid-template-columns', '1fr', '手机档 `.TopBand` 单列 `1fr`');
    is(homeCss, '768px', BAND, 'width', '95%', '  宽度 95%（与下面的 `.allArticles` 手机档同宽）');
    is(homeCss, '768px', BAND, 'height', 'auto', '  行高 `auto`（桌面那条 460 是给两栏并排用的）');
    is(homeCss, '768px', BAND, 'grid-template-rows', 'auto', '  `grid-template-rows` 写回 `auto`（单列时容器高是 auto，百分比行高没有参照）');
    is(homeCss, '768px', BAND, 'gap', '20px', '  行距 20px');
    is(homeCss, '768px', TOP, 'height', 'auto !important', '★ `.TopArticle` 手机档 `height: auto !important`（覆盖桌面那条 460）');
    missing(homeCss, '768px', TOP, 'width',
        '  负空间：`.TopArticle` 手机档不再有 `width`（`width: 95%` 曾被桌面 `80%` 压掉，20260930 的事故记录在案）');
}

console.log('\n④ 裁剪壳 / 轨道：内联搬进类名（不搬 ⇒ reduced-motion 永远关不掉过渡）');
{
    is(homeCss, null, '.topCarouselViewport', 'width', '100%', '`.topCarouselViewport` 宽 100%');
    is(homeCss, null, '.topCarouselViewport', 'height', '100%', '  高 100%（原来内联在 JSX 上）');
    is(homeCss, null, '.topCarouselViewport', 'border-radius', '15px', '  圆角与 `.TopArticle` 的 15px 对齐（差一档封面四角就露方角）');
    is(homeCss, null, '.topCarouselViewport', 'overflow', 'hidden', '  `overflow: hidden`（裁剪壳的本职）');
    is(homeCss, null, '.topTrack', 'display', 'flex', '`.topTrack` `display: flex`');
    const tr = decl(homeCss, null, '.topTrack', 'transition');
    ok(tr.found && /transform/.test(tr.value), '★ 轨道过渡写进 CSS（这是它从内联搬出来的唯一理由）', tr.value);

    const rm = decl(homeCss, 'prefers-reduced-motion', '.ContentContainer .TopBand .TopArticle .topCarouselViewport .topTrack', 'transition');
    ok(rm.found && norm(rm.value) === 'none',
        '★ reduced-motion 档整链覆盖 `.topTrack` 的 `transition: none`（选择器全链照抄基规则 —— 媒体查询不改特异性）', rm.found ? rm.value : rm.why);

    // 负空间：内联那份不许留（留着就比类名赢）
    ok(!/borderRadius\s*:/.test(home), '★ 负空间：`index.tsx` 里不再有内联 `borderRadius`（裁剪壳那串已搬进类名）');
    ok(!/transition\s*:/.test(home), '  负空间：`index.tsx` 里不再有内联 `transition`（写内联 = 媒体档永远盖不动）');
    ok(/className="topTrack" style=\{\{\s*transform:/.test(home),
        '  只有 `transform` 留在 JSX（它的值跟着 `currentTop` 走，不属于静态形态）');
}

console.log('\n⑤ 纵向那一对 32px 与简介槽：只跟卡高挂钩，与栏宽无关');
{
    is(homeCss, null, TOP_CONTENT, 'padding', '3rem 2rem', '`.topContent` 纵向仍是 3rem，只有横向收到 2rem（栏变窄了，两件账分开记）');
    is(homeCss, null, `${TOP_CONTENT} .contentTitle`, 'margin-bottom', '32px', '`contentTitle` 的 `margin-bottom: 32px` 仍在');
    is(homeCss, null, `${TOP_CONTENT} .topFooter`, 'margin-top', '32px', '  `topFooter` 的 `margin-top: 32px` 仍在（与上一条成对，改一处就得改卡高）');
    is(homeCss, null, `${TOP_CONTENT} .contentTitle`, 'font-size', '34px', '标题 40 → 34px（文字列窄了约三成，40px 会碎成两三字一行）');
    is(homeCss, null, '.TopArticle .topContent .descSlot', 'height', '60px', '简介槽仍是 `height: 60px`（3 行 × 20px）');
    is(homeCss, null, '.TopArticle .topContent .descSlot', 'margin-bottom', '20px', '  槽的 `margin-bottom: 20px` 仍在');
    is(homeCss, null, '.TopArticle .topContent .ArticleDescription:hover', 'max-height', '200px',
        '顶卡浮层上限仍是 200px（10 行整数倍；`justify-content:center` 让槽顶随整列浮动，改字号就得复测这个数）');
}

console.log('\n⑥ DOM 结构：挂着老锚点的类名与嵌套一个都没动');
{
    ok(/<div className="TopBand" ref=\{topRef\}/.test(home), '`.TopBand` 带着 `ref={topRef}`（离屏暂停的哨兵现在量整行）');
    ok(/onMouseEnter=\{\(\) => setHoverPaused\(true\)\}/.test(home) && /onMouseLeave=\{\(\) => setHoverPaused\(false\)\}/.test(home),
        '  悬停暂停挂在 `.TopBand` 上（鼠标进右栏也该让左栏停下来）');
    ok(/<div className="TopArticle">/.test(home),
        '★ `<div className="TopArticle">` 原样（不带内联 `style` —— `display:flex`/`position:relative` 那串已删）');
    ok(/<div className="Top"><span className="TopTape">/.test(home),
        '  `.Top > .TopTape` 的嵌套原样（`home-labels` / `z-index` 用的是直接子组合器，挪层就成片失锚）');
    ok(/className="TopArticleInner"/.test(home), '  `.TopArticleInner` 仍在（`6fr 4fr` 的封面/文字两列）');

    const iTop = home.indexOf('className="TopArticle"');
    const iDots = home.indexOf('className="topDotsContainer"');
    const iBoard = home.indexOf('<AnnounceBoard');
    ok(iTop > 0 && iDots > iTop && iBoard > iDots,
        '  `.topDotsContainer` 仍在 `.TopArticle` 之内、且右栏 `.AnnounceBoard` 在它之后（两栏的先后顺序）',
        { iTop, iDots, iBoard });
    ok(/<AnnounceBoard \/>/.test(home), '  右栏渲染 `<AnnounceBoard />`');
}

console.log('\n⑦ 公告栏：三态必须分开（读不到 ≠ 没有）');
{
    ok(/import \{[^}]*getAnnouncements[^}]*\}/.test(ab), '用 `getAnnouncements()` 取数（不新开接口）');
    ok(/if \(!ok\(res\)\) \{ setState\('failed'\); return \}/.test(ab),
        '★ 只有 `ok(res)` 才认这是"公告就是这些"；否则进 `failed` 态');
    ok(/catch[\s\S]{0,120}setState\('failed'\)/.test(ab), '  抛异常同样进 `failed` 态');
    ok(!/setRows\(\[\]\)/.test(ab),
        '★ 负空间：**没有** `setRows([])` —— 任何一条失败路径都不许把"读不到"画成"没有"');
    ok(/'loading' \| 'ready' \| 'failed'/.test(ab) && /abSkeleton/.test(ab),
        '  三态齐全：`loading` 出骨架条（加载中也**不是**空态）');
    ok(/state === 'ready' && rows\.length === 0/.test(ab) && /还没有公告/.test(ab), '  `ready` 且空 → 「还没有公告」');
    ok(/state === 'failed'/.test(ab) && /公告暂时读取失败/.test(ab) && /abRetry/.test(ab),
        '  `failed` → 「公告暂时读取失败」+ 重试（与空态文案互斥）');
}

console.log('\n⑧ 公告栏：露出 5 条 + 弹窗内看全部（接口不动）');
{
    ok(/const LIST_PREVIEW = 5/.test(ab), '`LIST_PREVIEW = 5`');
    ok(/rows\.slice\(0, LIST_PREVIEW\)/.test(ab), '  列表 = `rows.slice(0, LIST_PREVIEW)`（前端切片）');
    ok(/getAnnouncements\(\)/.test(ab) && !/getAnnouncements\([^)]/.test(ab),
        '★ 负空间：调用**不带参** —— 公开接口默认全量返回是**别人依赖的语义**（`pending.ts` 吃 `list[0]`、agent 的 `get_announcements` 也读它），不给它加默认分页');
    ok(/rows\.length > LIST_PREVIEW/.test(ab) && /全部 \{rows\.length\} 条 ›/.test(ab),
        '  多于 5 条才渲染「全部 N 条 ›」入口');
    ok(/canGoBack = detail !== null && rows\.length > LIST_PREVIEW/.test(ab),
        '  「‹ 返回列表」只在从"全部"那一档进来时给（≤5 条是直接点开的，没有列表可回）');
    ok(/rows\.map\(\(row\) => \(/.test(ab), '  弹窗列表态渲染**全部** rows（不是 preview）');
}

console.log('\n⑨ 公告栏：只读 —— 不许碰任何已读状态');
{
    ok(!/washiOk/.test(ab), '★ 负空间：没有那颗 `.washiOk`（「我知道了」是记已读的唯一入口，归 `AnnouncementModal`）');
    ok(!/localStorage/.test(ab), '★ 负空间：不碰 `localStorage`（未读标记住在那儿）');
    ok(!/closedIds|markedRead|markRead|setItem/.test(ab), '  负空间：没有已读集合 / 写入调用');
    ok(/footer=\{null\}/.test(ab), '  弹窗 `footer={null}`（没有动作按钮，纯查看）');
}

console.log('\n⑩ 公告栏弹窗：Portal 出去的那层皮靠 `rootClassName` 递深浅档');
{
    ok(/useIsDarkMode\(\)/.test(ab), '用 `useIsDarkMode()` 决定深浅（`.frontDark` 在 bundle 内，但 Modal 走 Portal，够不着）');
    ok(/rootClassName=\{isDark \? 'washiModal washiDark' : 'washiModal'\}/.test(ab),
        '★ `rootClassName` 递 `washiModal[ washiDark]`（与站点级公告弹窗同一身皮）');
    ok(/import '\.\.\/\.\.\/\.\.\/\.\.\/components\/AnnouncementModal\/index\.sass'/.test(ab),
        '  皮直接复用 `components/AnnouncementModal/index.sass`（同一份 CSS 两个引用方，Vite 去重；不抽 partial）');
    ok(/zIndex=\{Z\.modal\}/.test(ab), '  与站点级公告弹窗同一档 `zIndex={Z.modal}`');
    ok(/styles=\{\{\s*header: \{ padding: '8px 28px 6px', marginBottom: 0 \},\s*body: \{ padding: '12px 28px 22px' \}/.test(ab),
        '  两处弹窗的几何逐字相同（同一张皮，顶边不该长得不一样）');
}

console.log('\n⑪ 公告栏纸壳：等高只有一个来源（行容器的 stretch），内部自己滚');
{
    is(abCss, null, '.AnnounceBoard', 'min-width', '0', '`.AnnounceBoard` `min-width: 0`（栅格项防溢出：标题长时不把列撑宽）');
    is(abCss, null, '.AnnounceBoard', 'overflow', 'visible', '  `overflow: visible`（顶上那条胶带是故意探出卡片的，hidden 会齐根切掉）');
    missing(abCss, null, '.AnnounceBoard', 'height',
        '★ 负空间：`.AnnounceBoard` 上**没有** `height` / `height:100%` —— 等高只由行容器给，两个来源并存会让溢出判定失真');
    is(abCss, null, '.abBody', 'overflow-y', 'auto', '`.abBody` 才是滚动容器（`overflow-y: auto`）');
    is(abCss, null, '.abBody', 'min-height', '0', '  `min-height: 0`（flex 子项能滚的前提，少了它最小尺寸是内容尺寸）');
    is(abCss, '768px', '.abBody', 'max-height', '300px', '手机档 `.abBody` 封顶 300px（顶带叠成单列、卡高 auto，长了在卡内滚不推长整页）');
    ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.abRow:hover/.test(abCss),
        'reduced-motion 档在文件末尾，关掉 hover 那 2px 位移');
    ok(abCss.indexOf('@media (prefers-reduced-motion: reduce)') > abCss.indexOf('.abRow:hover'),
        '★ 那块写在 `.abRow:hover` **之后**（同特异度后写者赢，落在前面会被整块静默压掉）');
}

console.log('\n⑫ 中文时间格式化：一份实现，两处共用');
{
    ok(existsSync(CN_TIME), '`src/utils/cnTime.ts` 存在');
    const cn = strip(read(CN_TIME));
    ok(/export function fmtCnTime\(/.test(cn), '  导出 `fmtCnTime`');
    ok(!/new Date\(/.test(cn), '★ 负空间：不构造 `Date` —— DB 值就是 +08:00 钟面，过一遍 Date 会二次偏移（20260922 的时区事故）');
    ok(/import \{ fmtCnTime \} from '\.\.\/\.\.\/utils\/cnTime'/.test(strip(read(ANNOUNCE_MODAL))),
        '  `AnnouncementModal` 改为引用它（两份实现必然分叉）');
    ok(!/function fmtCnTime/.test(strip(read(ANNOUNCE_MODAL))), '  负空间：`AnnouncementModal` 里不再有本地那份');
    ok(/import \{ fmtCnTime \} from '\.\.\/\.\.\/\.\.\/\.\.\/utils\/cnTime'/.test(ab),
        '  公告栏也引用同一份（列表只用 MM-DD ⇒ 传 `{ withTime: false }`）');
    ok(/withTime: false/.test(ab), '  列表确实要的是 `MM-DD`（不带时分）');
}

console.log(`\n${fail ? '✗' : '✓'} home-top-band：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
