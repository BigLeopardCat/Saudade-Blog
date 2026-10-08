// ═ 后台首页那张 GitHub 贡献图，谁负责把用户名取回来（20261009）══
//   node tests/dashboard-social-fetch.test.mjs
//
// 用户问：「后台的 github 积分板不会是硬编码我的账号吧」。查下来链条本身是干净的
// （20261001 开源前准备把写死的 `ghchart.rshah.org/409ba5/BigLeopardCat` 换成了
// 「从站点设置的 Github 链接里现取用户名」），但**取数方不在后台**：
// `state.user.social` 全仓只有前台壳的 `frontHome/Head` 在拉，而后台是另一颗壳
// （`/dashboard` 不在 `<App>` 路由树下，也不渲染 Head）。
//
// 症状的恶劣之处在于它**只在某些入口出现**，而且不报错：
//   · 先前台逛一圈 → 双击头像进后台：normal（redux store 在 SPA 导航里是同一个）
//   · 直接刷新 / 收藏夹打开后台：图没了，只剩 `.articleRecordImg` 那个定高空框
//   · 登录页登录后直接跳后台：同上（`/login` 也是独立顶层路由）
// 所以判据钉的不是"图能显示"，而是**每颗壳自己把这份数据拉回来**——
// 后台壳的挂载 effect 里必须有这一句，前台壳那一句也不许被搬走。
//
// 同 `review-gate-single-source.test.mjs` 的形态：不跑浏览器、不跑 DB，只读源码做契约断言
// （真要跑端到端得伪造 admin JWT 过 AuthRouter，那是 `/tmp` 里探针的活）。
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

console.log('① 后台壳自己把社媒设置拉回来（这次的修复点）');
const dashEffect = effectBodyAfter(dash, '//初始渲染');
ok(dashEffect !== null, '取到了后台壳的挂载 effect 函数体', dashEffect);
ok(dashEffect && dashEffect.includes('dispatch<any>(fetchUserInfo())'),
    '切片抓对了 effect（同一段里有 fetchUserInfo 这句锚）');
ok(dashEffect && /dispatch<any>\(fetchSocial\(\)\)/.test(dashEffect),
    '后台挂载 effect 里派发了 fetchSocial（漏了它 = 直接进后台时图为空）');
ok(/import\s*\{[^}]*\bfetchSocial\b[^}]*\}\s*from\s*["'][^"']*store\/components\/user/.test(dash),
    'fetchSocial 是从 store/components/user 引进来（不是别处另写一份）');

console.log('② 前台壳那一句仍在（两条入口各拉各的，不许二选一）');
// 标记要取在 useEffect **之前**的那一行：`effectBodyAfter` 是从标记往后找 useEffect，
// 拿 effect 体内的东西当标记会滑到下一段去（第一版就在这儿假红过）。
const headEffect = effectBodyAfter(head, 'const [isSearching, setIsSearching]');
ok(headEffect !== null, '取到了前台壳的挂载 effect 函数体', headEffect);
ok(headEffect && /dispatch<any>\(fetchSocial\(\)\)/.test(headEffect),
    '前台壳挂载 effect 里仍派发 fetchSocial');

console.log('③ 消费侧：图的名字只从站点设置现取，没有第二处来源');
ok(/state\.user\.social\?\.socialGithub/.test(record),
    'articleRecord 从 state.user.social.socialGithub 取名');
ok(!/fetchSocial/.test(record), 'articleRecord 自己不拉数据（拉取的负责方是壳，不是卡片）');
// 剥注释再找：这份文件的头注**故意**记着旧值 `ghchart.rshah.org/409ba5/BigLeopardCat`
// （"这里以前写死过"是这段代码存在的理由），注释里的字不算数 —— 行注释也要剥。
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
