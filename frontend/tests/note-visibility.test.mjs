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
//   ① 函数式：`profile.rs::visible_flags` 的
//      `is_public && matches!(status, Some("public") | Some("published"))`；
//   ② sea-orm 谓词式：`IsPublic.eq(true)` + `Status.is_in(public_status_words())` **成对**
//      出现（只写一半就是"草稿漏进公开列表"或"私密文章被当公开"）。判据取"同一个文件里两半
//      的数量相等"，比钉具体行号稳（增删查询不会误红），又能在"新加一条公开查询却漏了状态
//      那一半"时立刻红。
// 后台「公开文章」页签（`search_all_notes` 的 `only_public`）落地后，两种写法的计数各 +1，
// 「成对相等」照旧成立 —— 这也是这条判据当初选"计数"而不是"钉行号"的收益。
//
// ⚠️ **20261018 口径翻面**：此前第 ② 半是 `Status.ne("draft")` —— 那是**黑名单**，任何没
// 见过的词（含 NULL）都不在排除名单里 ⇒ **漏过去**。一条 `status='private'` 而
// `is_public=true` 的行会被公开列出（`update_note` 只带 `{"is_public":true}` 就能造出来）。
// 现在翻成白名单 `Status.is_in(public_status_words())`：未知词与 NULL 从"放行"变"拦截"。
// 本文件因此多一条**全局**判据（⑤ 节）：`src/routes/` 下**一个 `Status.ne("draft")` 都不许剩**
// —— 那才是"翻面翻干净了"的判据；只查计数成对的话，漏掉一处反而会让计数一起变小、照样绿。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

console.log('\n① 函数式那一处：`profile.rs::visible_flags`');
{
    const profile = rust('src/routes/profile.rs');
    ok(/fn visible_flags/.test(profile), '`profile.rs::visible_flags` 还在');
    ok(/is_public\s*&&\s*matches!\(status,\s*Some\("public"\)\s*\|\s*Some\("published"\)\)/.test(profile),
        '  判据是白名单 `is_public && matches!(status, Some("public") | Some("published"))`');
    ok((profile.match(/visible_flags\(/g) || []).length > 1, '  这个函数还被调用着（定义了没人用 = 白定义）');
    ok(!/fn visible_note/.test(profile),
        '  旧的 `visible_note(&note::Model)` 已退休（两个调用点都改成只取两列了，留着就是死代码）');
}

console.log('\n② sea-orm 那几处：公开判据是两半，必须成对');
{
    // `search.rs` 20261018 补进来 —— 它一直在做公开文章过滤，此前**漏在这个名单外**。
    // `tags.rs` 同一天**换成 `note_tags.rs`**：那一对谓词原来住在
    // `tags.rs::public_note_tag_counts` 里，而那个函数连同"数标签篇数"这件事整体搬到了
    // `note_tags.rs::public_tag_counts`（引用关系从 `note.tags` 那列挪进了关联表）。
    // ⚠️ 这一条**必须跟着搬**，否则守卫会在"文件里没有那对谓词"上红 —— 而它红的理由
    // （"这一处漏了状态谓词"）与真实情况（"这一处搬走了"）**完全不同**。
    const sites = [
        'src/routes/notes.rs',
        'src/routes/note_tags.rs',
        'src/routes/comments.rs',
        'src/routes/note_stats.rs',
        'src/routes/sitemap.rs',
        'src/routes/search.rs',
    ];
    for (const rel of sites) {
        const src = rust(rel);
        const pub = (src.match(/IsPublic\.eq\(true\)/g) || []).length;
        const vis = (src.match(/Status\.is_in\(/g) || []).length;
        ok(pub > 0 && pub === vis,
            `  ${rel}：\`IsPublic.eq(true)\` ${pub} 处 / \`Status.is_in(\` ${vis} 处，成对`,
            { pub, vis });
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
    ok(/Status\.is_in\(public_status_words\(\)\)/.test(blk),
        '  块里的状态谓词是**同一个白名单函数**（不是又抄一份词表）');
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

console.log('\n⑤ 黑名单翻面翻干净了：`src/routes/` 下一个 `Status.ne("draft")` 都不许剩');
{
    // 这一条是"翻面"的**唯一硬判据**：上面 ② 只查"两半计数成对"，而漏改一处会让
    // 两个计数**一起变小**、照样绿。只有"一个都不许剩"才拦得住"改了一半"。
    const dir = path.join(root, '..', 'src', 'routes');
    const offenders = [];
    for (const f of readdirSync(dir)) {
        if (!f.endsWith('.rs')) continue;
        const src = readFileSync(path.join(dir, f), 'utf8');
        if (/Status\.ne\("draft"\)/.test(src)) offenders.push(f);
    }
    ok(offenders.length === 0,
        '  src/routes/ 下没有 `Status.ne("draft")` 了（黑名单 = 未知词与 NULL 都会漏过去）',
        offenders);
}

console.log('\n⑥ 口径只有一处：白名单词表不许有第二份定义');
{
    const notes = rust('src/routes/notes.rs');
    ok(/pub\(crate\) fn public_status_words\(\)/.test(notes),
        '`notes.rs::public_status_words` 是白名单词表的定义处');
    // 定义只该在 `notes.rs`（`src/routes/` 下）；`src/` 顶层那份也一起扫，防有人把它搬走。
    const rsFiles = [];
    for (const rel of ['src', 'src/routes']) {
        const dir = path.join(root, '..', rel);
        for (const f of readdirSync(dir)) {
            if (f.endsWith('.rs')) rsFiles.push({ rel, f, src: readFileSync(path.join(dir, f), 'utf8') });
        }
    }
    const defs = rsFiles.filter((x) => /fn public_status_words\(/.test(x.src)).map((x) => `${x.rel}/${x.f}`);
    ok(defs.length === 1, `全仓只有一份 \`public_status_words\`（现在 ${defs.length} 份：${defs.join(', ')}）`);
    // 谁都可以调它，但**不许**在别处另写一份 `["public","published"]` 字面量。
    const dupes = rsFiles
        .filter((x) => !(x.rel === 'src/routes' && x.f === 'notes.rs'))
        .filter((x) => /"public"\s*,\s*"published"/.test(x.src))
        .map((x) => `${x.rel}/${x.f}`);
    ok(dupes.length === 0, '  别的文件里没有另抄一份词表字面量', dupes);
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
