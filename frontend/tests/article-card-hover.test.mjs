// ═ 文章卡片悬浮简介 / 页脚钉底 · 源码与 sass 结构契约（20260930）══
//   node tests/article-card-hover.test.mjs      （CI 秒级套件，靠 `npm test` 自动带上）
//
// 现场（用户一次报的三条）：
//   1. 分类行与封面的空隙要缩小；"卡片底部的作者署名头像和发布修改时间"要**定死在卡底**；
//   2. 悬浮展开简介：最后一行只露上半；简介滚过之后再移开，静置态停在全文**中段**；
//   3. 置顶卡悬浮标题/简介会抖动布局，且它没有悬浮展开。
//
// 布局行为（几何、真事件）由 `article-card-hover.test.py` 在无头 Chrome 里量——那支要
// Playwright，进不了 CI 的秒级 job。**本套件管的是另一半：结构有没有写在该在的地方。**
// 这两类缺陷都曾经真实发生过，且都是"页面不报错、只是静默失效"：
//   · 类名/结构对不上（sass 写了 `.descSlot`、tsx 没挂 → 页脚照旧跑）；
//   · sass 缩进错一级（真 sass 编译，断言规则落在**完整选择器链**上）；
//   · 有人"顺手"把已删的规则加回来（标题 `:hover` 解除行数限制 = 抖动源；
//     裸 `.ArticleDescription:hover` 的 `padding-bottom: 10px` = 半行源）。
//
// 最后一条尤其要留着：那条裸规则**不是废弃代码**——它的 max-height/overflow 被嵌套规则
// 压掉了，但 `padding-bottom` 谁也没声明过，于是一直生效：展开盒高 = 内容 + 10，
// 而 `box-sizing: border-box` 让上限（当年 200px）里只剩 190px 给正文 ⇒ 第 10 行切一半。
// 是 `.test.py` 里读出 `padding-bottom` 非 0 才回头找到它的。
//
// 20260930 二轮（用户："卡片比例有点不好看，重新调整卡片样式"）：封面 200→240、
// 卡片下限 600→**520**、普通卡展开上限 200→**140**（7 行）——三个数联动，本套件底部
// 两条断言跟着改。**判据别只改数字**：`140` 必须仍是 `line-height: 20px` 的整数倍
// （半行 = 用户报过的"最后一行只露上半"，见第 ③ 组）。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sass from 'sass';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/
const repo = path.resolve(root, '..');            // 仓库根（Rust 在那儿）

const SASS_FILE = path.join(root, 'src/frontHome/Content/ContentHome/index.sass');
const ARTICLE_TSX = path.join(root, 'src/frontHome/Content/ContentHome/Article.tsx');
const HOME_TSX = path.join(root, 'src/frontHome/Content/ContentHome/index.tsx');
const WEB_INFO_RS = path.join(repo, 'src/routes/web_info.rs');

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
/** 允许 sass 把 `0px` 压成 `0`（数值相等即算match，别拿字符串比长度单位） */
const declNum = (sel, prop, num) => {
    const r = decl(sel, prop);
    return {...r, match: r.found && parseFloat(r.value) === num};
};

const CONTENT = '.ContentContainer .allArticles .ArticleCard .ArticleContent';
const SLOT = CONTENT + ' .descSlot';
const DESC = CONTENT + ' .ArticleDescription';
const TOP_SLOT = '.TopArticle .topContent .descSlot';
const TOP_DESC = '.TopArticle .topContent .ArticleDescription';

console.log('\n① 定高槽：两张卡都要有（页脚定死在卡底的**唯一**支点）');
{
    for (const [name, sel] of [['普通卡', SLOT], ['置顶卡', TOP_SLOT]]) {
        const p = decl(sel, 'position', 'relative');
        ok(p.found && p.match, `${name}：${sel} 存在且 position: relative（简介的定位基准）`, p);
        const h = decl(sel, 'height', '60px');
        ok(h.found && h.match, `  height: 60px = 3 行 × 行高 20px`, h);
    }
    // 普通卡的槽还要能抗 flex 收缩：槽位一变压的就是简介的顶
    const fs = decl(SLOT, 'flex-shrink', '0');
    ok(fs.found && fs.match, '普通卡：槽 flex-shrink: 0（内容区余量不够时不许压槽）', fs);
    // 顶卡那 20px 原本是简介的行内 marginBottom（内联样式会压掉绝对定位方案），现在归槽管
    const mb = decl(TOP_SLOT, 'margin-bottom', '20px');
    ok(mb.found && mb.match, '置顶卡：槽 margin-bottom: 20px（原本那 20px 间距搬到这里）', mb);
}

console.log('\n② 简介在槽内绝对定位：长高不参与布局（展开/收回都不许撑动后面的东西）');
{
    for (const [name, sel] of [['普通卡', DESC], ['置顶卡', TOP_DESC]]) {
        const p = decl(sel, 'position', 'absolute');
        ok(p.found && p.match, `${name}：${sel} 是 position: absolute`, p);
        const t = declNum(sel, 'top', 0);
        ok(t.match, `  top: 0（贴槽顶向下长）`, t);
        const l = declNum(sel, 'left', 0);
        ok(l.match, `  left: 0`, l);
    }
    // 反面：绝对定位的盒子拿不到 `width: 100%` 就会收缩成长条（顶卡没有 right 约束）
    const w = decl(TOP_DESC, 'width', '100%');
    const wBase = rules.get('.ArticleDescription') || '';
    ok(w.match || /width\s*:\s*100%/.test(wBase),
        '顶卡简介有确定的宽度（绝对定位 + 无 right ⇒ 不写宽度就会缩成一条）', w);
}

console.log('\n③ 展开态：上限是行高整数倍，且**不许**再用负 margin / padding 当支点');
{
    const hoverNormal = decl(DESC + ':hover', 'max-height', '140px');
    ok(hoverNormal.found && hoverNormal.match, `普通卡：:hover 上限 140px（7 行）`, hoverNormal);
    const hoverTop = decl(TOP_DESC + ':hover', 'max-height', '240px');
    ok(hoverTop.found && hoverTop.match, `置顶卡：:hover 上限 240px（12 行）`, hoverTop);
    for (const [name, sel] of [['普通卡', DESC], ['置顶卡', TOP_DESC]]) {
        const body = rules.get(sel + ':hover') || '';
        ok(!/margin-bottom\s*:\s*-/.test(body),
            `${name}：展开态没有负 margin（那套方案在"够不到上限"时会把页脚抽走）`, body.slice(0, 80));
        ok(!/padding-bottom\s*:\s*(?!0)\d/.test(body),
            `${name}：展开态没有非 0 的 padding-bottom（border-box 下它会吃掉正文高度 ⇒ 半行）`,
            body.slice(0, 80));
        ok(/overflow-y\s*:\s*auto/.test(body), `${name}：展开态可滚动（全文更长时给滚动而不是裁掉）`);
    }
    // 半行源的**根**：裸规则那条 hover 必须不存在（它只在 padding-bottom 上生效）
    ok(!rules.has('.ArticleDescription:hover'),
        '没有裸 `.ArticleDescription:hover`（那条规则的 padding-bottom 会静默生效）');
    for (const sel of [...rules.keys()]) {
        if (!sel.includes('ArticleDescription:hover')) continue;
        ok(!/padding-bottom/.test(rules.get(sel)),
            `  ${sel} 里没有 padding-bottom`, rules.get(sel).slice(0, 60));
    }
}

console.log('\n④ 两处抖动源保持删除：标题的 :hover 不许解除行数限制');
{
    // 顶卡内容列是 `justify-content: center`：标题一变高，整列重新居中 ⇒ 全列上下窜。
    // 这两条选择器一旦回来，`.test.py` 的第 ⑥ 组会立刻红，这里在源码层先拦一道。
    const bad = [...rules.keys()].filter((s) => /:hover/.test(s) && /(contentTitle|topContent h3)/.test(s));
    ok(bad.length === 0, '没有 `.contentTitle:hover` / `.TopArticle .topContent h3:hover`', bad);
    const sassSrc = readFileSync(SASS_FILE, 'utf8');
    // 源码层：这两块里不许再出现 `-webkit-line-clamp: unset`（唯一合法出现处是简介的展开态）
    const titleBlocks = sassSrc.split(/\n(?= {0,4}[.\w:-])/).filter((b) => /contentTitle|topContent\n\s{2,}h3/.test(b));
    ok(!titleBlocks.some((b) => /-webkit-line-clamp:\s*unset/.test(b)),
        '标题那两块源码里没有 `-webkit-line-clamp: unset`');
}

console.log('\n⑤ 源码接线：槽挂在两张卡的 JSX 上，mouseleave 接的是同一个实现');
{
    const article = readFileSync(ARTICLE_TSX, 'utf8');
    const home = readFileSync(HOME_TSX, 'utf8');
    ok(/import\s*\{\s*resetDescScroll\s*\}\s*from\s*"\.\.\/\.\.\/\.\.\/utils\/descHover"/.test(article),
        'Article.tsx 从 utils/descHover 引了 resetDescScroll（别再来一份实现）');
    ok(/<div className="descSlot">\s*<p className="ArticleDescription" onMouseLeave=\{resetDescScroll\}>/.test(article),
        'Article.tsx：descSlot 包着简介，且简介挂着 onMouseLeave', article.match(/descSlot[\s\S]{0,200}/)?.[0]);
    ok(/<div className="descSlot">\s*<div className="ArticleDescription" onMouseLeave=\{resetDescScroll\}>/.test(home),
        'index.tsx（置顶卡）：descSlot 包着简介，且简介挂着 onMouseLeave');
    // 内联样式特异性最高：顶卡简介上再写行内 margin 就会和槽的方案打架
    const topDescTag = home.match(/<div className="ArticleDescription"[^>]*>/)?.[0] || '';
    ok(topDescTag !== '' && !/style=/.test(topDescTag),
        '置顶卡简介上没有行内 style（内联样式会压过槽的定位/间距）', topDescTag);
    // 类名对齐：sass 有 `.descSlot`、JSX 也挂着 `descSlot`——两边任一漏掉就是静默失效
    ok(/descSlot/.test(css) && /descSlot/.test(article) && /descSlot/.test(home),
        'descSlot 这个类名三处一致（sass / Article.tsx / index.tsx）');
}

console.log('\n⑥ 手机档：槽要跟着缩小（桌面那 60px 会让移动卡片白多一截空档）');
{
    // 直接在整份编译产物里捞（同一个选择器在多档里重复出现会被 rules 合并，逐条查会漏）
    const importantHeights = [...css.matchAll(/descSlot[^{]*\{([^}]*)\}/g)]
        .flatMap((m) => [...m[1].matchAll(/height\s*:\s*([\d.]+)px\s*!important/g)].map((x) => parseFloat(x[1])));
    ok(importantHeights.length >= 3,
        '移动档有 3 处 descSlot 高度覆盖（普通卡两档 + 顶卡一档）', importantHeights);
    ok(importantHeights.length > 0 && importantHeights.every((h) => h < 60),
        '  每一处都 < 60px（手机档简介只有 2 行，槽留桌面那 60px 就是白多一截空档）', importantHeights);
}

console.log('\n⑦ 署名取昵称（用户点名"卡片上的 Sora 换成真正发布作者的昵称"）');
{
    const rs = readFileSync(WEB_INFO_RS, 'utf8');
    const seg = rs.match(/let author =[\s\S]{0,240}?;/)?.[0] || '';
    ok(/nickname/.test(seg), 'web_info.rs 的 author 取自 uid=1 的 nickname', seg);
    ok(/get_val\("author"\)/.test(seg), '  nickname 为空时回退站点设置的 author 键', seg);
    ok(!/username/.test(seg), '  刻意**不**回退到 username（那是登录账号，不印在公开卡片上）', seg);
    const avatarSeg = rs.match(/let avatar =[\s\S]{0,240}?;/)?.[0] || '';
    ok(/u\.avatar/.test(avatarSeg) && /get_val\("avatar"\)/.test(avatarSeg),
        '头像同一条链：user.avatar 优先、web_info.avatar 回退', avatarSeg);
}

console.log('\n⑧ 标签换行：卡片按内容长高（520 是**下限**），页脚那条「更新于」是被裁的第一个');
{
    // 现场：标签换到第二/第三行时，"作者信息时间信息跑出卡片"（用户第四报）。
    // 根因是**定高**：`.ArticleCard{height:600px}` + `overflow:hidden`，而「更新于」那行是
    // `position:absolute; top:100%` 挂在页脚盒子**外面**的（页脚盒子只有一行高，那行靠内容区
    // 32px 下内边距兜着）⇒ 收支一为负，它第一个被切。判据分三层：
    //   ① 网格项是 flex（同排等高靠这层，否则长高会把同排弄参差）；
    //   ② 卡片写 min-height 而**不是** height；内容区写 `flex: 1 1 auto` 而**不是** `height: 100%`；
    //   ③ 移动档把下限撤干净——`height: auto !important` 管不到 `min-height`（两个是不同的属性）。
    const item = decl('.ContentContainer .allArticles > .article', 'display', 'flex');
    ok(item.found && item.match,
        '.allArticles > .article 是 display: flex（网格只拉网格项 ⇒ 少了这层同排卡片不等高）', item);

    const card = '.ContentContainer .allArticles .ArticleCard';
    const mh = declNum(card, 'min-height', 520);
    ok(mh.found && mh.match, '卡片 520px 写在 min-height 上（下限，内容多就长高）', mh);
    const cardH = decl(card, 'height');
    ok(!cardH.found, '卡片**没有** height（写回去就是定高：内容一多「更新于」立刻被裁出去）', cardH);

    const flex = decl(CONTENT, 'flex', '1 1 auto');
    ok(flex.found && flex.match, '内容区 flex: 1 1 auto（可以长：撑开卡片，而不是把内容压出去）', flex);
    const contentH = decl(CONTENT, 'height');
    ok(!contentH.found, '内容区**没有** height（`height: 100%` 会把卡片钉回定高）', contentH);

    const mob = '.allArticles .ArticleCard';
    const mobMin = decl(mob, 'min-height');
    ok(mobMin.found && /!important/.test(mobMin.value) && parseFloat(mobMin.value) === 0,
        '移动档 min-height: 0 !important（撤的是下限本身；`height:auto` 覆盖不到它）', mobMin);
    const mobH = decl(mob, 'height');
    ok(mobH.found && /auto\s*!important/.test(mobH.value), '移动档 height: auto !important', mobH);

    // 源码接线：那条「更新于」是**几何套件唯一量得到**的东西（桩里也照着它写）。
    // 两个卡各自的 JSX 里都得是"同一个日期列里的第二个 span、绝对定位挂在列外面"。
    const dateColRe = /<div style=\{\{\s*position:\s*'relative',\s*display:\s*'flex',\s*flexDirection:\s*'column'\s*\}\}>\s*<span[^>]*className='post-date'>[\s\S]{0,300}?发布于[\s\S]{0,700}?position:\s*'absolute',\s*top:\s*'100%'[\s\S]{0,400}?更新于/;
    const article = readFileSync(ARTICLE_TSX, 'utf8');
    ok(dateColRe.test(article),
        'Article.tsx：日期列里「发布于」+「更新于」两行，后者绝对定位挂在列外（溢出时第一个被裁）');
    const home = readFileSync(HOME_TSX, 'utf8');
    ok(dateColRe.test(home), 'index.tsx（置顶卡）：同形的两行日期');
}

console.log(`\n${fail ? '✗' : '✓'} article-card-hover(源码契约)：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
