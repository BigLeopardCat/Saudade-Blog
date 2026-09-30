// ═ 图库列表模式：图片展示名（20261001，用户第 2 条）══
//   node tests/asset-name.test.mjs
//
// 现场（用户要求）：后台图库加一种列表展示，行首是缩略图、后面跟着图片名。
// 盘上存的名字是 `/api/protect/download/20260912013218_EMQX.png` —— 上传时给原名压了一个
// **14 位时间戳前缀**（同一张图可以反复上传，靠它区分），给人看的应当只有 `EMQX.png`。
//
// 这条规则不是前端发明的：Rust `src/routes/upload.rs::strip_timestamp_prefix` 早就在用
// 同一条判据（上传去重时把盘上的名字还原成原名）。**两处必须同形**，否则会出现"图库里
// 显示 EMQX.png、去重逻辑却认不出它"这种对不上的状态 —— 本套件第 ③ 组就是钉这条的
// 跨语言守卫（读 Rust 源码，形状一变就红）。
//
// 为什么这项进 CI：这两条判据都是纯函数（无 DOM 无 React），而在页面上它是"显示得对不对"
// 的问题 —— 边界一错就是把时间戳当图名展示给用户，或者把中文名截断成乱码。
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
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
const out = mkdtempSync(path.join(tmpdir(), 'assetname-'));
const file = path.join(out, 'assetName.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/assetName.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
const { assetDisplayName } = await import(pathToFileURL(file).href);

const DL = '/api/protect/download/';

console.log('\n① 剥掉 14 位时间戳前缀');
{
    ok(assetDisplayName(DL + '20260912013218_EMQX.png') === 'EMQX.png',
        '`20260912013218_EMQX.png` → `EMQX.png`',
        assetDisplayName(DL + '20260912013218_EMQX.png'));
    // 这串数字必须是**日期形态**的：前缀是上传时 `%Y%m%d%H%M%S` 打出来的
    ok(assetDisplayName(DL + '20200101000000_a.png') === 'a.png', '另一串合法的 14 位也剥');
    ok(assetDisplayName(DL + '20260912013218_中文名.png') === '中文名.png', '原名里有中文也照剥');
}

console.log('\n② 不是那个形状的一律原样返回（宁可显示全名，也不许截错）');
{
    const cases = [
        ['2026091201321_EMQX.png', '13 位数字（不足）'],
        ['202609120132189_EMQX.png', '15 位数字（超出）'],
        ['202609120132 1_EMQX.png', '第 14 位不是数字'],
        ['20260912013218XEMQX.png', '第 15 位不是下划线'],
        ['20260912013218_', '只有 15 个字符（下划线后面没东西）'],
        ['EMQX.png', '没有前缀'],
        ['2026-09-12_EMQX.png', '日期带分隔符（长度也不够）'],
        ['中文名字很长的文章配图最终版.png', '中文名（按码元数 > 15，不许被当成分隔符切）'],
    ];
    for (const [name, why] of cases) {
        ok(assetDisplayName(DL + name) === name, `  ${why}：原样返回`, assetDisplayName(DL + name));
    }
    ok(assetDisplayName('') === '' && assetDisplayName(undefined) === '',
        '空串 / undefined → 空串（调用方不必先判空）');
}

console.log('\n③ 只取路径最后一段：带 CDN 域名、带 query 都拿到同一个名字');
{
    ok(assetDisplayName('https://cdn.example.com' + DL + '20260912013218_EMQX.png') === 'EMQX.png',
        'CDN 绝对地址（`resolveApiAssetUrl` 重写后的形态）');
    ok(assetDisplayName(DL + '20260912013218_EMQX.png?v=2') === 'EMQX.png', '带 query');
    ok(assetDisplayName(DL + '20260912013218_EMQX.png#x') === 'EMQX.png', '带 hash');
    ok(assetDisplayName('EMQX.png') === 'EMQX.png', '不是路径、只有名字');
}

console.log('\n④ 跨语言守卫：Rust 那条同款规则还在（改一侧必须改另一侧）');
{
    const rust = readFileSync(path.join(root, '..', 'src/routes/upload.rs'), 'utf8');
    ok(/fn strip_timestamp_prefix/.test(rust), 'Rust 侧 `strip_timestamp_prefix` 还在');
    ok(/bytes\.len\(\)\s*>\s*15\s*&&\s*bytes\[14\]\s*==\s*b'_'/.test(rust),
        '  判据还是「长度 > 15 且第 15 个字节是 `_`」（与这边 `name[14] === "_"` 同形）');
    ok(/bytes\[\.\.14\]\.iter\(\)\.all\(\|b\| b\.is_ascii_digit\(\)\)/.test(rust),
        '  前 14 个字节全是 ASCII 数字（等价于这边的 `/^\\d{14}$/`）');
    ok(/&name\[15\.\.\]/.test(rust), '  截断从第 15 个字符起（与这边 `slice(15)` 对齐）');
    // 前端这一侧也钉一下：上面那些用例只有在"真的按 14/15 这两个数字实现"时才全绿，
    // 但如果有人把实现改成"见到下划线就切"，② 组里 `2026-09-12_EMQX.png` 那条会红。
    ok(/assetDisplayName/.test(readFileSync(path.join(root, 'src/pages/Dashboard/Albums/index.tsx'), 'utf8')),
        '图库列表真的用了这个函数（写了没人用 = 白写）');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
