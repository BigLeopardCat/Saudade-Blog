// ═ 后台「全部文章」的「公开文章」标记判据（20261006，用户第 1 条）══
//   node tests/note-visibility.test.mjs
//
// 现场（用户原话）：「博客 dashboard/notes 的全部文章页标签前加个公开文章。」
// 后台这个页签里公开/私密/草稿混在一起，而"站上到底看不看得见"要看的字段一直没在前端露过面
// （`NoteType` 里连键都没有），于是一眼看不出哪几篇是线上真能读到的。
//
// 判据是 `is_public && status != 'draft'`，**不是** `status === 'public'` —— 后者会漏标：
// `status` 列可空、老数据是 NULL，后端 `map_note` 把它兜成 `'published'`（那正是后台
// 「文章状态」列对老数据显示"未知状态"的同一个成因），而那些文章在站上大概率是公开可读的。
//
// 为什么这项进 CI：判据本身是纯函数（无 DOM 无 React），但它判的是**跨语言契约** ——
// 前端说"公开"、站上却说"看不到"（或反过来）是这类判据最典型的漂移。所以第 ③ 组直接读
// Rust 源码：全站那 6 处公开口径（`profile.rs::visible_note` 的函数式判据 + 5 处 sea-orm
// 双半过滤）形状一变就红，而不是等到某篇文章在卡片上公开、在后台被标成私密。
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

// 纯 TS（无 DOM 无 React）⇒ 摊平成 .mjs 直接 import
const out = mkdtempSync(path.join(tmpdir(), 'notevis-'));
const file = path.join(out, 'noteVisibility.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/noteVisibility.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const { isPubliclyVisible } = await import(pathToFileURL(file).href);

console.log('\n① 公开：`is_public` 为真且不是草稿');
{
    ok(isPubliclyVisible({ is_public: true, status: 'published' }) === true, 'bool true + published');
    ok(isPubliclyVisible({ is_public: 1, status: 'published' }) === true, '数字 1（原始行路径）+ published');
    ok(isPubliclyVisible({ is_public: true, status: 'public' }) === true, 'bool true + public');
    // 老数据的 `status` 是 NULL ⇒ 后端 `map_note` 兜成 'published'；键缺席也只可能是"没带这个字段"，
    // 而 `is_public` 说它公开 ⇒ 照标（这一条就是"漏标老文章"的正面否定）
    ok(isPubliclyVisible({ is_public: true }) === true, 'bool true + status 缺席（老数据/兜底 published）');
    ok(isPubliclyVisible({ is_public: 1, status: null }) === true, '数字 1 + status 显式 null');
}

console.log('\n② 不公开：草稿、私密、以及"其实没发布"');
{
    ok(isPubliclyVisible({ is_public: true, status: 'draft' }) === false, '草稿（is_public 为真也不算公开）');
    ok(isPubliclyVisible({ is_public: 1, status: 'draft' }) === false, '草稿（数字 1 形态）');
    ok(isPubliclyVisible({ is_public: false, status: 'published' }) === false, 'is_public=false + published');
    ok(isPubliclyVisible({ is_public: 0, status: 'published' }) === false, 'is_public=0 + published');
    ok(isPubliclyVisible({ status: 'public' }) === false,
        '**只有 status="public"、`is_public` 缺席 ⇒ 假**（不许用 status 单独判公开）');
}

console.log('\n③ 缺键 / 脏值一律算不公开（少标一颗绿标可见可追问；错标一颗是把错信息递给管理员）');
{
    ok(isPubliclyVisible({}) === false, '空对象');
    ok(isPubliclyVisible(null) === false, 'null');
    ok(isPubliclyVisible(undefined) === false, 'undefined（不传参）');
    ok(isPubliclyVisible() === false, '完全不传参');
    // 后端是 bool，字符串形态不该出现；真出现了也不认（宁可少标，不猜）
    ok(isPubliclyVisible({ is_public: 'true', status: 'published' }) === false, '字符串 "true" 不算真');
    ok(isPubliclyVisible({ is_public: '1', status: 'published' }) === false, '字符串 "1" 不算真');
    ok(isPubliclyVisible({ is_public: 2, status: 'published' }) === false, '既非 true 也非 1 的数值不算真');
}

console.log('\n④ 跨语言守卫：Rust 侧那 6 处公开口径还在（改一侧必须改另一侧）');
{
    const rust = (rel) => readFileSync(path.join(root, '..', rel), 'utf8');

    // (1) 函数式那处：与前端这句**逐字同源**
    const profile = rust('src/routes/profile.rs');
    ok(/fn visible_note/.test(profile), '`profile.rs::visible_note` 还在');
    ok(/n\.is_public\s*&&\s*n\.status\.as_deref\(\)\s*!=\s*Some\("draft"\)/.test(profile),
        '  判据还是 `n.is_public && n.status.as_deref() != Some("draft")`（= 这边的 `is_public && status !== "draft"`）');
    ok((profile.match(/visible_note\(/g) || []).length > 1, '  这个函数还被调用着（定义了没人用 = 白定义）');

    // (2) sea-orm 那 5 处：公开判据是**两半**（`IsPublic.eq(true)` + `Status.ne("draft")`），
    //     必须成对出现 —— 只写一半就是"草稿漏进公开列表"或"私密文章被当公开"。
    //     判据取"同一个文件里两半的数量相等"，比钉具体行号稳（增删查询不会误红），
    //     又能在"新加一条公开查询却忘了 draft 那一半"时立刻红。
    const sites = [
        'src/routes/notes.rs',
        'src/routes/tags.rs',
        'src/routes/comments.rs',
        'src/routes/note_stats.rs',
        'src/routes/sitemap.rs',
    ];
    for (const rel of sites) {
        const src = rust(rel);
        const pub = (src.match(/IsPublic\.eq\(true\)/g) || []).length;
        const draft = (src.match(/Status\.ne\("draft"\)/g) || []).length;
        ok(pub > 0 && pub === draft,
            `  ${rel}：\`IsPublic.eq(true)\` ${pub} 处 / \`Status.ne("draft")\` ${draft} 处，成对`,
            { pub, draft });
    }
}

console.log('\n⑤ 前端真的用上了（写了没人用 = 白写；且标记不许吃掉折叠标签的名额）');
{
    const noteType = readFileSync(path.join(root, 'src/interface/NoteType.d.ts'), 'utf8');
    ok(/^\s*is_public\?:/m.test(noteType),
        '`NoteType` 里声明了 `is_public`（键名照后端原样，后端这个字段没有 serde rename）');

    const allNotes = readFileSync(path.join(root, 'src/pages/Dashboard/Notes/AllNotes/index.tsx'), 'utf8');
    ok(/import\s*\{\s*isPubliclyVisible\s*\}/.test(allNotes), '「全部文章」页 import 了 `isPubliclyVisible`');
    const cell = allNotes.indexOf('公开文章');
    const collapsed = allNotes.indexOf('renderNoteTagsCollapsed(record.noteTags, tagList, 3)');
    ok(cell > 0 && collapsed > cell,
        '绿标画在 `renderNoteTagsCollapsed(...)` **之前**（排在最左，不被折叠器吃掉）');
    ok(/isPubliclyVisible\(record\)\s*&&/.test(allNotes), '  用判据函数守门，而不是就地读 `record.is_public`');
    ok(!/record\.is_public/.test(allNotes),
        '  页面里没有就地读 `record.is_public` 的地方（判据只许有一处）');
    ok(/renderNoteTagsCollapsed\(record\.noteTags, tagList, 3\)/.test(allNotes),
        '  折叠名额仍是 3（绿标不占名额 —— 它是文章状态、不是一枚标签）');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
