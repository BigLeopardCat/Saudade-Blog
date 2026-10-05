// ═ 插图地址的编码：CI 断言套件（20261006，用户第 2 条）══
//   node tests/asset-url.test.mjs
//
// 现场（用户原话）：「![](...)这张图片为什么没渲染。」
//
// 病根不在文件、不在解码：上传时文件名 = 时间戳 + **原名（空格原样留着）**，而插入正文时
// 是裸拼 `![](${url})`。CommonMark 的 link destination（不带尖括号那种）**不允许出现空白
// 字符** ⇒ 整段不是"图片裂了"，而是**退化成纯文本**：渲染出来是一个字面量 `![](…)`。
// 后端 `/api/protect/download/%20` 是 200，所以这条路上一路"看着都正常"。
//
// 判据分两层，缺一不可：
//   ① 纯函数层 —— `encodeAssetUrl` 只编码**最后一个 `/` 之后**那一段里的禁区字符，
//      且**幂等**（图库那条路会把同一条 url 过两遍：`handleImageUpload` 的返回值 →
//      `ImagePicker` → `insertImage`）。`%` 不进禁区集，所以 `%20` 不会再被编成 `%2520`。
//   ② 真解析层 —— 用 **bytemd 自己那条链上的 `remark-parse`** 真解一遍，数 `image` 节点。
//      这一层才是用户看得见的那件事（"有没有渲染出来"），也是本文件的**自证负控**：
//      同一段 markdown，未编码的那串解出来是 **0 个 image 节点**，编码后是 1 个。
//      少了它，"编出来的串合法"只是我的推测。
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

// 纯 TS（无 DOM 无 React）⇒ 摊平成 .mjs 直接 import
const out = mkdtempSync(path.join(tmpdir(), 'asseturl-'));
const file = path.join(out, 'assetUrl.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/assetUrl.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const { encodeAssetUrl } = await import(pathToFileURL(file).href);

/** 用真解析器数 image 节点 —— 与站上渲染同一条链的第一段。 */
const imageNodes = (md) => {
    const tree = unified().use(remarkParse).parse(md);
    let n = 0;
    const walk = (node) => {
        if (node.type === 'image') n++;
        (node.children || []).forEach(walk);
    };
    walk(tree);
    return n;
};

console.log('\n① 没有禁区字符时恒等（不该动的绝不动）');
{
    ok(encodeAssetUrl('/api/protect/download/20260912013218_EMQX.png')
        === '/api/protect/download/20260912013218_EMQX.png', '带时间戳前缀的常规名');
    ok(encodeAssetUrl('/api/protect/download/old_pic.png') === '/api/protect/download/old_pic.png', '旧名');
    ok(encodeAssetUrl('https://img.example.com/gallery/20261006000000_sunset.png')
        === 'https://img.example.com/gallery/20261006000000_sunset.png', 'R2 绝对地址');
    ok(encodeAssetUrl('') === '', '空串原样回（不给调用方制造 undefined）');
}

console.log('\n② 禁区字符被编码（CommonMark link destination 不允许的那几个）');
{
    ok(encodeAssetUrl('/a/b c.png') === '/a/b%20c.png', '半角空格 → %20');
    ok(encodeAssetUrl('/a/b(1).png') === '/a/b%281%29.png', '半角括号 → %28%29');
    ok(encodeAssetUrl('/a/x"y\'z.png') === '/a/x%22y%27z.png', '引号');
    ok(encodeAssetUrl('/a/x<y>z.png') === '/a/x%3Cy%3Ez.png', '尖括号');
    ok(encodeAssetUrl('/a/x\\y.png') === '/a/x%5Cy.png', '反斜杠');
    ok(encodeAssetUrl('/a/x\ty.png') === '/a/x%09y.png', '制表符（控制符）');
}

console.log('\n③ 只动最后一个 `/` 之后的那一段（路径本身不能碰）');
{
    ok(encodeAssetUrl('/api/my dir/a b/c d.png') === '/api/my dir/a b/c%20d.png',
        '目录里的空格原样留着，只编文件名那一段');
    // `#` / `?` **故意不编**：本函数按最后一个 `/` 切段，切出来的"文件名"里可能本来带着
    // 查询串，编了 `?` 就等于把查询串焊进文件名（要动它们得先按 `?#` 再切一遍）。
    ok(encodeAssetUrl('/a/b.png?v=2&x=1 2') === '/a/b.png?v=2&x=1%202',
        '查询串原样，只有空格被编');
    ok(encodeAssetUrl('/a/b.png#frag x') === '/a/b.png#frag%20x', '片段同理');
}

console.log('\n④ 幂等：同一条 url 过两遍仍是同一个串（图库那条路会走两遍）');
{
    const one = encodeAssetUrl('/api/protect/download/满月 (1) 副本.png');
    ok(one === '/api/protect/download/满月%20%281%29%20副本.png', '一次编码的结果', one);
    ok(encodeAssetUrl(one) === one, '再来一遍还是它（`%` 不在禁区集里 ⇒ 不会被编成 %25）', encodeAssetUrl(one));
    ok(encodeAssetUrl('/a/b%20c.png') === '/a/b%20c.png', '已经带 %20 的串原样（不会被编成 %2520）');
    ok(!encodeAssetUrl(one).includes('%25'), '结果里不出现 %25');
}

console.log('\n⑤ 中文与全角标点原样留着（只有 ASCII 空白/标点才是禁区）');
{
    const u = '/api/protect/download/20261006033033_jimeng-把图片1的瞳孔颜色，头发颜色.png';
    ok(encodeAssetUrl(u) === u, '纯中文名恒等（浏览器发请求时自己会编码）');
    const mixed = '/api/protect/download/20261006033033_把图1的瞳孔 颜色（终稿）.png';
    const enc = encodeAssetUrl(mixed);
    ok(enc === '/api/protect/download/20261006033033_把图1的瞳孔%20颜色（终稿）.png', '只编那个空格', enc);
    ok(enc.includes('（终稿）'), '全角括号（U+FF08/09）不算禁区 —— 它们在 markdown 里合法');
}

console.log('\n⑥ 真解析：用户那张图的地址，编之前解不出图、编之后解得出（自证负控）');
{
    // 与线上那张同形：14 位时间戳 + 原名，原名里有一个**半角空格**（还有全角标点与中文）
    const raw = '/api/protect/download/20261006033033_jimeng-把图片1的瞳孔颜色，头发颜色，'
        + '猫耳朵严格替换图片2，图片2的帽子去掉。 注意：眼.png';
    const enc = encodeAssetUrl(raw);
    ok(enc !== raw && enc.includes('%20') && !/\s/.test(enc.split('/').pop()),
        '编码后文件名段里再没有空白字符', enc);

    // 负控在前：**未编码**的那串必须解不出 image 节点 —— 否则第 ⑥ 组判不出任何东西
    ok(imageNodes(`![](${raw})`) === 0,
        '负控：未编码 ⇒ 0 个 image 节点（整段退化成纯文本，用户看到的就是这个）');
    ok(imageNodes(`![](${enc})`) === 1, '编码后 ⇒ 正好 1 个 image 节点', imageNodes(`![](${enc})`));
    ok(imageNodes(`\n![](${enc})`) === 1, '带前导换行（插入时的真实形态）也是 1 个');

    // 顺带钉住"退化"到底长什么样：那串字面量会留在段落文本里
    const para = unified().use(remarkParse).parse(`![](${raw})`).children[0];
    ok(para.type === 'paragraph' && para.children.length === 1 && para.children[0].type === 'text',
        '未编码时那一段就是一个 text 节点（连 link 都不是）', para.children.map((c) => c.type));
}

console.log('\n⑦ 组件里那两处插入点都过同一个函数（源码锁）');
{
    const editor = readFileSync(path.join(root, 'src/components/Editor/index.tsx'), 'utf8');
    ok(/import\s*\{\s*encodeAssetUrl\s*\}/.test(editor), 'Editor 引入了 `encodeAssetUrl`');
    ok(/appendBlock\(`!\[\]\(\$\{encodeAssetUrl\(url\)\}\)`\)/.test(editor),
        '`insertImage` 拼 markdown 时就地编码（图库点选 / 存量带空格的老图都走这条）');
    ok(/url:\s*encodeAssetUrl\(response\.data\.data\)/.test(editor),
        '`handleImageUpload` 的返回值也编码（拖拽/粘贴那条路由 bytemd 自己拼串，本组件插不上手）');
    ok(!/appendBlock\(`!\[\]\(\$\{url\}\)`\)/.test(editor), '没有留下裸拼的那一处');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
