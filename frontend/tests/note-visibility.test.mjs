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

console.log('\n① SeaORM 公开查询同时限定可见性与状态');
{
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

console.log('\n② 后台公开文章页签复用共享判据');
{
    const notes = rust('src/routes/notes.rs');
    ok(/pub only_public: Option<bool>/.test(notes),
        '`SearchRequest` 里有 `only_public`（前端页签的入参）');
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

console.log('\n③ 前端使用后端可见性筛选');
{
    ok(!existsSync(path.join(root, 'src/utils/noteVisibility.ts')),
        '`src/utils/noteVisibility.ts` 已删（它把 status 为 NULL 的老行当公开，与后端不一致）');
    const allNotes = readFileSync(path.join(root, 'src/pages/Dashboard/Notes/AllNotes/index.tsx'), 'utf8');
    ok(!/isPubliclyVisible|noteVisibility/.test(allNotes),
        '  「全部文章」页不再引用那份判据');
    ok(!/record\.is_public/.test(allNotes),
        '  页面里也没有就地读 `record.is_public` 的地方（要看公开的走页签，筛选在后端做）');
    ok(/render: \(_, record\) => renderNoteTagsCollapsed\(record\.noteTags, tagList, 3, record\.noteTagRefs\)/.test(allNotes),
        '  标签列就是 `renderNoteTagsCollapsed(record.noteTags, tagList, 3, record.noteTagRefs)`，没有前缀块了');
    ok(!/公开文章[\s\S]{0,200}<Tag color="green"/.test(allNotes),
        '  那颗绿标没有留在标签列里');
    ok(/\{\s*\n\s*label: '公开文章',\s*\n\s*key: '4',/.test(allNotes),
        "  「公开文章」改由页签承载（label '公开文章' + key '4'）");
}

console.log('\n④ 查询不能仅排除草稿状态');
{
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

console.log('\n⑤ 状态白名单只有一份定义');
{
    const notes = rust('src/routes/notes.rs');
    ok(/pub\(crate\) fn public_status_words\(\)/.test(notes),
        '`notes.rs::public_status_words` 是白名单词表的定义处');
    const rsFiles = [];
    for (const rel of ['src', 'src/routes']) {
        const dir = path.join(root, '..', rel);
        for (const f of readdirSync(dir)) {
            if (f.endsWith('.rs')) rsFiles.push({ rel, f, src: readFileSync(path.join(dir, f), 'utf8') });
        }
    }
    const defs = rsFiles.filter((x) => /fn public_status_words\(/.test(x.src)).map((x) => `${x.rel}/${x.f}`);
    ok(defs.length === 1, `全仓只有一份 \`public_status_words\`（现在 ${defs.length} 份：${defs.join(', ')}）`);
    const dupes = rsFiles
        .filter((x) => !(x.rel === 'src/routes' && x.f === 'notes.rs'))
        .filter((x) => /"public"\s*,\s*"published"/.test(x.src))
        .map((x) => `${x.rel}/${x.f}`);
    ok(dupes.length === 0, '  别的文件里没有另抄一份词表字面量', dupes);
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
