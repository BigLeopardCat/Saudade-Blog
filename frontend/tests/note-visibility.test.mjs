// ═ 公开口径的跨语言守卫（20261006）══
//   node tests/note-visibility.test.mjs
//
// 本文件的前身是「后台那颗『公开文章』绿标」的纯函数锁。绿标已于同日**撤销**（用户第 5 条：
// 文章状态字段本来就有，重画一遍多余），前端那份自算口径的 `utils/noteVisibility.ts` 一并
// 删除 —— 于是这里只剩下一件仍然值得锁的事：**公开口径只有后端一处**。
//
// 为什么要单独一个文件盯着它：这是**跨语言契约**里最容易漂的一条。前端说"公开"、站上却说
// "看不到"（或反过来）不会有任何报错，只会静默地把错信息递给管理员/访客。历史上前端那份
// 自算实现就已经漂了：它把 `status` 为 NULL 的老行当公开，而后端走的是 `Status.ne("draft")`
// 的 SQL 三值逻辑（NULL 行**不**满足 `!= 'draft'`）⇒ 两边对同一篇文章给出相反的答案。
//
// 现在只有一个口径，它有**两种写法**，本文件把两种都钉住：
//   ① 函数式：`profile.rs::visible_note` 的 `n.is_public && n.status.as_deref() != Some("draft")`；
//   ② sea-orm 谓词式：`IsPublic.eq(true)` + `Status.ne("draft")` **成对**出现（只写一半就是
//      "草稿漏进公开列表"或"私密文章被当公开"）。判据取"同一个文件里两半的数量相等"，比钉
//      具体行号稳（增删查询不会误红），又能在"新加一条公开查询却漏了 draft 那一半"时立刻红。
// 后台「公开文章」页签（`search_all_notes` 的 `only_public`）落地后，两种写法的计数各 +1，
// 「成对相等」照旧成立 —— 这也是这条判据当初选"计数"而不是"钉行号"的收益。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const rust = (rel) => readFileSync(path.join(root, '..', rel), 'utf8');

console.log('\n① 函数式那一处：`profile.rs::visible_note`');
{
    const profile = rust('src/routes/profile.rs');
    ok(/fn visible_note/.test(profile), '`profile.rs::visible_note` 还在');
    ok(/n\.is_public\s*&&\s*n\.status\.as_deref\(\)\s*!=\s*Some\("draft"\)/.test(profile),
        '  判据还是 `n.is_public && n.status.as_deref() != Some("draft")`');
    ok((profile.match(/visible_note\(/g) || []).length > 1, '  这个函数还被调用着（定义了没人用 = 白定义）');
}

console.log('\n② sea-orm 那几处：公开判据是两半，必须成对');
{
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

console.log('\n③ 后台「公开文章」页签（`notes.rs` 的 `only_public`）用的是同一口径');
{
    const notes = rust('src/routes/notes.rs');
    ok(/pub only_public: Option<bool>/.test(notes),
        '`SearchRequest` 里有 `only_public`（前端页签的入参）');
    // 只看那一支自己的块，不看全文 —— 否则"别处有这三个谓词"也能把它蒙混过去。
    const m = notes.match(/if let Some\(true\) = payload\.only_public \{([\s\S]*?)\n    \}/);
    ok(!!m, '  `if let Some(true) = payload.only_public { … }` 这一支真落地了（不是只加了字段）');
    const blk = m ? m[1] : '';
    ok(/IsPublic\.eq\(true\)/.test(blk), '  块里有 `is_public = true`');
    ok(/Status\.ne\("draft"\)/.test(blk), '  块里有 `status != \'draft\'`');
    // 前两条与 list_public_notes 同口径；这条与 list_all_notes 一致 —— 少了它「公开 ⊂ 全部文章」
    // 不成立（编辑修改稿的影子行会同时出现在两个页签里）。
    ok(/DraftOf\.is_null\(\)/.test(blk), '  块里有 `draft_of IS NULL`（排掉编辑修改稿的影子行）');
}

console.log('\n④ 前端不再自算口径（口径只有一处，删掉的别再回来）');
{
    ok(!existsSync(path.join(root, 'src/utils/noteVisibility.ts')),
        '`src/utils/noteVisibility.ts` 已删（它把 status 为 NULL 的老行当公开，与后端不一致）');
    const allNotes = readFileSync(path.join(root, 'src/pages/Dashboard/Notes/AllNotes/index.tsx'), 'utf8');
    ok(!/isPubliclyVisible|noteVisibility/.test(allNotes),
        '  「全部文章」页不再引用那份判据');
    ok(!/record\.is_public/.test(allNotes),
        '  页面里也没有就地读 `record.is_public` 的地方（要看公开的走页签，筛选在后端做）');
    // 绿标撤了，标签列回归单一职责：只画标签（且折叠名额仍是 3）。
    ok(/render: \(_, record\) => renderNoteTagsCollapsed\(record\.noteTags, tagList, 3\)/.test(allNotes),
        '  标签列就是 `renderNoteTagsCollapsed(record.noteTags, tagList, 3)`，没有前缀块了');
    ok(!/公开文章[\s\S]{0,200}<Tag color="green"/.test(allNotes),
        '  那颗绿标没有留在标签列里');
    // 但「公开文章」这四个字还必须在场 —— 它现在是**页签**（key '4'），不是标签。
    ok(/\{\s*\n\s*label: '公开文章',\s*\n\s*key: '4',/.test(allNotes),
        "  「公开文章」改由页签承载（label '公开文章' + key '4'）");
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
