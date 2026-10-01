// ═ 匿名访客标识（20261001 用户第 2 条：点赞改为非登录用户也可以点赞）══
//   node tests/visitor-key.test.mjs
//
// `utils/visitorKey.ts` 是后端 `note_like.visitor_key` 的**唯一产地**：浏览器生成一个
// 随机串存进 localStorage，随 `X-Visitor-Key` 上报，后端按它给匿名访客去重、也算得出
// "这位访客点过没有"。它**不是身份凭据**（伪造它换不来任何权限），所以本套件锁的是
// 三件事：值必须合法且稳定、脏值必须被换掉、以及**不许长成"设备指纹"**。
//
// 模块没有任何 import（纯 `localStorage` + `crypto`），esbuild 直接打即可。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'vkey-'));

const file = path.join(out, 'visitorKey.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/visitorKey.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});

// ── 假 localStorage（可以在"隐私模式"与正常之间切换）──
let store = {};
let broken = false;
globalThis.localStorage = {
    getItem: (k) => {
        if (broken) throw new Error('localStorage is not available');
        return k in store ? store[k] : null;
    },
    setItem: (k, v) => {
        if (broken) throw new Error('localStorage is not available');
        store[k] = String(v);
    },
    removeItem: (k) => { delete store[k] },
};

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });

const KEY = 'saudade.visitorKey';
const fresh = async (preset, isBroken = false) => {
    store = preset ? { ...preset } : {};
    broken = isBroken;
    // 模块里那份"隐私模式兜底"是模块级状态 ⇒ 每个场景取一份新实例
    return import(pathToFileURL(file).href + '?b=' + Math.random());
};

console.log('\n① 生成一次、记住、之后一直用它');
{
    const mod = await fresh();
    const first = mod.getVisitorKey();
    ok(mod.isValidVisitorKey(first), '生成的值本身是合法的', first);
    eq(store[KEY], first, '  并写进了本机（下次刷新还是它）');
    eq(mod.getVisitorKey(), first, '  再取一次还是同一个（不是每次调用都换一个）');

    // 换个实例（= 刷新页面）读同一份 localStorage ⇒ 还是同一个"访客"
    const mod2 = await fresh(store);
    eq(mod2.getVisitorKey(), first, '  刷新后仍是同一个（否则每次刷新都算新访客）');
}

console.log('\n② 本机存的脏值一律换掉（短 / 脏字符 / 超长 / 空）');
{
    for (const bad of ['', 'short', 'abc', 'has space', 'a'.repeat(65), '汉字不是合法字符集', '<script>']) {
        const mod = await fresh({ [KEY]: bad });
        const got = mod.getVisitorKey();
        ok(mod.isValidVisitorKey(got) && got !== bad,
            `  ${JSON.stringify(bad.slice(0, 20))} → 换成合法的`, got);
        eq(store[KEY], got, '    并且把换掉的值写回去（不能只换这一次）');
    }
}

console.log('\n③ 隐私模式：localStorage 读写都抛，也要能用');
{
    const mod = await fresh(null, true);
    const a = mod.getVisitorKey();
    const b = mod.getVisitorKey();
    ok(mod.isValidVisitorKey(a), '  照样给出合法值（点赞不至于因为隐私模式就点不了）', a);
    eq(b, a, '  同一页里两次取到同一个（否则连点两次会被算成两个人）');

    const mod2 = await fresh(null, true);
    ok(mod2.getVisitorKey() !== a, '  （换一个页面 / 刷新后换一个：这等价于"换了个访客"，可接受）');
}

console.log('\n④ 校验函数就是服务端的白名单（8–64 位、[A-Za-z0-9_-]）');
{
    const mod = await fresh();
    const yes = ['01234567', 'a'.repeat(64), 'aBcD-123_xyz', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'];
    const no = ['a'.repeat(7), 'a'.repeat(65), 'has space', '中文', 'semi;colon', '', 'a.b'];
    for (const v of yes) ok(mod.isValidVisitorKey(v), `  合法：${JSON.stringify(v.slice(0, 40))}`);
    for (const v of no) ok(!mod.isValidVisitorKey(v), `  不合法：${JSON.stringify(v.slice(0, 40))}`);
}

console.log('\n⑤ 跨语言契约：请求头名与后端逐字一致');
{
    const mod = await fresh();
    const rs = readFileSync(path.join(root, '..', 'src/routes/note_stats.rs'), 'utf8');
    const m = rs.match(/const VISITOR_HEADER: &str = "([^"]+)"/);
    ok(!!m, '  从 note_stats.rs 里找得到 VISITOR_HEADER 常量');
    eq((m ? m[1] : '').toLowerCase(), mod.VISITOR_HEADER.toLowerCase(),
        '  前端常量 == 后端常量（HTTP 头大小写不敏感，按小写比）');

    // 后端白名单的两个边界也要一致：那边是 8/64 与 [A-Za-z0-9_-]
    ok(/const VISITOR_MIN: usize = 8;/.test(rs) && /const VISITOR_MAX: usize = 64;/.test(rs),
        '  长度边界 8/64 两侧一致（改了这边记得改那边）');
    ok(/is_ascii_alphanumeric\(\) \|\| b == b'-' \|\| b == b'_'/.test(rs),
        '  字符集白名单两侧一致');
}

console.log('\n⑥ 源码契约：四个调用都带标识；点赞不再有登录闸；不许长成指纹');
{
    const api = readFileSync(path.join(root, 'src/apis/NoteStatsMethods.tsx'), 'utf8');
    const calls = ['getNoteStats', 'reportNoteView', 'likeNote', 'unlikeNote'];
    for (const fn of calls) {
        const i = api.indexOf(`function ${fn}(`);
        const body = i < 0 ? '' : api.slice(i, api.indexOf('})', i));
        ok(/headers: visitorHeader\(\)/.test(body), `${fn} 带上了访客标识`);
    }
    ok(/import \{ getVisitorKey, VISITOR_HEADER \} from "\.\.\/utils\/visitorKey"/.test(api),
        '  标识只从 utils/visitorKey.ts 取（没有第二处产地）');

    const read = readFileSync(path.join(root, 'src/frontHome/Content/ReadArticle/index.tsx'), 'utf8');
    const like = read.slice(read.indexOf('const toggleLike'), read.indexOf('const toggleFav'));
    ok(!/getToken\(\)/.test(like), '点赞动作里没有登录判断（加回去就等于把功能关掉了）');
    ok(/登录后才能收藏/.test(read), '  反向对照：收藏仍然是登录专属（没被顺手一起放开）');

    const util = readFileSync(path.join(root, 'src/utils/visitorKey.ts'), 'utf8');
    ok(!/navigator|userAgent|screen\.|timezone|getBattery|canvas/i.test(util),
        '标识不掺任何设备维度（它是个随机串，不是指纹）');
    ok(!/tokenKey|Authorization/i.test(util), '  也与登录令牌无关（两套身份各走各的）');
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}（通过 ${passed}）`);
process.exit(failed === 0 ? 0 : 1);
