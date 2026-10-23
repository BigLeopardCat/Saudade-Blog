// Both legacy and typed article tag inputs share one transactional writer.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');   // 父仓根

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 剥掉行注释与块注释（**跳过字符串字面量**，免得把 URL 里的 `//` 当注释起点）。 */
const stripComments = (src) => {
    const b = [...src];
    let out = '';
    let i = 0;
    while (i < b.length) {
        if (b[i] === '"') {
            out += b[i]; i++;
            while (i < b.length && b[i] !== '"') {
                if (b[i] === '\\' && i + 1 < b.length) { out += b[i]; i++; }
                out += b[i]; i++;
            }
            if (i < b.length) { out += b[i]; i++; }
        } else if (b[i] === '/' && b[i + 1] === '/') {
            while (i < b.length && b[i] !== '\n') i++;
        } else if (b[i] === '/' && b[i + 1] === '*') {
            i += 2;
            while (i + 1 < b.length && !(b[i] === '*' && b[i + 1] === '/')) i++;
            i = Math.min(i + 2, b.length);
        } else { out += b[i]; i++; }
    }
    return out;
};

/** 顶层函数的函数体（到下一个行首 `}` 为止；本仓顶层函数都这么收尾）。 */
const fnBody = (src, name) => {
    const i = src.indexOf(`fn ${name}`);
    if (i < 0) return null;
    const next = src[i + 3 + name.length];
    if (next !== '(' && next !== '<') return null;
    const j = src.indexOf('\n}', i);
    return j < 0 ? null : src.slice(i, j);
};

/** Production Rust modules; dedicated tests are verified by cargo test. */
const walkSrc = () => {
    const out = [];
    const stack = [path.join(root, 'src')];
    while (stack.length) {
        const d = stack.pop();
        for (const e of readdirSync(d)) {
            const p = path.join(d, e);
            if (statSync(p).isDirectory()) { stack.push(p); continue; }
            if (!p.endsWith('.rs') || path.basename(p) === 'tests.rs' ||
                path.basename(p).endsWith('_tests.rs')) continue;
            out.push([path.relative(root, p), stripComments(readFileSync(p, 'utf8'))]);
        }
    }
    return out;
};

const NT = 'src/routes/note_tags.rs';
const FILES = walkSrc();
const nt = FILES.find(([p]) => p === NT)?.[1];
const notes = FILES.find(([p]) => p === 'src/routes/notes.rs')?.[1];

console.log('\n① 两种输入共用一个类型明确的事务写点');
{
    ok(!!nt, `${NT} 在`);
    const body = nt ? fnBody(nt, 'replace_typed_note_tags') : null;
    ok(body !== null, '  类型明确的公共写点还在');
    if (body) {
        ok(/note_tag::Entity::delete_many/.test(body), '  它先删这一篇现有的关联行');
        ok(/note_tag::Entity::insert_many/.test(body), '  再按解析结果整批插回去');
        // soak 期那一半：同时写 `note.tags` 那一列。`0007` 落地时这里会删掉，
        // 那时**这条断言必须跟着改**（改的人会看到它红，这正是它存在的意义）。
        ok(/\.tags\s*=\s*(sea_orm::)?Set\(/.test(body), '  并把 `note.tags` 那一列同步成同一份解析结果');
    }
}

console.log('\n② 没有第二条路能写那张表 / 那一列');
{
    // `note_tag` 的写调用只许出现在 `note_tags.rs`。
    const writers = [];
    for (const [p, src] of FILES) {
        if (p === NT) continue;
        for (const m of src.matchAll(/note_tag::Entity::(delete_many|insert_many|update_many|insert|update|delete)/g)) {
            writers.push(`${p}: ${m[0]}`);
        }
    }
    ok(writers.length === 0, '  别的文件里没有对 `note_tag` 的写调用', writers);

    // `note.tags` 那一列：全仓**一处都不许再读**（`Column::Tags` 零处），
    // 写只许在 `replace_note_tags` 里那一处。
    const colHits = FILES.filter(([, s]) => /Column::Tags/.test(s)).map(([p]) => p);
    ok(colHits.length === 0,
        '  全仓没有一处再引用 `note::Column::Tags`（读路径必须走关联表）', colHits);

    const colWrites = [];
    for (const [p, src] of FILES) {
        for (const m of src.matchAll(/\.tags\s*=\s*(?:sea_orm::)?Set\(/g)) {
            colWrites.push(p);
        }
    }
    ok(colWrites.length === 1 && colWrites[0] === NT,
        `  写那一列的地方只有 ${NT} 一处（现在：${colWrites.join(', ') || '无'}）`, colWrites);

    // ⚠️ **`note` 模型上的 `tags` 字段读**（`.tags.clone()` / `.tags.as_deref()` 这一族）
    // 也要一起管住：`Column::Tags` 那条断言只看 sea-orm 的**列枚举**，而
    // `let x = n.tags.clone();`（`n` 是 `note::Model`）走的是**模型字段**，它读的是同一列
    // 却一个字都不含 `Column::Tags` —— 这个洞 20261018 真的存在过两处
    // （`resolve_autosave_target` 克隆修改稿、`autosave_note` 沿用现有标签），
    // 两条都在 soak 期把"那一列可能已经陈旧"请进了读路径。
    // 认法 = `.tags` 后面跟着一个**取值**动作；不认裸 `.tags`，因为 DTO 侧
    // （`payload.tags` / `req.tags`）也长这样，那半边是合法的（它的来源是请求体，不是库）。
    const READ = /\.tags\s*\.\s*(?:clone|as_deref|as_ref|is_some|is_none|unwrap|map|take|to_owned)\b/;
    // DTO 侧（`payload.tags` / `req.tags`）长着一模一样的形状，但它的来源是**请求体**，
    // 不是库 —— 这一条排除是"认得出模型字段读"这件事的一半（另一半是 `READ` 那个形状）。
    const modelTagsRead = (line) => READ.test(line) && !/payload\.tags|req\.tags/.test(line);
    // 判据自己的正控：剥注释之后，真代码里的那一族必须**抓得到**（抓不到就是恒绿）。
    ok(modelTagsRead(stripComments('let t = n.tags.clone();')),
        '  正控：`.tags.clone()` 这种模型字段读抓得到');
    ok(!modelTagsRead(stripComments('let t = payload.tags.clone(); // 这是 DTO，合法')),
        '  反控：DTO 上的 `.tags.clone()` 不报（`payload` 的来源是请求体，不是库）');
    const readers = [];
    for (const [p, src] of FILES) {
        if (p === NT) continue;
        for (const line of src.split('\n')) {
            if (modelTagsRead(line)) {
                readers.push(`${p}: ${line.trim()}`);
            }
        }
    }
    ok(readers.length === 0,
        '  没有一处再读 `note` 模型的 `tags` 字段（读路径必须走关联表）', readers);

    // 改指向也只有一个出口（移动标签那条路）：`update_many` 只许出现在 `move_tag_refs` 里。
    const ntWrites = [...(nt || '').matchAll(/note_tag::Entity::update_many/g)].length;
    const moveBody = nt ? fnBody(nt, 'move_tag_refs') : null;
    ok(ntWrites === 1 && moveBody !== null && /note_tag::Entity::update_many/.test(moveBody),
        '  `note_tag` 的 `update_many` 只出现在 `move_tag_refs` 里');
}

console.log('\n③ 四条写路径都调它（漏一条 = 那条路上标签不再被保存）');
{
    // 三条在 `notes.rs`，一条是自动保存的"克隆原行"那一支。
    for (const fn of ['create_note', 'update_note', 'autosave_note']) {
        const body = notes ? fnBody(notes, fn) : null;
        ok(body !== null, `  \`notes.rs::${fn}\` 还在`);
        ok(!!body && /replace_note_tags\(/.test(body), `  ${fn} 调了 \`replace_note_tags\``);
    }
    // `update_note` 那条路有个**必须存在**的条件判断：没带 `noteTags` 就不许动标签
    // （后台的快速改状态、agent 的 `set_article_status` 都不带它 —— 无条件调会把标签清光）。
    const upd = notes ? fnBody(notes, 'update_note') : null;
    ok(!!upd && /new_tags\.is_some\(\)/.test(upd),
        '  `update_note` 只在带了 `noteTags` 时才动标签（否则快速改状态会把标签清光）');

    const revision = notes ? fnBody(notes, 'resolve_autosave_target') : null;
    ok(!!revision && /note_tags::copy_note_tags\(/.test(revision),
        '  修改稿直接复制有层级的标签引用');
    const copy = nt ? fnBody(nt, 'copy_note_tags') : null;
    ok(!!copy && /note_tag_rows\(/.test(copy) && /replace_typed_note_tags\(/.test(copy),
        '  复制读取关联表并复用同一个类型明确的写点');
    const autosave = notes ? fnBody(notes, 'autosave_note') : null;
    ok(!!autosave && /note_tags::current_tags\(/.test(autosave),
        '  自动保存的兼容输入从关联表派生');

}

console.log('\n④ 移动标签：**先改指向、再删旧标签行**（顺序反了会被外键静默带走）');
{
    // 这一条读**未剥注释**的原文：那条纪律住在注释里（代码本身看不出顺序为什么重要）。
    const ntRaw = readFileSync(path.join(root, NT), 'utf8');
    ok(/ON DELETE CASCADE/.test(ntRaw) && /删(掉)?旧标签行之前/.test(ntRaw),
        '  `move_tag_refs` 的注释里写着"必须在删旧标签行之前调"（这条纪律代码本身看不出来）');

    const moveSrc = FILES.find(([p]) => p === 'src/routes/tags.rs')?.[1] || '';
    const dm = fnBody(moveSrc, 'do_move');
    ok(dm !== null, '  `tags.rs::do_move` 还在');
    if (dm) {
        const firstRefs = dm.indexOf('move_tag_refs(');
        const lastDelete = dm.lastIndexOf('delete_by_id(spec.id)');
        ok(firstRefs >= 0, '  `do_move` 调了 `move_tag_refs`');
        // ⚠️ 这一条是**文本先后**判据：`move_tag_refs(` 必须出现在 `delete_by_id(spec.id)` 之前。
        // 顺序反了的后果是**静默**的（外键 CASCADE 把关联行带走、事务照常提交），
        // 所以只能靠这条看着有点笨的判据钉住。
        ok(firstRefs >= 0 && lastDelete > firstRefs,
            '  改指向出现在删旧标签行之前（反了的话外键 CASCADE 会把关联行静默删掉）');
        // 两个分支（降级 / 升级）各一次 —— 只改一个分支的话另一条路会静默丢标签。
        ok((dm.match(/move_tag_refs\(/g) || []).length === 2,
            `  降级与升级两个分支各调一次（现在 ${(dm.match(/move_tag_refs\(/g) || []).length} 次）`);
    }
    // 旧的那一族字符串助手不许回来（它们的活已经由关联表接管）。
    const dead = ['remap_tag_ids', 'note_refs_tag', 'swap_tag_refs', 'prune_note_tags']
        .filter((n) => new RegExp(`fn\\s+${n}\\b`).test(moveSrc));
    ok(dead.length === 0, '  四个字符串助手（重映射 / 引用判定 / 改写引用 / 清理悬空）没有回来', dead);
}

console.log('\n⑤ 改动关联表的另外两条路，都要把 `note.tags` 那一列重算回来');
{
    // 关联行有**三条不经过 `replace_note_tags`** 的改动路径：删标签（外键 CASCADE 把行带走）、
    // 跨表移动改了 id（`move_tag_refs` 换列换值）、以及 `0006` 的回填（它由预检保证两边本来就一致）。
    // 前两条会让那一列**静默陈旧** —— 陈旧本身看不见（读路径全在关联表上），但它会让 `0007`
    // 的预检把"删列"拦下来，而那时你拿到的是一句"两边漂了"、却找不到漂在哪。
    // 所以这两条路必须自己调 `resync_tags_column` 把它算回来。
    const tags = FILES.find(([p]) => p === 'src/routes/tags.rs')?.[1] || '';
    for (const fn of ['delete_tags', 'do_move']) {
        const body = fnBody(tags, fn);
        ok(body !== null, `  \`tags.rs::${fn}\` 还在`);
        ok(!!body && /resync_tags_column\(/.test(body),
            `  ${fn} 调了 \`resync_tags_column\`（否则那一列会静默陈旧、0007 的预检会莫名其妙地红）`);
    }
    // 这一列只在 `note_tags.rs` 里写（与 ② 同一条纪律），`resync` 也必须走 `replace_typed_note_tags`
    // 而不是自己另开一条 `UPDATE note SET tags = …`。
    const rs = nt ? fnBody(nt, 'resync_tags_column') : null;
    ok(!!rs && /replace_typed_note_tags\(/.test(rs) && !/note::Entity|update_many/.test(rs),
        '  `resync_tags_column` 自己不开写路径，走 `replace_typed_note_tags`');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
console.log('⚠️ 本文件只证明"写路径只有一条"，证明不了"存对了"——后者靠 tests/pg_integration.rs 那一族。');
process.exit(fail === 0 ? 0 : 1);
