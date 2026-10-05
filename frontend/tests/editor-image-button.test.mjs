// ═ 编辑器图片按钮：改为「图库优先，也能电脑本地上传」（20261006，用户要求）══
//   node tests/editor-image-button.test.mjs
//
// 现场：`/dashboard/notes/newnote/` 正文编辑器（bytemd）工具栏里那颗图片按钮点下去直接弹
// 系统文件选择框，而图库里已经攒了一堆图 —— 写文章时更常见的动作是「从已有的图里挑一张」。
//
// 那颗按钮是 bytemd 的**内置 action**（`getBuiltinActions` 的 `leftActions[5]`），bytemd 没有
// 任何口子能换掉它：插件的 action 只能 `leftActions.push(...)` 追加到**末尾**（不能插位、不能
// 覆盖、不能删）；不传 `uploadImages` 虽然能让那颗图标消失，但同一个 prop 还闸着**拖拽与粘贴**
// 上传（`editor.svelte` 里 `if (!uploadImages) return`）。所以按钮原样留着，由
// `src/components/Editor/index.tsx` 在**捕获阶段**拦下它的点击、改开我们自己的图库弹窗 ——
// 工具栏的 DOM 与几何一行不动。
//
// **这个做法整个建在 bytemd 的内部形状上**，而它全是没写进文档、没进类型定义的细节：
// 下标 `5`、`bytemd-tippy-path` 这个属性名、左组图标是 `.bytemd-toolbar-left` 的**直接子元素**、
// 点击走 `.bytemd-toolbar` 上的冒泡 `on:click`。上游任何一个 `npm update` 都能把其中一条挪走，
// 而挪走之后**页面照样能打开、只是那颗按钮又变成弹系统文件框**（静默退回旧行为，没人会报错）。
// 本套件就是为这一刻准备的：读 bytemd 的源码把这几条逐字钉住，形状一变立刻红。
//
// ⚠️ 三个必须知道的前提（第 ⓿ 组钉的就是它们）：
//   1. 读的必须是**真正生效的那一份** bytemd —— 从 `@bytemd/react` 自己解析，比对本机顶层
//      目录（若哪天 npm 嵌了一套，本套件读的源码与页面跑的就不是同一份 = 什么都没证明）。
//   2. 选择器**必须**带 `.bytemd-toolbar-left` 前缀：右组（toc/帮助/写入/预览/全屏/**源码**）
//      也用同一个 `bytemd-tippy-path` 属性，而右组下标 5 是「源码」那颗（第 ② 组钉这条）。
//   3. 左组的图标**只在 `split` 时**渲染（容器 ≥800px），否则那一格是「书写/预览」两个页签
//      —— 我们的拦截器在这两种形态下都不会命中，这是预期（文章页编辑器是全宽）。
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 读仓库里的文件；**读不到就是红**（不是跳过 —— 守卫看不见源码等于守卫不存在）。 */
const readRel = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) { ok(false, `读得到 ${rel}`, abs); return null; }
    return readFileSync(abs, 'utf8');
};

/**
 * 契约三组读的那份 bytemd 源码住哪儿。
 *
 * 默认就是 `node_modules/bytemd`。`BYTEMD_SRC` 是给**负控自检**用的旁路：把源码复制一份、
 * 改几个字节（例如把图片那颗挪个位子）再跑一次，确认本套件真的会红 —— 守卫没被验证过红，
 * 就等于没写。它**不能**用来"换一个 bytemd"：第 ⓿ 组会断言这份副本的版本与被解析到的那份
 * 逐字一致（同版本、不同字节 = 正是上游改动的形态），换版本会被当场拦下。
 */
const bytemdDir = process.env.BYTEMD_SRC ? path.resolve(process.env.BYTEMD_SRC) : null;
const readVendor = (rel) => {
    const abs = path.join(bytemdDir || path.join(root, 'node_modules/bytemd'), rel);
    if (!existsSync(abs)) { ok(false, `读得到 bytemd/${rel}`, abs); return null; }
    return readFileSync(abs, 'utf8');
};

/** 空白归一：bytemd 的 svelte 输出换行缩进全无规律，逐字比对只能先摊平。 */
const flat = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * 从 `i`（指向 `[ { (` 之一）开始做括号配对，切出**成对的那一段**（含两端括号）。
 * 认字符串字面量与转义，认行注释（bytemd 的源码里这两种都有）。
 * 返回 `{ body, end }`；配不上对返回 null —— 调用方按红处理。
 */
function sliceBalanced(src, i) {
    const open = src[i];
    const close = { '[': ']', '{': '}', '(': ')' }[open];
    if (!close) return null;
    let depth = 0, quote = null, esc = false;
    for (let k = i; k < src.length; k++) {
        const c = src[k], n = src[k + 1];
        if (quote) {
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && n === '/') { while (k < src.length && src[k] !== '\n') k++; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return { body: src.slice(i + 1, k), end: k }; }
    }
    return null;
}

/** 把数组字面量的 body 按**顶层逗号**切成一项一项（嵌套对象/数组/字符串里的逗号不算）。 */
function splitTopLevel(body) {
    const items = [];
    let depth = 0, quote = null, esc = false, cur = '';
    for (let k = 0; k < body.length; k++) {
        const c = body[k], n = body[k + 1];
        if (quote) {
            cur += c;
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && n === '/') { while (k < body.length && body[k] !== '\n') { cur += body[k]; k++; } continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
        if (c === ',' && depth === 0) { items.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) items.push(cur);
    return items.map((x) => x.trim()).filter(Boolean);
}

/** 源码里 `const <name> = [` 的那个数组字面量 → 顶层项数组（找不到返回 null）。 */
function arrayLiteral(src, decl) {
    const at = src.indexOf(decl);
    if (at < 0) return null;
    const i = src.indexOf('[', at + decl.length - 1);
    if (i < 0) return null;
    const balanced = sliceBalanced(src, i);
    if (!balanced) return null;
    return splitTopLevel(balanced.body);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n⓿ 前提：读的必须是页面真正跑的那一份 bytemd');
// ═══════════════════════════════════════════════════════════════════════════════
// `@bytemd/react` 是页面里 `<Editor>` 的来源（它 `require('bytemd')`，自己不带一份源码 ——
// 只有 `dist/index.umd.js` 那个给 <script> 用的包才是打平的）。所以「bytemd 从哪儿解析」
// 就是「页面跑的是哪一份」。npm 一旦嵌一套不同版本进去，下面几组读到的源码就与线上无关了。
let pkgDir = null;
{
    const reactPkg = path.join(root, 'node_modules/@bytemd/react/package.json');
    ok(existsSync(reactPkg), '@bytemd/react 装着', reactPkg);
    if (existsSync(reactPkg)) {
        const req = createRequire(reactPkg);          // 从 @bytemd/react 自己出发解析
        let entry = null;
        try { entry = req.resolve('bytemd'); } catch (e) { ok(false, '@bytemd/react 能解析到 bytemd', String(e && e.message)); }
        if (entry) {
            let d = path.dirname(entry);
            while (!existsSync(path.join(d, 'package.json')) && path.dirname(d) !== d) d = path.dirname(d);
            const top = path.join(root, 'node_modules/bytemd');
            ok(realpathSync(d) === realpathSync(top),
                '它解析到的就是顶层 node_modules/bytemd（没有嵌套的另一份）', { resolved: d, top });
            if (realpathSync(d) === realpathSync(top)) {
                pkgDir = d;
                ok(existsSync(path.join(pkgDir, 'svelte/editor.js')), 'bytemd 带着 svelte/ 源码（不是只发 dist）');
                const ver = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
                console.log('    · 本机 bytemd 版本：' + ver + '（@bytemd/react 把它钉在确切版本上）');
                if (bytemdDir) {
                    // 负控旁路：只许换成**同版本**的另一份源码
                    const other = path.join(bytemdDir, 'package.json');
                    ok(existsSync(other), `BYTEMD_SRC 里有一份 package.json`, other);
                    if (existsSync(other)) {
                        const oVer = JSON.parse(readFileSync(other, 'utf8')).version;
                        ok(oVer === ver, `BYTEMD_SRC 的版本与生效的那份一致（${ver}）——旁路只用于负控自检`, oVer);
                    }
                    console.log('    ⚠️ BYTEMD_SRC 已设：下面三组读的是这份副本，不是 node_modules 里那份');
                }
            }
        }
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n① 内置左组 action 的次序：图片钉在下标 5');
// ═══════════════════════════════════════════════════════════════════════════════
let picIndex = null;
{
    const src = readVendor('svelte/editor.js');
    if (src) {
        const items = arrayLiteral(src, 'const leftActions = [');
        ok(Array.isArray(items) && items.length > 0, '切得出 `leftActions` 数组字面量', items && items.length);
        if (items) {
            // 每一项取它的 icon 名（没有 icon 的项不占位 —— 工具栏也只渲染有 handler 的）
            const iconNames = items.map((it) => {
                const m = it.match(/icon:\s*icons\.([A-Za-z0-9_]+)/);
                return m ? m[1] : null;
            });
            const expected = ['H', 'TextBold', 'TextItalic', 'Quote', 'LinkOne', 'Pic',
                'Code', 'CodeBrackets', 'ListTwo', 'OrderedList', 'DividingLine'];
            ok(JSON.stringify(iconNames) === JSON.stringify(expected),
                '左组图标次序与断言一致（下标 5 = Pic）', iconNames);

            const named = items.filter((it) => /icon:\s*icons\./.test(it));
            picIndex = named.findIndex((it) => /icon:\s*icons\.Pic\b/.test(it));
            ok(picIndex === 5, '图片那颗是数组里的第 6 项（下标 5）', picIndex);
            ok((src.match(/icons\.Pic\b/g) || []).length === 1,
                '整个 editor.js 里只有这一颗 `icons.Pic`（撞不上别的按钮）',
                (src.match(/icons\.Pic\b/g) || []).length);

            const pic = picIndex >= 0 ? flat(named[picIndex]) : '';
            ok(/title: locale\.image\b/.test(pic), '它挂的是 `locale.image`（中文本地化名字）', pic.slice(0, 60));
            // 图标在场的前提：handler 由 uploadImages 把关。传 undefined 时 item.handler 为
            // undefined ⇒ 工具栏 `{#if item.handler}` 不渲染它 —— 这正是"能藏起来"的那条路。
            ok(/handler: uploadImages \?/.test(pic) && /: undefined,/.test(pic),
                '它的 handler 是 `uploadImages ? … : undefined`（传空就不渲染）', pic.slice(-80));
            ok(items.filter((it) => /handler:\s*uploadImages/.test(it)).length === 1,
                '左组只有这一颗恒受 uploadImages 把关（所以不能靠不传 prop 来藏它）',
                items.filter((it) => /handler:\s*uploadImages/.test(it)).length);

            // 插件 action 只能追加到末尾 —— 这条是"为什么不换成自己的按钮"的全部理由
            ok(/plugins\.forEach\(\(\{\s*actions\s*\}\)/.test(flat(src)) && /leftActions\.push\(action\)/.test(flat(src)),
                '插件 action 只能 `leftActions.push(...)`（末尾追加，不能插位/覆盖/删）');
            const arrEnd = src.indexOf('const rightActions');
            ok(arrEnd > 0 && flat(src.slice(arrEnd, arrEnd + 400)).includes('leftActions.push(action)'),
                '这句 push 就在内置左组定义之后（内置项恒在前）');
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n② 工具栏 DOM 契约：左组直接子元素 + `bytemd-tippy-path`，点击是冒泡');
// ═══════════════════════════════════════════════════════════════════════════════
{
    const src = readVendor('svelte/toolbar.svelte');
    if (src) {
        const f = flat(src);
        // 左组：`.bytemd-toolbar-left` 的**直接子元素**，class 里带 bytemd-tippy，
        // 属性 bytemd-tippy-path = 该项在 leftActions 里的下标。整串连着断言：
        // 中间少一层 wrapper（或改成别的属性名）都会让我们的选择器失配。
        ok(f.includes(`<div class="bytemd-toolbar-left">{#if split}{#each actions as item, index}{#if item.handler}<div class={['bytemd-toolbar-icon', tippyClass].join(' ')} bytemd-tippy-path={index}`),
            '左组图标 = `.bytemd-toolbar-left` 的直接子元素，class 含 bytemd-tippy，带 bytemd-tippy-path={index}');
        // 左组图标只在 split（容器 ≥800px）时渲染；否则那一格是书写/预览页签
        ok(f.includes('{#if split}{#each actions as item, index}') && f.includes('{:else}<div on:click={() => dispatch(\'tab\', \'write\')}'),
            '左组图标只在 split 时渲染，否则是「书写/预览」页签（我们的拦截器届时不会命中）');

        // 右组：同一个属性名 + 多一个 bytemd-tippy-right ⇒ 单看 path 会撞车
        ok(f.includes(`<div class="bytemd-toolbar-right">{#each rightActions as item, index}{#if !item.hidden}<div class={['bytemd-toolbar-icon', tippyClass, tippyClassRight].join(' ')}`)
            && (src.match(/bytemd-tippy-path=\{index\}/g) || []).length >= 2,
            '右组也用同一个 bytemd-tippy-path（左右两组都带这个属性），只是 class 多一个 bytemd-tippy-right');

        const right = arrayLiteral(src, 'rightActions = [');
        ok(Array.isArray(right) && right.length >= 6, '切得出 toolbar.svelte 的 `rightActions` 数组', right && right.length);
        if (right) {
            // 右组下标 5 = 「源码」（github 那颗）。这就是选择器必须带 `.bytemd-toolbar-left`
            // 前缀的原因：不带前缀时，点「源码」也会被我们当成图片按钮拦下来。
            ok(/title: locale\.source\b/.test(flat(right[5] || '')),
                '右组下标 5 是「源码」按钮 ⇒ 选择器不带左组前缀就会误伤它', flat(right[5] || '').slice(0, 80));
        }

        // 点击路径：`.bytemd-toolbar` 上的**冒泡** on:click（不是 |capture）。
        // ⇒ 在更外层元素的捕获阶段 stopPropagation，这个 handler 永远收不到。
        ok(f.includes('class="bytemd-toolbar"') && f.includes('on:click={handleClick}'),
            '点击由 `.bytemd-toolbar` 上的 `on:click={handleClick}` 处理');
        ok(!/on:click\|capture/.test(f), '它不是 capture 阶段（否则我们拦不住）');
        ok(/function handleClick\(e\) { const target = e\.target\.closest\(`\[\$\{tippyPathKey\}\]`\)/.test(f),
            'handleClick 用 `e.target.closest([bytemd-tippy-path])` 定位按钮（我们的 stopPropagation 让它收不到事件）');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n③ 前提：omit `uploadImages` 会连拖拽/粘贴一起关掉 ⇒ 只能留按钮拦点击');
// ═══════════════════════════════════════════════════════════════════════════════
{
    const svSrc = readVendor('svelte/editor.svelte');
    if (svSrc) {
        const f = flat(svSrc);
        ok(/if \(!uploadImages\) return/.test(f),
            '拖拽/粘贴上传被 `if (!uploadImages) return` 闸住 ⇒ 不能靠不传 prop 来藏那颗图标');
        ok(/handleImageUpload\(context, uploadImages, files\)/.test(f),
            '拖拽/粘贴走的就是同一个 `handleImageUpload`（我们复用同一条上传路）');
        ok(/\$: actions = getBuiltinActions\(mergedLocale, plugins, uploadImages\)/.test(f),
            '内置 action 由 `getBuiltinActions(…, uploadImages)` 现场生成（左组下标就是这里定的）');
        ok(/split = mode === 'split' \|\| \(mode === 'auto' && containerWidth >= 800\)/.test(f),
            'split 的判据是容器 ≥800px（左组图标什么时候才存在）');
        // 上下文只经插件下发 —— 这是 index.tsx 拿 ctx 的唯一入口
        ok(/cbs = plugins\.map\(\(p\) => p\.editorEffect\?\.\(context\)\)/.test(f),
            '编辑器上下文只经 `editorEffect` 交给插件（拿 ctx 的唯一入口）');
        ok(/\.\.\.createEditorUtils\(codemirror, editor\)/.test(f),
            'context 里带 createEditorUtils（appendBlock / editor / codemirror 都从这来）');
    }

    const jsSrc = readVendor('svelte/editor.js');
    if (jsSrc) {
        const f = flat(jsSrc);
        // 单张插入的样子（我们必须逐字照抄，否则同一张图会产出两种 markdown）。
        // 关键在 alt：bytemd 写的是 `alt = alt ?? files[i].name` —— 它的拖拽/粘贴上传会拿
        // **文件名**当 alt。是我们的 uploadImages 回调恒返回 `alt: ''` 才让它落成空 alt。
        ok(f.includes('`![${alt}](${url}${title ? ` "${title}"` : \'\'})`')
            && f.includes('alt = alt ?? files[i].name')
            && f.includes(`.join('\\n\\n')`),
            'bytemd 自己插图 = `![alt](url)` — alt 由回调给的 `alt` 决定（我们恒给空串 ⇒ 与拖拽上传同形）');
        ok(/editor\.setSelection\(pos, codemirror\.Pos\(pos\.line \+ imgs\.length \* 2 - 2\)\)/.test(f),
            '光标落点 `pos.line + len*2 - 2`：单张时 = pos.line（我们写的就是它）');
        // 内置那颗按钮的 click 就是"开系统文件框" —— 这正是我们要顶掉的那个行为
        ok(/const fileList = await selectFiles\(\{ accept: 'image\/\*', multiple: true, \}\)/.test(f)
            && /if \(fileList\?\.length\)/.test(f),
            '内置 click = `selectFiles` 弹系统文件框（被我们拦下的就是这条路）');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n④ 我们自己的组件仍钉着这套契约（换了写法这条守卫就该跟着改）');
// ═══════════════════════════════════════════════════════════════════════════════
{
    const src = readRel('src/components/Editor/index.tsx');
    if (src) {
        const f = flat(src);
        const m = src.match(/const BUILTIN_IMAGE_ACTION = '([^']+)'/);
        ok(!!m, 'index.tsx 里那份选择器还在（常量 BUILTIN_IMAGE_ACTION）', m && m[1]);
        if (m) {
            const sel = m[1];
            ok(sel.startsWith('.bytemd-toolbar-left > .bytemd-toolbar-icon'),
                '选择器带 `.bytemd-toolbar-left >` 前缀（否则会拦到右组「源码」）', sel);
            const idx = sel.match(/\[bytemd-tippy-path="(\d+)"\]/);
            ok(!!idx, '选择器用 bytemd-tippy-path 定位', sel);
            // 这条是整份套件的收束：写死的下标必须等于第 ① 组算出来的下标。
            // 上游一改次序，这里立刻红 —— 提示语里带上新下标，改哪一行一目了然。
            ok(idx && picIndex !== null && Number(idx[1]) === picIndex,
                `写死的下标（${idx && idx[1]}）= bytemd 实际放图片的位置（${picIndex}）`, sel);
        }
        ok(/closest\?\.\(BUILTIN_IMAGE_ACTION\)/.test(f), '拦截器真的用这份选择器判定（不是只声明）');
        ok(/addEventListener\('click', onClickCapture, true\)/.test(f) && /removeEventListener\('click', onClickCapture, true\)/.test(f),
            '监听挂在包裹元素的**捕获阶段**（true）并成对卸载');
        ok(/e\.stopPropagation\(\)/.test(f), '命中即 stopPropagation（拦住向 .bytemd-toolbar 的冒泡派发）');
        ok(/const wrap = wrapRef\.current/.test(f) && /ref=\{wrapRef\}/.test(f),
            '监听器挂在编辑器外层那个 div 上（bytemd 工具栏在它里面）');
        ok(/editorEffect: \(ctx\) => \{ ctxRef\.current = ctx/.test(f),
            'ctx 从 editorEffect 里取（bytemd 只把上下文交给插件）');
        // 20261006：插入前先过一遍 `encodeAssetUrl`（地址里带空格时裸拼会整段退化成纯文本，
        // 见 `tests/asset-url.test.mjs` 与 `src/utils/assetUrl.ts`）。变的是**编码**，不是形状：
        // alt 仍是空串、url 仍是那一个 —— 所以下面第 ③ 组"与拖拽上传同形"的前提不变。
        ok(/appendBlock\(`!\[\]\(\$\{encodeAssetUrl\(url\)\}\)`\)/.test(f),
            '插入用 `appendBlock(\'![](encodeAssetUrl(url))\')`（地址先编码再拼 markdown）');
        ok(/setSelection\(pos, ctx\.codemirror\.Pos\(pos\.line\)\)/.test(f), '光标落在刚插入的那一行上');

        // 同一轮修掉的真缺陷：本仓失败一律 HTTP 200 + code:500
        ok(/response\.data\?\.code !== 200/.test(f), '上传判**业务码** code !== 200（不是 HTTP 状态）');
        ok(!/response\.status === 200/.test(f), '不再用 `response.status === 200` 判成功（恒真 ⇒ 假成功）');
        // bytemd 会把返回值 map/join 后 appendBlock ⇒ 空数组 = 插一个空行 + 按 `length*2-2`
        // 算出的负行号。成功那一支的形状（alt/title 都给空串）也一并钉住：alt 给空串正是
        // 上面第 ③ 组里"与拖拽上传同形"的前提。
        ok(!/return \[\];/.test(f), '失败不 `return [];`（会让 bytemd 插空行 + 负行号）');
        ok(/return \[\{ alt: '', url: encodeAssetUrl\(response\.data\.data\), title: '' \}\];/.test(f),
            '成功那一支仍返回 `{ alt: \'\', url, title: \'\' }`（alt 空串 ⇒ 插出来是 `![](url)`），url 已编码');
        ok(/throw new Error\(/.test(f), '失败改为 throw（调用方按"没拿到图片"处理）');
    }

    const picker = readRel('src/components/Editor/ImagePicker.tsx');
    if (picker) {
        const f = flat(picker);
        ok(/useState\('gallery'\)/.test(f), '默认页签是「图库」（用户要求：优先展示服务器上的图库）');
        ok(/key: 'gallery', label: '图库'/.test(f) && /key: 'local', label: '本地上传'/.test(f),
            '两个页签就是「图库」+「本地上传」');
        ok(/onPick\(img\.imageUrl\)/.test(f), '图库选中时递出去的是**库里那个原始地址**');
        ok(!/onPick\(resolveApiAssetUrl/.test(f), '递出去的不是 CDN 化后的地址（换公开域名就认不回桶了）');
        ok(/src=\{resolveApiAssetUrl\(img\.imageUrl\)\}/.test(f), 'CDN 化只用在缩略图 src 上');
        ok(/res\.data\?\.code !== 200/.test(f), '图库列表也判业务码');
        ok(/accept="image\/\*"/.test(f) && /Upload\.Dragger/.test(f), '本地上传仍是拖拽/点选（accept=image/*）');
    }
}

console.log('\n════ ' + pass + '/' + (pass + fail) + ' 项通过 ════\n');
process.exit(fail === 0 ? 0 : 1);
