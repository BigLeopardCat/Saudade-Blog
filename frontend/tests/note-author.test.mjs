// ═ 文章卡片的作者（20261001）══
//   node tests/note-author.test.mjs
//
// 现场（用户原话）："文章发布的卡片没有作者信息，管理员发的文章还是超级管理员的
//   头像和署名在文章卡片上。"
//
// 根因是**数据不存在**（`note` 表从来没有作者列），所以修复横跨两仓：
//   后端加 `note.user_id`（迁移 `scripts/migration/note_author_20261001.sql`）
//   → 列表/详情接口多回 `authorName`/`authorAvatar`
//   → 前端 `utils/noteAuthor.ts` 判"用作者那份还是回退站点级"。
// 这套件锁三件（几何那半边不在这里：DOM 与改造前逐字相同，由
// `article-card-hover.test.py` / `home-hero.test.py` 那几支继续量）：
//   ① ★ 判据本身：有作者记录时**不许**再印站点级那份（这就是本轮报的那个 bug）；
//      两个字段各判各的；空串/纯空白算"没记录"（不许印一片空白）；
//   ② 接线：四处消费方走同一条判据，且**没有第二份 `|| 站点级`**——改造前正是
//      "两处各拿 redux 的 name/avatar 直接渲染"才让这个 bug 要修两遍；
//   ③ 跨语言契约：Rust 侧真的在回这两个键（`conv-row-since.test.mjs` 同款手法，
//      直接读 `../../src/`），且**每一条列表/详情路径都挂了作者**——漏挂一条就是
//      同一个症状在另一个页面上复发。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
/** 父仓根（`memory_blog_rust/`）：Rust 与迁移脚本都在那里，不在 frontend/ 下 */
const repo = path.resolve(root, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/**
 * 断言前先去掉注释：这几个文件的**头注本身就在讲这件事**（"改造前印的是站点级那份"、
 * "判据只有一份"…），拿全文去数会把自己的说明文字数进去，判据就变成"注释怎么写"
 * 而不是"代码怎么写"。同 `article-card-stats.test.mjs` 的处置。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readSrc = (p) => stripComments(readFileSync(path.join(root, p), 'utf8'));

// noteAuthor.ts 只 `import type`（纯 TS，无 DOM 无 React）⇒ 直接摊平后 import
const out = mkdtempSync(path.join(tmpdir(), 'noteauthor-'));
const file = path.join(out, 'noteAuthor.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/noteAuthor.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const M = await import(pathToFileURL(file).href);

const SITE = { name: '站长', avatar: '/site.png' };

console.log('\n① 有作者记录 ⇒ 用文章那份（本轮报的 bug 就是这里印成了站点级）');
{
    const who = M.noteAuthor({ authorName: '管理员甲', authorAvatar: '/jia.png' }, SITE);
    ok(who.name === '管理员甲', '署名是文章作者，不是站点主人', who.name);
    ok(who.avatar === '/jia.png', '头像是文章作者那张，不是站点主人那张', who.avatar);
    ok(who.name !== SITE.name && who.avatar !== SITE.avatar, '两个字段一个都没落到站点级');
}

console.log('\n② 没有记录 ⇒ 回退站点级（老文章 / 发布者已销号 / 这条路没回这个键）');
{
    ok(M.noteAuthor({}, SITE).name === '站长', '键缺席（老文章）⇒ 回退站点署名');
    ok(M.noteAuthor({}, SITE).avatar === '/site.png', '键缺席 ⇒ 回退站点头像');
    ok(M.noteAuthor(null, SITE).name === '站长' && M.noteAuthor(undefined, SITE).avatar === '/site.png',
        'item 为 null/undefined（详情页还没加载完）⇒ 回退站点级，不抛异常');
    ok(M.noteAuthor({}, SITE).name !== undefined, '回退值给的是空串也可能，但绝不是 undefined（调用方直接渲染）');
}

console.log('\n③ 两个字段各判各的；空白一律算"没记录"');
{
    const half = M.noteAuthor({ authorName: '管理员甲' }, SITE);
    ok(half.name === '管理员甲' && half.avatar === '/site.png',
        '只记了名字没头像（发布者没上传过）⇒ 名字用作者的、头像回退站点，互不连累', half);
    const blank = M.noteAuthor({ authorName: '   ', authorAvatar: '' }, SITE);
    ok(blank.name === '站长' && blank.avatar === '/site.png',
        '空串 / 纯空白 ⇒ 当"没记录"（不许印一片空白出来）', blank);
    ok(M.noteAuthor({ authorName: ' 甲 ' }, SITE).name === '甲', '两端空白抹掉再用');
    const none = M.noteAuthor({}, {});
    ok(none.name === '' && none.avatar === '',
        '站点级也没有（redux 未加载完）⇒ 空串，与改造前行为一致（antd 画默认头像）', none);
}

console.log('\n④ 接线：四处消费方走同一条判据，没有第二份 `|| 站点级`');
{
    const article = readSrc('src/frontHome/Content/ContentHome/Article.tsx');
    ok(/<NoteByline\b/.test(article), '首页文章卡片用了共享的 NoteByline');
    ok(!/<Avatar\s+src=\{avatar\}/.test(article),
        '卡片里没有残留的"直接拿 redux 头像渲染"（改造前就是这一句让每篇文章都顶着站长）');

    const home = readSrc('src/frontHome/Content/ContentHome/index.tsx');
    ok(/<NoteByline\b/.test(home), '置顶轮播那一份也走 NoteByline（不是第二份副本）');
    ok(!/<Avatar\s+src=\{avatar\}/.test(home), '轮播里没有残留的那一句');

    const readArt = readSrc('src/frontHome/Content/ReadArticle/index.tsx');
    ok(/noteAuthor\(article,/.test(readArt), '详情页横幅用同一条判据（article 尚未加载时自动回退）');
    ok(/<Avatar\s+src=\{who\.avatar\}/.test(readArt) && /\{who\.name\}/.test(readArt),
        '详情页的头像与署名都取自 who');
    ok(!/<Avatar\s+src=\{avatar\}/.test(readArt), '详情页里没有残留的那一句');

    const byline = readSrc('src/components/NoteByline/index.tsx');
    ok(/noteAuthor\(item,/.test(byline), 'NoteByline 是判据的渲染点');
    ok(/siteAvatar/.test(byline) && /siteName/.test(byline),
        '站点级那两个 prop 名字里带 site（读代码的人不会误当成本文作者）');

    // 判据只有一份：全 src 里出现 `authorName` 的文件白名单。
    // 新消费方（后台列、作者页…）请调 noteAuthor()，别自己写 `item.authorName || …`。
    const hits = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir)) {
            const p = path.join(dir, e);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.(ts|tsx)$/.test(e) && readSrc(path.relative(root, p)).includes('authorName')) {
                hits.push(path.relative(root, p));
            }
        }
    };
    walk(path.join(root, 'src'));
    ok(JSON.stringify(hits.sort()) === JSON.stringify(['src/interface/NoteType.d.ts', 'src/utils/noteAuthor.ts']),
        '全 src 里只有类型声明与判据文件提到 authorName（没有第二份回退写法）', hits);
}

console.log('\n⑤ 跨语言契约：Rust 真的在回这两个键，且每条路径都挂了作者');
{
    const rust = readFileSync(path.join(repo, 'src/routes/notes.rs'), 'utf8');
    ok(/#\[serde\(rename = "authorName"/.test(rust), 'DTO 回 authorName（前端读的就是这个键名）');
    ok(/#\[serde\(rename = "authorAvatar"/.test(rust), 'DTO 回 authorAvatar');
    ok(/async fn attach_authors/.test(rust), '批量解析作者那一步在（不是每个 DTO 自己查一次）');
    ok(/web_info::site_author/.test(rust), '回退用的是与 /api/public/user 同一份站点级实现（同一个人名）');

    // 逐条路径查"挂没挂"：漏挂一条 = 同一个症状在另一个页面上复发（后台列表/搜索尤其容易漏）
    const bodyOf = (name) => {
        const i = rust.indexOf(`fn ${name}(`);
        if (i < 0) return null;
        const rest = rust.slice(i + 1);
        const j = rest.search(/\nasync fn |\npub async fn /);
        return j < 0 ? rest : rest.slice(0, j);
    };
    for (const fn of ['list_public_notes', 'search_notes', 'get_top_notes', 'get_note_detail',
        'list_all_notes', 'search_all_notes']) {
        const body = bodyOf(fn);
        ok(body !== null && /attach_authors\(/.test(body), `${fn} 挂了作者`);
    }

    const entity = readFileSync(path.join(repo, 'src/entity/note.rs'), 'utf8');
    ok(/pub user_id: Option<i32>/.test(entity), '实体里有 user_id 列（Option = 老文章那批没有记录）');

    const sql = readFileSync(path.join(repo, 'scripts/migration/note_author_20261001.sql'), 'utf8');
    ok(/ADD COLUMN `user_id` int NULL/.test(sql), '迁移文件真的加这一列（可空 ⇒ 存量行不动）');
    ok(/note_author_20261001/.test(sql), '迁移带 flag（勿重跑）');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
