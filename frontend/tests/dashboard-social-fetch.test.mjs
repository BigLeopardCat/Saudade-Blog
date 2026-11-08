import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const read = (p) => readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/** 取某标记之后那个 `useEffect(` 的函数体（从 `=>` 后第一个 `{` 起做花括号配对）。
 *  不能拿整份文件 includes 了事：那样"dispatch 写在 effect 外面"也会绿。 */
function effectBodyAfter(src, marker) {
    const m = src.indexOf(marker);
    if (m < 0) return null;
    const e = src.indexOf('useEffect(', m);
    if (e < 0) return null;
    let j = src.indexOf('{', src.indexOf('=>', e));
    if (j < 0) return null;
    let depth = 0;
    for (let k = j; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(j + 1, k); }
    }
    return null;
}

const dash = read('src/pages/Dashboard/index.tsx');
const head = read('src/frontHome/Head/index.tsx');
const record = read('src/components/articleRecord/index.tsx');
const userStore = read('src/store/components/user.tsx');

console.log('① 后台壳挂载时读取社媒设置');
const dashEffect = effectBodyAfter(dash, 'const Dashboard =');
ok(dashEffect !== null, '取到了后台壳的挂载 effect 函数体', dashEffect);
ok(dashEffect && dashEffect.includes('dispatch<any>(fetchUserInfo())'),
    '切片抓对了 effect（同一段里有 fetchUserInfo 这句锚）');
ok(dashEffect && /dispatch<any>\(fetchSocial\(\)\)/.test(dashEffect),
    '后台挂载 effect 里派发了 fetchSocial（漏了它 = 直接进后台时图为空）');
ok(/import\s*\{[^}]*\bfetchSocial\b[^}]*\}\s*from\s*["'][^"']*store\/components\/user/.test(dash),
    'fetchSocial 是从 store/components/user 引进来（不是别处另写一份）');

console.log('② 前台壳那一句仍在（两条入口各拉各的，不许二选一）');
const headEffect = effectBodyAfter(head, 'const blogTitle = useSelector');
ok(headEffect !== null, '取到了前台壳的挂载 effect 函数体', headEffect);
ok(headEffect && /dispatch<any>\(fetchSocial\(\)\)/.test(headEffect),
    '前台壳挂载 effect 里仍派发 fetchSocial');

console.log('③ 消费侧：图的名字只从站点设置现取，没有第二处来源');
ok(/state\.user\.social\?\.socialGithub/.test(record),
    'articleRecord 从 state.user.social.socialGithub 取名');
ok(!/fetchSocial/.test(record), 'articleRecord 自己不拉数据（拉取的负责方是壳，不是卡片）');
const recordCode = record.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/BigLeopardCat/.test(recordCode), '代码（去注释后）里没有写死的用户名');
ok(/ghchart\.rshah\.org\/409ba5\/\$\{/.test(record), '外链模板仍是 ghchart + 现取的用户名变量');

console.log('④ 设置只有一处出口：setSocial 只能由 fetchSocial 派发');
const setSocialCount = (userStore.match(/dispatch\(setSocial\(/g) || []).length;
ok(setSocialCount === 1, 'dispatch(setSocial(...)) 全仓只有一处', setSocialCount);
ok(/url:\s*["']\/api\/public\/social["']/.test(userStore), '拉的还是 /api/public/social 那个公开接口');

console.log('⑤ 用户名的解析规则（从源码里取出**真的那条正则**再跑）');
const lit = record.match(/\/(\^\(\?:https[\s\S]*?\/\?)\$\//);
ok(lit !== null, '从源码里抠出了 githubUserOf 的正则字面量', lit && lit[0]);
if (lit) {
    const re = new RegExp('^' + lit[1] + '$', '');
    const cases = [
        ['https://github.com/BigLeopardCat', 'BigLeopardCat'],
        ['http://github.com/foo', 'foo'],
        ['github.com/foo/', 'foo'],
        ['www.github.com/foo-bar', 'foo-bar'],
        // 下面这些一律**不猜**：猜出来的用户名必然指向一张 404 图，比不显示更糟
        ['https://github.com/foo/repo', ''],
        ['https://github.com/orgs/foo', ''],
        ['https://github.com/foo?tab=repos', ''],
        ['https://gist.github.com/foo', ''],
        ['', ''],
    ];
    for (const [url, want] of cases) {
        const got = (re.exec(url.trim()) || [])[1] || '';
        ok(got === want, `${JSON.stringify(url)} → ${JSON.stringify(want)}`, got);
    }
}

console.log(`\ndashboard-social-fetch: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
