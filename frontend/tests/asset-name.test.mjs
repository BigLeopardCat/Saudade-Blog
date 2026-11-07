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

// 直接执行前端文件名回退函数。
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

console.log('\n④ 不从不可变对象键推断上传文件名');
{
    const object = 'd56fbad038994af2b981c605c95c1367.png';
    for (const url of [
        DL + object,
        'https://cdn.example.com/gallery/' + object,
        'https://cdn.example.com/gallery/' + object + '?download=1#preview',
    ]) {
        ok(assetDisplayName(url) === object, 'UUID 对象键完整保留，原始名称由图库元数据提供', assetDisplayName(url));
    }
    const generated = 'generated-' + 'a'.repeat(64) + '-' + object;
    ok(assetDisplayName(DL + generated) === generated,
        '生成图片对象键不按连字符或下划线截断', assetDisplayName(DL + generated));
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
