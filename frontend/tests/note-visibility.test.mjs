// Cross-language visibility contract and article-list rendering boundaries.

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

ok(/\.filter\(super::notes::public_condition\(\)\)/.test(rust('src/routes/search.rs')), '聚合搜索复用共享公开判据');

console.log('\n③ 后台「公开文章」页签（`notes.rs` 的 `only_public`）用的是同一口径');
{
    const notes = rust('src/routes/notes.rs');
    ok(/pub only_public: Option<bool>/.test(notes),
        '`SearchRequest` 里有 `only_public`（前端页签的入参）');
    // 后端把共享公开判据提取为 public_condition；既验证调用点使用它，
    // 也验证函数体的三项谓词，不能用“全文里碰巧有这些字段”蒙混过去。
    const m = notes.match(/if let Some\(true\) = payload\.only_public \{([\s\S]*?)\n    \}/);
    ok(!!m, '  `only_public` 分支存在');
    ok(/condition\s*=\s*condition\.add\(public_condition\(\)\)/.test(m?.[1] || ''),
        '  分支把共享公开判据与既有条件 AND 组合');
    const predicate = notes.match(/fn public_condition\(\) -> Condition \{([\s\S]*?)\n\}/)?.[1] || '';
    ok(/Condition::all\(\)/.test(predicate), '  共享判据的各项是 AND 组合');
    ok(/IsPublic\.eq\(true\)/.test(predicate), '  共享判据有 `is_public = true`');
    ok(/Status\.is_in\(public_status_words\(\)\)/.test(predicate),
        '  共享判据调用唯一状态白名单函数');
    ok(/DraftOf\.is_null\(\)/.test(predicate), '  共享判据排除编辑修改稿');
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
    ok(/render: \(_, record\) => renderNoteTagsCollapsed\(record\.noteTags, tagList, 3, record\.noteTagRefs\)/.test(allNotes),
        '  标签列就是 `renderNoteTagsCollapsed(record.noteTags, tagList, 3, record.noteTagRefs)`，没有前缀块了');
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
