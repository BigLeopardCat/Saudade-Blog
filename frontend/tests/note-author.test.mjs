import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
/** Host repository containing Rust routes and migrations. */
const repo = path.resolve(root, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** Source wiring checks ignore comments; display behavior is exercised below. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readSrc = (p) => stripComments(readFileSync(path.join(root, p), 'utf8'));

// Test the pure author projection without a browser.
const out = mkdtempSync(path.join(tmpdir(), 'noteauthor-'));
const file = path.join(out, 'noteAuthor.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/noteAuthor.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const M = await import(pathToFileURL(file).href);

const SITE = { name: '站长', avatar: '/site.png' };

console.log('\n① 有作者记录 ⇒ 用文章那份');
{
    const who = M.noteAuthor({ authorName: '管理员甲', authorAvatar: '/jia.png' }, SITE);
    ok(who.name === '管理员甲', '署名是文章作者，不是站点主人', who.name);
    ok(who.avatar === '/jia.png', '头像是文章作者那张，不是站点主人那张', who.avatar);
    ok(who.name !== SITE.name && who.avatar !== SITE.avatar, '两个字段一个都没落到站点级');
}

console.log('\n② 键整个缺席 ⇒ 回退站点级（老文章 / 发布者已销号 / 这条路没挂作者）');
{
    ok(M.noteAuthor({}, SITE).name === '站长', '键缺席（老文章）⇒ 回退站点署名');
    ok(M.noteAuthor({}, SITE).avatar === '/site.png', '键缺席 ⇒ 回退站点头像');
    ok(M.noteAuthor(null, SITE).name === '站长' && M.noteAuthor(undefined, SITE).avatar === '/site.png',
        'item 为 null/undefined（详情页还没加载完）⇒ 回退站点级，不抛异常');
    ok(M.noteAuthor({}, SITE).name !== undefined, '回退值给的是空串也可能，但绝不是 undefined（调用方直接渲染）');
}

console.log('\n③ 键在场 = 后端定过稿：空头像不许借站长的脸');
{
    const noAvatar = M.noteAuthor({ authorName: '管理员甲', authorAvatar: '' }, SITE);
    ok(noAvatar.name === '管理员甲' && noAvatar.avatar === '',
        '★ 有名字没头像（发布者没上传过）⇒ 头像**留空**（antd 画默认头像），不顶站长的脸',
        noAvatar);
    const noName = M.noteAuthor({ authorName: '', authorAvatar: '/jia.png' }, SITE);
    ok(noName.name === '' && noName.avatar === '/jia.png',
        '只有头像没有名字 ⇒ 名字留空，不印站长的名（挨着别人的头像印站长名是同一类错）',
        noName);
    ok(M.noteAuthor({ authorName: ' 甲 ', authorAvatar: ' /jia.png ' }, SITE).name === '甲',
        '两端空白抹掉再用');
    const none = M.noteAuthor({}, {});
    ok(none.name === '' && none.avatar === '',
        '站点级也没有（redux 未加载完）⇒ 空串（antd 画默认头像）', none);
}

console.log('\n④ 接线：四处消费方走同一条判据，没有第二份 `|| 站点级`');
{
    const article = readSrc('src/frontHome/Content/ContentHome/Article.tsx');
    ok(/<NoteByline\b/.test(article), '首页文章卡片用了共享的 NoteByline');
    ok(!/<Avatar\s+src=\{avatar\}/.test(article),
        '卡片里没有残留的"直接拿 redux 头像渲染"');

    const home = readSrc('src/frontHome/Content/ContentHome/index.tsx');
    ok(/<NoteByline\b/.test(home), '置顶轮播那一份也走 NoteByline（不是第二份副本）');
    ok(!/<Avatar\s+src=\{avatar\}/.test(home), '轮播里没有残留的那一句');

    const readArt = readSrc('src/frontHome/Content/ReadArticle/index.tsx');
    ok(/noteAuthor\(article,/.test(readArt), '详情页横幅用同一条判据（article 尚未加载时自动回退）');
    ok(!/<Avatar\s+src=\{avatar\}/.test(readArt), '详情页里没有残留的那一句');

    const byline = readSrc('src/components/NoteByline/index.tsx');
    ok(/noteAuthor\(item,/.test(byline), 'NoteByline 是判据的渲染点');
    ok(/siteAvatar/.test(byline) && /siteName/.test(byline),
        '站点级那两个 prop 名字里带 site（读代码的人不会误当成本文作者）');

    // Keep author fallback decisions in the shared projection.
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

    // All host note views attach the public author projection.
    const bodyOf = (name) => {
        const i = rust.indexOf(`fn ${name}(`);
        if (i < 0) return null;
        const rest = rust.slice(i + 1);
        const j = rest.search(/\nasync fn |\npub async fn /);
        return j < 0 ? rest : rest.slice(0, j);
    };
    for (const fn of ['list_public_notes', 'search_notes_query', 'get_top_notes', 'get_note_detail']) {
        const body = bodyOf(fn);
        ok(body !== null && /attach_authors\(/.test(body), `${fn} 挂了作者`);
    }

    const guardedSearch = readFileSync(path.join(repo, 'src/routes/notes/legacy_search.rs'), 'utf8');
    ok(/search_notes_query\(state,\s*payload,\s*terms\)\.await/.test(guardedSearch),
        '公开搜索通过资源检查后转交保留作者信息的查询');

    // ★ 两个键**成对写**：前端按"键在不在场"判（见 ③），后端只写一个就会让另一个字段
    // 被读成"这一路没挂作者" ⇒ 前端拿站点级去补。这条锁住契约的后端那一半。
    const authBody = bodyOf('attach_authors');
    const nName = (authBody.match(/author_name = Some\(/g) || []).length;
    const nAvatar = (authBody.match(/author_avatar = Some\(/g) || []).length;
    ok(nName === 2 && nAvatar === 2,
        '★ 两个键成对写（有作者 / 没作者两个分支各写一对，不多不少）', { nName, nAvatar });
    const boundedMetadata = readFileSync(path.join(repo, 'src/routes/document_reads/metadata.rs'), 'utf8');
    ok(/authors::profiles\(/.test(authBody) && /authors::profiles\(/.test(boundedMetadata),
        '文章展示与有界读取复用公开作者投影');
    ok(!/unwrap_or_else\(\|\| site_avatar/.test(authBody),
        '★ 已无"这个字段空就退站点级"的老回退链');

    const entity = readFileSync(path.join(repo, 'src/entity/note.rs'), 'utf8');
    ok(/pub user_id: Option<i32>/.test(entity), '实体里有 user_id 列（Option = 老文章那批没有记录）');

    const sql = readFileSync(path.join(repo, 'scripts/migration/note_author_20261001.sql'), 'utf8');
    ok(/ADD COLUMN `user_id` int NULL/.test(sql), '迁移文件真的加这一列（可空 ⇒ 存量行不动）');
    ok(/note_author_20261001/.test(sql), '迁移带 flag（勿重跑）');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
