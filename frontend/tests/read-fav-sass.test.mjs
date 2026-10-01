// ═ 文章横幅「读数三件」共用几何 · sass 编译契约（20260926 起；20261001 改为三件同形）══
//   node tests/read-fav-sass.test.mjs
//
// 现场：用户第 1 条「详情页三图标样式和布局太丑了，大小不一，排列奇怪」。
// 实测下来那三件确实是三套几何：收藏 32×62（竖排胶囊）、浏览 59×24、点赞 64×30；
// 内边距 6px 8px / 2px 8px / 4px 10px、字号 13 / 12 / 13、描边 α .55 / .35 / .55。
//
// 修法：三件共用一个 `.readStat`（同高同距同字号同描边同一行），整簇住 `.readStats`。
// 所以本套件现在锁的核心是一条**否定式**判据：几何属性只许出现在 `.readStat` 一处
//（后面 ③ 组）——"大小不一"的回归方式就是有人又给某一个加了 height/padding/font-size。
//
// 为什么这条要进 CI（而这套的其它判据在 `.test.py` 沙箱里）：**sass 缩进嵌套已经咬过两次**
// （见记忆里那条"个人中心/红点"的根因）——缩进错一级，编译产物里选择器就挂到别的父级下面，
// 语法完全合法、构建不报错、页面也不会崩，只是样式静默失效。这里用真 sass 编译真 `.sass`，
// 断言每条规则落在**完整的选择器链**上：缩进错了链就变了，链对不上即红。
//
// 布局行为（三件真的等高、挤不挤）由 tests/read-stats-cluster.test.py 在无头 Chrome 里验，
// 那边能量 flex 收缩后的真实盒子；本套件只管"CSS 有没有写在该在的地方"。
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

// selector → 声明块。sass 会把 `.a, .b { … }` 原样输出成一条**逗号组**，所以每条规则
// 同时登记"整组"与"拆开的每一支"，`decl('… .readViews', …)` 才查得到。
const rules = new Map();
const order = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const group = m[1].trim();
    order.push(group);
    for (const sel of group.split(',').map((s) => s.trim())) {
        rules.set(sel, (rules.get(sel) || '') + ';' + m[2]);
    }
}
const decl = (sel, prop, value) => {
    const body = rules.get(sel);
    if (body === undefined) return { found: false, why: '选择器不在编译产物里' };
    const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
    if (!m) return { found: false, why: prop + ' 不在这个选择器下' };
    return { found: true, value: m[1].trim(), match: m[1].trim() === value };
};
/** 这一支在源码顺序里的位置（同特异性时靠源码顺序决出胜负，见 ⑧） */
const posOf = (sel) => {
    for (let i = 0; i < order.length; i++) {
        if (order[i].split(',').map((s) => s.trim()).includes(sel)) return i;
    }
    return -1;
};

const INFO = '.readContainer .readCover .readInfo';
const CLUSTER = INFO + ' .readStats';
const STAT = INFO + ' .readStat';
const FAV = INFO + ' .readFavBtn';
const LIKE = INFO + ' .readLikeBtn';
const VIEWS = INFO + ' .readViews';
const LABEL = INFO + ' .readFavLabel';
/** 簇里的每一支（几何唯一性判据的作用域，见 ③） */
const CLUSTER_MEMBERS = [STAT, FAV, LIKE, VIEWS];

console.log('\n① 整簇：住一个 wrapper、不许被 flex 挤小');
{
    const f = decl(CLUSTER, 'flex', '0 0 auto');
    ok(f.found, CLUSTER + ' 有 flex 声明', f);
    ok(f.match, '  值是 0 0 auto（被挤窄的只该是中区那个标题，不是读数）', f);
    const m = decl(CLUSTER, 'margin-top', '6px');
    ok(m.match, '  原有的 margin-top: 6px 还在', m);
    ok(decl(CLUSTER, 'display', 'flex').found, '  三件横排（display: flex）');
    ok(decl(CLUSTER, 'align-items', 'center').found, '  竖直居中对齐');
    const g = decl(CLUSTER, 'gap', '8px');
    ok(g.found && g.match, '  三件之间固定 8px（不再是"各簇自带 margin"那种间接间距）', g);
}

console.log('\n② 三件共用一份几何（.readStat）');
{
    const want = [
        ['height', '30px'],
        ['padding', '0 10px'],
        ['font-size', '13px'],
        ['line-height', '1'],
        ['border', '1px solid rgba(255, 241, 235, 0.55)'],
        ['border-radius', '999px'],
        ['display', 'inline-flex'],
        ['align-items', 'center'],
        ['justify-content', 'center'],
        ['gap', '4px'],
        ['white-space', 'nowrap'],
    ];
    for (const [prop, value] of want) {
        const r = decl(STAT, prop, value);
        ok(r.found && r.match, `${prop}: ${value}`, r);
    }
    // 高度**写死**而不是 padding+line-height 凑出来——那正是"大小不一"的成因
    ok(decl(STAT, 'height', '30px').found && !decl(STAT, 'min-height', '30px').found,
        '  高度是定值 height（不是 min-height：内容一变又会被撑开）');
}

console.log('\n③ 「大小不一」的回归锁：几何只许声明一次');
{
    // 这条是本轮改动的**本体**。上一版的病是 `.readFavBtn` / `.readViews` / `.readLikeBtn`
    // 各自声明了 height/padding/font-size/border（值各不相同）⇒ 三件永远对不齐。
    // 判据：在簇的这四支里，这几条属性只许出现在 `.readStat` 一处。
    const GEOM = ['height', 'padding', 'font-size', 'border', 'border-radius', 'line-height'];
    for (const prop of GEOM) {
        const holders = CLUSTER_MEMBERS.filter((sel) => {
            const body = rules.get(sel);
            return body !== undefined && new RegExp('(?:^|;)\\s*' + prop + '\\s*:', 'i').test(body);
        });
        ok(holders.length === 1 && holders[0] === STAT,
            `${prop} 只在 ${STAT.split(' ').pop()} 上声明（别处再写一次就又是三套尺寸）`, holders);
    }
    // 两个按钮只该多出"能点"这件事
    for (const [sel, name] of [[FAV, '收藏'], [LIKE, '点赞']]) {
        const body = rules.get(sel) || '';
        ok(/cursor\s*:\s*pointer/.test(body), `${name}按钮有 cursor: pointer`);
        ok(/transition/.test(body), `  ${name}按钮有 transition`);
        ok(!/display|flex-direction|writing-mode/.test(body),
            `  ${name}按钮不再自带布局（display/方向都不该在这里）`, body.slice(0, 60));
    }
    // 竖排那套是上一版的形态（治的是"被挤成两行"的症状，病根已由 flex: 0 0 auto 治掉）
    const sassSrc = readFileSync(SASS_FILE, 'utf8');
    const clusterBlock = sassSrc.slice(sassSrc.indexOf('.readStats'), sassSrc.indexOf('.readDescription'));
    ok(!/writing-mode|text-orientation/.test(clusterBlock),
        '  竖排（writing-mode: vertical-rl）已随本轮取消', clusterBlock.length);
    ok(!/readFavWrap|readLikeWrap/.test(sassSrc), '  旧的两个 wrapper（.readFavWrap / .readLikeWrap）已拆掉');
}

console.log('\n④ 定宽：文案与数字都不许让整簇跟着挪');
{
    // 「收藏」两字 / 「已收藏」三字 —— 不定宽的话点一下这一件就宽 13px，后面两件整排推移
    const l = decl(LABEL, 'min-width', '3em');
    ok(l.found && l.match, LABEL + ' 有 min-width: 3em（收藏 ⇄ 已收藏 同宽）', l);
    ok(decl(LABEL, 'text-align', 'center').found, '  居中');
    for (const num of ['readViewsNum', 'readLikeNum']) {
        // 4ch（不是 3ch）：999→1000 那一步在 3ch 下会横移 16px，详见 sass 里那段注释
        const n = decl(INFO + ' .' + num, 'min-width', '4ch');
        ok(n.found && n.match, `.${num} 有 min-width: 4ch（读数跨过 9999 才变宽）`, n);
    }
    // 缩进陷阱：`.readFavLabel` 只许挂在它该在的那条链上
    const withLabel = [...rules.keys()].filter((s) => s.includes('readFavLabel'));
    ok(withLabel.length === 1, '编译产物里只有一条规则提到 readFavLabel', withLabel);
    ok(withLabel[0] === LABEL, '  且选择器链完整（少一级/多一级都说明缩进错了）', withLabel[0]);
    ok(!rules.has('.readFavLabel'), '  没有挂在顶层的 .readFavLabel（缩进少了）');
    ok(!rules.has(STAT + ' .readFavLabel'), '  没有跳过簇直接挂 .readStat（缩进多/少一级）');
}

console.log('\n⑤ 三态色与描边一字未改（这批只动几何）');
{
    const f = decl(FAV + '.isFaved', 'background', '#ffcc7c');
    ok(f.found && f.match, '已收藏：河灯金 #ffcc7c 实心', f);
    ok(decl(FAV + '.isFaved', 'color', '#1c2754').found, '  深蓝字（#1c2754）');
    const b = decl(STAT, 'border', '1px solid rgba(255, 241, 235, 0.55)');
    ok(b.found, '未选中态：浅色描边在 .readStat 上（三件同一条）', b);
    const k = decl(LIKE + '.isLiked', 'background', '#ffb3c6');
    ok(k.found && k.match, '已点赞：暖粉 #ffb3c6（与收藏的金区分开）', k);
    ok(decl(VIEWS, 'color', 'rgba(255, 241, 235, 0.85)').found, '浏览是读数不是按钮：字色更淡一档');
    ok(rules.get(FAV + ':hover') !== undefined && rules.get(LIKE + ':hover') !== undefined,
        '两个按钮的 hover 规则都在');
    ok(rules.get(FAV + ':disabled') !== undefined && rules.get(LIKE + ':disabled') !== undefined,
        '两个按钮的 disabled 规则都在（提交中会有）');
    ok(rules.get(VIEWS + ':hover') === undefined, '浏览没有 hover（它不可点）');
}

console.log('\n⑥ 源码契约：三件是真的同一个簇的三个孩子');
{
    const tsx = readFileSync(TSX_FILE, 'utf8');
    ok(/className="readStats"/.test(tsx), 'index.tsx 里挂了 readStats（整簇的 wrapper）');
    // 每一件都必须同时带 readStat 与自己的那一支 —— 只写自己的类名 = 几何全丢
    const three = [
        /className=\{`readStat readFavBtn\$\{[^`]*\}`\}/,
        /className="readStat readViews"/,
        /className=\{`readStat readLikeBtn\$\{[^`]*\}`\}/,
    ];
    for (const re of three) ok(re.test(tsx), `  三件之一：${re.source.slice(11, 40)}…`);
    // 反向：恰好三处。前置断言排除注释里的 `` `.readStat` `` 写法（带点的是引用不是挂载）；
    // 模板串里的 `` className={`readStat …`} `` 前面是反引号，**不能**排除掉
    const hits = tsx.match(/(?<![.\w])readStat\b(?!s)/g) || [];
    ok(hits.length === 3, '  恰好三处挂 readStat（多一处就是有第四件偷偷混进来）', hits);
    ok(!/readFavWrap|readLikeWrap/.test(tsx), '  旧的 .readFavWrap / .readLikeWrap 已从 tsx 拆掉');
    // 20261001（用户第 4 条「三图标风格不一致」）：图标从文本字形换成 NoteStatIcons 同源 14px
    ok(/\{faved\s*\?\s*<StarIcon size=\{14\} \/>\s*:\s*<StarOutlineIcon size=\{14\} \/>\}/.test(tsx),
        '收藏图标走 NoteStatIcons（选中实心星 / 未选中描边星，14px）');
    ok(!/(['"`])[★☆♥♡]\1/.test(tsx), '  不再有 ★☆♥♡ 这类文本字形（注释里的考古引用不算）');
    for (const name of ['StarIcon', 'StarOutlineIcon', 'HeartIcon', 'HeartOutlineIcon', 'EyeIcon']) {
        ok(tsx.includes(name), `  tsx 引了 ${name}`);
    }
    const iconsSrc = readFileSync(path.join(root, 'src/components/NoteStatIcons/index.tsx'), 'utf8');
    ok(/export const StarOutlineIcon/.test(iconsSrc) && /export const HeartOutlineIcon/.test(iconsSrc),
        'NoteStatIcons 里那两个描边件真的导出着');
    // 类名对不上是这类改动最哑的失败：sass 写了、tsx 没挂，页面上不动声色
    const sassSrc = readFileSync(SASS_FILE, 'utf8');
    for (const cls of ['readStats', 'readStat', 'readFavLabel', 'readViews', 'readLikeNum']) {
        ok(sassSrc.includes(cls) && tsx.includes(cls), `  类名 ${cls} 两份文件都有（sass 写了、tsx 挂上了）`);
    }
}

console.log('\n⑦ 三区锁死：中区吃满余量、左右两区不收缩（用户第 4 条「布局没有锁死」）');
{
    const jc = decl(INFO, 'justify-content', 'flex-start');
    ok(jc.found && jc.match,
        '`.readInfo` 不再是 `space-between`（五个子项平分余量 ⇒ 日期的位置全看标题多长）', jc);
    const gap = decl(INFO, 'gap', '24px');
    ok(gap.found && gap.match, '  三区之间是固定间距 24px', gap);
    ok(decl(INFO + ' .readAuthor', 'flex', '0 0 auto').found, '左区（作者）不收缩');
    ok(decl(INFO + ' .readMain', 'flex', '1 1 auto').found, '中区吃满余量');
    ok(decl(INFO + ' .readMain', 'min-width', '0').found,
        '  中区 `min-width: 0`（不给它的话长标题会把这一区顶出去，折行反而失效）');
    const clamp = decl(INFO + ' .readMain h1', '-webkit-line-clamp', '2');
    ok(clamp.found && clamp.match, '标题两行封顶（三行会把整张卡拉高 ⇒ 底边跟着挪）', clamp);
    const mh = decl(INFO + ' .readMain h1', 'min-height', '2.4em');
    ok(mh.found && mh.match, '  两行**预留**：一行标题也占两行的高度', mh);
    // ⚠️ 一写 font-size 就会把手机档那条 `.readCover .readInfo h1`（0,3,1）永久盖掉
    // ——媒体查询不改特异性，本块是 (0,4,0)。判据：本块里不许出现 font-size。
    const mainH1 = rules.get(INFO + ' .readMain h1') || '';
    ok(!/(?:^|;)\s*font-size\s*:/.test(mainH1),
        '  桌面这条**不写 font-size**（否则手机档的 1.4rem 被静默盖掉）', mainH1.slice(0, 80));
    ok(decl(INFO + ' .readMain h3', 'margin', '0').found, '日期去掉默认外边距（否则位置随字号浮动）');
    // TSX 侧：结构真的分了三区，否则上面那些规则一条也挂不上
    const tsx = readFileSync(TSX_FILE, 'utf8');
    ok(/className="readAuthor"/.test(tsx) && /className="readMain"/.test(tsx),
        'index.tsx 里挂上了 readAuthor / readMain 两个类名');
    ok(/<div className="readMain">\s*<h1>/.test(tsx), '  标题与日期真的**包在同一个中区**里');
    // 右区那簇是**直接子项**（`.readInfo` 的 gap 才管得住它）—— 嵌进中区就跑进标题那一列了
    ok(/<div className="readStats">/.test(tsx) && /readInfo[\s\S]{0,60}readStats/.test(tsx) === false,
        '  簇与 readMain 是并列的兄弟（结构由缩进决定，这里只锁类名格式）');
}

console.log('\n⑧ 源码顺序：`.readStat` 必须排在它的覆盖者之前');
{
    // `.readViews` 只改字色、两个按钮只加交互态，但**特异性与 `.readStat` 完全相同**
    //（都是 0,4,0）⇒ 谁在后谁赢。顺序写反的话三件会退回默认字色/失去 hover 背景。
    const iStat = posOf(STAT);
    ok(iStat >= 0, `.readStat 在编译产物里（顺序判据的前提）`, iStat);
    for (const [sel, why] of [[VIEWS, '读数那一件的字色要能覆盖 .readStat'], [FAV, '按钮的 cursor/hover 要能覆盖 .readStat'], [LIKE, '同上']]) {
        const i = posOf(sel);
        ok(i > iStat, `${sel.split(' ').pop()} 排在 .readStat 之后（${why}）`, { iStat, i });
    }
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
