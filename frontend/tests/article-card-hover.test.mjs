import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sass from 'sass';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // frontend/
const repo = path.resolve(root, '..');            // 仓库根（Rust 在那儿）

const SASS_FILE = path.join(root, 'src/frontHome/Content/ContentHome/index.sass');
const ARTICLE_TSX = path.join(root, 'src/frontHome/Content/ContentHome/Article.tsx');
const HOME_TSX = path.join(root, 'src/frontHome/Content/ContentHome/FeaturedArticles.tsx');
const BYLINE_TSX = path.join(root, 'src/components/NoteByline/index.tsx');
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
const SLOT = '.ContentContainer .allArticles .ArticleCard .descSlot';
const DESC = '.ContentContainer .allArticles .ArticleCard .ArticleDescription';

console.log('\n① 定高槽：普通卡的简介保留固定槽位');
{
    for (const [name, sel] of [['普通卡', SLOT]]) {
        const p = decl(sel, 'position', 'relative');
        ok(p.found && p.match, `${name}：${sel} 存在且 position: relative（简介的定位基准）`, p);
        const h = decl(sel, 'height', '42px');
        ok(h.found && h.match, `  height: 42px = 2 行 × 行高 21px`, h);
    }
    // 普通卡的槽还要能抗 flex 收缩：槽位一变压的就是简介的顶
    const fs = decl(SLOT, 'flex-shrink', '0');
    ok(fs.found && fs.match, '普通卡：槽 flex-shrink: 0（内容区余量不够时不许压槽）', fs);

}

console.log('\n② 简介在槽内绝对定位：长高不参与布局（展开/收回都不许撑动后面的东西）');
{
    for (const [name, sel] of [['普通卡', DESC]]) {
        const p = decl(sel, 'position', 'absolute');
        ok(p.found && p.match, `${name}：${sel} 是 position: absolute`, p);
        const t = declNum(sel, 'top', 0);
        ok(t.match, `  top: 0（贴槽顶向下长）`, t);
        const l = declNum(sel, 'left', 0);
        ok(l.match, `  left: 0`, l);
    }

}

console.log('\n③ 展开态：上限是行高整数倍，且**不许**再用负 margin / padding 当支点');
{
    const hoverNormal = decl(DESC + ':hover', 'max-height', '126px');
    ok(hoverNormal.found && hoverNormal.match, `普通卡：:hover 上限 126px（6 行）`, hoverNormal);
    for (const [name, sel] of [['普通卡', DESC]]) {
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

console.log('\n④ 标题尺寸保持稳定：标题的 :hover 不许解除行数限制');
{
    const bad = [...rules.keys()].filter((s) => /:hover/.test(s) && /contentTitle/.test(s));
    ok(bad.length === 0, '没有 `.contentTitle:hover`', bad);
    const sassSrc = readFileSync(SASS_FILE, 'utf8');
    // 源码层：这两块里不许再出现 `-webkit-line-clamp: unset`（唯一合法出现处是简介的展开态）
    const titleBlocks = sassSrc.split(/\n(?= {0,4}[.\w:-])/).filter((b) => /contentTitle/.test(b));
    ok(!titleBlocks.some((b) => /-webkit-line-clamp:\s*unset/.test(b)),
        '标题那两块源码里没有 `-webkit-line-clamp: unset`');
}

console.log('\n⑤ 源码接线：普通卡简介保留展开和离开复位');
{
    const article = readFileSync(ARTICLE_TSX, 'utf8');
    ok(/import\s*\{\s*resetDescScroll\s*\}\s*from\s*"\.\.\/\.\.\/\.\.\/utils\/descHover"/.test(article),
        'Article.tsx 从 utils/descHover 引了 resetDescScroll（别再来一份实现）');
    ok(/<div className="descSlot">\s*<p className="ArticleDescription" onMouseLeave=\{resetDescScroll\}>/.test(article),
        'Article.tsx：descSlot 包着简介，且简介挂着 onMouseLeave', article.match(/descSlot[\s\S]{0,200}/)?.[0]);

}

console.log('\n⑥ 简介按完整行显示，移动端行为由浏览器套件验证');
{
    const slot = declNum(SLOT, 'height', 42);
    const line = declNum(DESC, 'line-height', 21);
    ok(slot.match && line.match, '收起态保留两行完整正文');
    const expanded = declNum(DESC + ':hover', 'max-height', 126);
    ok(expanded.match && expanded.value && parseFloat(expanded.value) % 21 === 0,
        '展开上限是行高整数倍');
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

console.log('\n⑧ 卡片随内容增长，并复用作者与日期组件');
{
    const item = decl('.ContentContainer .allArticles > .article', 'display', 'flex');
    ok(item.found && item.match,
        '.allArticles > .article 是 display: flex（网格只拉网格项 ⇒ 少了这层同排卡片不等高）', item);

    const card = '.ContentContainer .allArticles .ArticleCard';
    const cardH = decl(card, 'height');
    ok(!cardH.found, '卡片**没有** height（写回去就是定高：内容一多「更新于」立刻被裁出去）', cardH);

    const flex = decl(CONTENT, 'flex', '1 1 auto');
    ok(flex.found && flex.match, '内容区 flex: 1 1 auto（可以长：撑开卡片，而不是把内容压出去）', flex);
    const contentH = decl(CONTENT, 'height');
    ok(!contentH.found, '内容区**没有** height（`height: 100%` 会把卡片钉回定高）', contentH);

    const byline = readFileSync(BYLINE_TSX, 'utf8');
    ok(byline.includes('发布于') && byline.includes('更新于'), '共用署名组件提供发布与更新日期');
    const article = readFileSync(ARTICLE_TSX, 'utf8');
    const home = readFileSync(HOME_TSX, 'utf8');
    ok(/<NoteByline\b/.test(article), 'Article.tsx（普通卡）吃这份共用的页脚');
    ok(/<NoteByline\b/.test(home), 'index.tsx（置顶卡）吃同一份（不是又抄了一遍）');

}

console.log(`\n${fail ? '✗' : '✓'} article-card-hover(源码契约)：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
