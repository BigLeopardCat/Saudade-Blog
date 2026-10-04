// ═ 前端错误上报：type 防漂 + 采集面 + 纯函数（20261004）══
//   node tests/monitor-report.test.mjs
//
// 现场（用户原话）："rust测试需要补吗，前端日志覆盖不够吧，甚至是无效状态。"
//
// 「无效状态」不是感觉，是一个数：生产 monitor.log 里 `type=other` 占 66%（193/292 行）。
// 成因是**白名单没跟得上客户端**——审计（20260925 A2）当时只登记了 boot.js 那五种，
// 之后客户端又加了七种，白名单没长，于是新类型全被收敛成 `other`，
// 「可枚举」这个前提无声失效（漏登记与真·未知类型长得一模一样）。
//
// 这套件锁四件：
//   ① ★ 客户端源码里所有上报点的 type ⊆ 服务端 MONITOR_KINDS（防漂主判据）；
//   ② 反向：白名单里没有"没人会发"的死条目（两边是同一份清单，不是子集关系）；
//   ③ 三处新采集面真的接上了（axios 拦截器 / 资源 error 的 capture 监听 / React 边界），
//      且**判据先于上报**（比如资源失败的判别式必须在 reportError 之前，否则运行时
//      JS 异常会被报两遍）；
//   ④ 服务端落盘行的字段顺序（追加在尾部，对账侧按位置解析）、webgl 的宽容类型、
//      去重窗口、以及 UA 在 into_body 之前取。
//
// ⚠️ 依赖被替换/刷新过：断言的是"当前源码"，不替换就断言不了。缺了会显式报错。
import * as esbuild from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..'); // 父仓根（Rust 那半边在这儿）

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repo, rel), 'utf8');

// ── 取服务端白名单 ─────────────────────────────────────────────────────────
function monitorWhitelist() {
    const src = readRepo('src/routes/monitor.rs');
    const m = /const MONITOR_KINDS: \[&str; (\d+)\] = \[([\s\S]*?)\n\];/.exec(src);
    if (!m) throw new Error('src/routes/monitor.rs 里没找到 MONITOR_KINDS 定义');
    return {
        declared: Number(m[1]),
        kinds: [...m[2].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]),
    };
}

// ── 取客户端上报点 ─────────────────────────────────────────────────────────
// 形状 `report({ type: 'x'` / `__reportError({ type: 'x'` / `reportError({ type: 'x'`
// ⚠️ 字符类必须含数字：写成 `[a-z_]+` 会**静默漏掉** `live2d_load_fail`（里面有 2）。
//    下面 ① 里有一条专门钉这一点。
const REPORT_CALL = /(?:report|reportError)\s*\(\s*\{\s*type:\s*'([a-z0-9_]+)'/g;

function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

function clientKinds() {
    const widgetDir = path.join(root, 'public/live2d-widgets');
    if (!existsSync(path.join(widgetDir, 'boot.js'))) {
        console.log('  ✗ 看板娘前端不在盘上：先跑 `npm run fetch:widget`（它的源码住在 agent 仓，本仓只按 pin 取产物）');
        process.exit(1);
    }
    const files = [
        ...readdirSync(widgetDir).filter((f) => f.endsWith('.js')).map((f) => path.join(widgetDir, f)),
        ...walk(path.join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f)),
    ];
    const found = new Map(); // kind → 出处（相对路径，去重）
    for (const f of files) {
        const src = readFileSync(f, 'utf8');
        // 只扫"真的在调上报"的文件，免得别处恰好叫 report 的函数被误伤
        if (!src.includes('reportError')) continue;
        for (const m of src.matchAll(REPORT_CALL)) {
            const rel = path.relative(root, f);
            if (!found.has(m[1])) found.set(m[1], []);
            if (!found.get(m[1]).includes(rel)) found.get(m[1]).push(rel);
        }
    }
    return found;
}

const server = monitorWhitelist();
const client = clientKinds();
const serverSet = new Set(server.kinds);
const clientSet = new Set(client.keys());
const where = (k) => (client.get(k) || []).join(', ');

console.log('\n① 客户端上报的 type ⊆ 服务端白名单（type 是匿名可写字段 ⇒ 必须是闭集）');
{
    const undeclared = [...clientSet].filter((k) => !serverSet.has(k));
    ok(undeclared.length === 0,
        `客户端 ${clientSet.size} 种 type 全在白名单里`,
        undeclared.map((k) => `${k}（${where(k)}）`));

    // 白名单声明长度与实际条目数一致（`[&str; N]` 写小了会编译不过，写大了是笔误）
    ok(server.declared === server.kinds.length,
        `MONITOR_KINDS 的声明长度 ${server.declared} 与实际条目 ${server.kinds.length} 一致`);

    // ★ 判据自身的形状：带数字的 kind 必须能被提取到。
    // 一个 `[a-z_]+` 的字符类会让 live2d_load_fail 整条消失，而"少一个"与"两边一致"
    // 在断言里长得一模一样——这条就是那个坑的回归锁。
    ok(clientSet.has('live2d_load_fail'),
        '提取规则认得出带数字的 kind（live2d_load_fail）',
        [...clientSet]);
    ok(clientSet.size === 14, '提取到 14 种客户端 type', [...clientSet].sort());
}

console.log('\n② 白名单里没有"没人会发"的死条目（两边是同一份清单）');
{
    // 这条是"清单要跟上"的另一半：① 防漏登记，② 防白名单留着一个改代码后没人再发的
    // 死条目（那种条目会让人对着日志找不到对应代码）。两个仓的 type 改动都要来这里签字。
    const dead = server.kinds.filter((k) => !clientSet.has(k));
    ok(dead.length === 0, '白名单每一项都对应一个真实上报点', dead);
}

console.log('\n③ 采集面接线（源码断言，不是"文件里有这个词"就算数）');
{
    // ③-1 axios 拦截器：SPA 唯一的 HTTP 客户端走 XHR，boot.js 那个 fetch 包装看不见它
    const axios = read('src/apis/axios.tsx');
    ok(/http\.interceptors\.response\.use\(/.test(axios), 'axios 有响应拦截器');
    ok(/reportApiFailure\(error\)/.test(axios), '失败分支里调了 reportApiFailure');
    ok(axios.indexOf('reportApiFailure(error)') > axios.indexOf('http.interceptors.response.use('),
        '调用点在响应拦截器之内（不是文件里别处存在就算）');
    ok(axios.includes('ERR_CANCELED'),
        '主动取消不报（路由切换/停止生成时的 abort 不是故障）');
    // 401 的既有处置顺序不许被这次改动打乱
    ok(axios.indexOf('localStorage.removeItem("tokenKey")') < axios.indexOf('reportApiFailure(error)'),
        '401 的分支仍排在报告之前（先保住"清 token + 跳登录"这条链路）');

    // ③-2 资源加载失败：error **不冒泡** ⇒ 必须 capture
    const report = read('src/utils/report.ts');
    const errListener = /window\.addEventListener\(\s*'error',([\s\S]*?)\n\s*true\s*\n?\s*\)/.exec(report);
    ok(!!errListener, "report.ts 的 error 监听带 capture: true（资源失败不冒泡）", errListener ? 'ok' : report.match(/addEventListener\(\s*'error'[\s\S]{0,200}/)?.[0]);
    if (errListener) {
        const body = errListener[1];
        // 判据必须**先于**上报：运行时 JS 异常也走这个事件，先判后报才能把它摘出去
        // （否则与 boot.js 的 js_error 重复，`dup` 的语义也跟着糊）
        ok(body.indexOf('resourceFailure(') < body.indexOf('reportError('),
            '判别式 resourceFailure 排在 reportError 之前');
        ok(/if\s*\(\s*!\s*failure\s*\)\s*return/.test(body),
            '认不出资源失败就直接 return（不是无条件上报）');
    }

    // ③-3 React 渲染期错误的兜底：两层边界（页面 / 整站）
    const boundary = read('src/components/ErrorBoundary/index.tsx');
    ok(/getDerivedStateFromError/.test(boundary) && /componentDidCatch/.test(boundary),
        'ErrorBoundary 是标准的两段式（渲染期拿状态 + 提交期上报）');
    ok(boundary.includes('componentStack'),
        '堆栈里带上 componentStack（生产构建里 error.stack 只剩 minify 后的函数名）');
    ok(/<ErrorBoundary/.test(read('src/App.tsx')), 'App.tsx 的内容区套了边界（scope=page）');
    ok(/<ErrorBoundary/.test(read('src/main.tsx')),
        'main.tsx 套了边界（后端是另一颗壳，不在 App 的路由树上 ⇒ 只包 Outlet 盖不住它）');
    ok(read('src/main.tsx').includes("import './utils/report'"),
        'main.tsx 引入上报模块（副作用注册，放在最前面：之后任何一步崩掉都还在监听）');

    // ③-4 webgl 标记真的随载荷发出去了
    ok(/shapeReport\(payload,\s*location\.href,\s*webglAvailable\(\)\)/.test(report),
        'webgl 探针的结果进了请求体（这是"那 8 条 Texture loading error 是不是爬虫"的唯一分辨手段）');
}

console.log('\n④ reportCore 纯函数');
const out = mkdtempSync(path.join(tmpdir(), 'reportcore-'));
const bundle = path.join(out, 'reportCore.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/reportCore.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
});
const C = await import(pathToFileURL(bundle).href);
{
    // clip 按**码点**截：slice 会把 emoji 切成两半，落盘是一串乱码（Rust 那头同一个坑会 panic）
    ok(C.clip('abc', 5) === 'abc', '短串不动');
    ok(C.clip('abcdef', 3) === 'abc', '按上限截断');
    ok(C.clip('🐱🐱🐱', 2) === '🐱🐱', 'emoji 不切成半个代理对');
    ok(C.clip('🐱🐱🐱', 2).length === 4, '两个 emoji = 4 个 UTF-16 码元（说明没多截）');
    ok(C.clip('', 3) === '', '空串');

    // 是不是上报端点自己：同源相对、绝对 URL、带查询串都要认出来
    ok(C.isOwnReport('/api/monitor/log') === true, '相对路径认得出');
    ok(C.isOwnReport('https://saudade.site/api/monitor/log') === true, '绝对 URL 认得出');
    ok(C.isOwnReport('/api/monitor/log?x=1') === true, '带查询串认得出');
    ok(C.isOwnReport('/api/notes') === false, '别的接口不误判');
    ok(C.isOwnReport('') === false, '空串不误判（否则所有请求都不报了）');
    ok(C.urlPath('https://h/p?q#f') === '/p', 'urlPath 掉查询与锚点');

    // 状态码闸：401 必然发生且有专门处置，报它只会淹掉真异常
    ok(C.shouldReportStatus(500) === true, '500 要报');
    ok(C.shouldReportStatus(404) === true, '404 要报');
    ok(C.shouldReportStatus(403) === true, '403 要报（"谁在点"值得看得见）');
    ok(C.shouldReportStatus(401) === false, '401 不报（它有专门链路：清 token + 跳登录）');
    ok(C.shouldReportStatus(undefined) === false, '没有状态码 ≠ 状态码好——它走 fetch_fail，不走这里');
    ok(C.shouldReportStatus(200) === false, '2xx 不报');

    // 载荷整形：截断上限与后端一致 + webgl 三态
    const body = C.shapeReport({ type: 'resource_error', message: 'x' }, 'https://h/p', null);
    ok(body.url === 'https://h/p', 'url 缺席时兜底到当前页（否则日志里这条线索断头）');
    ok(body.webgl === 'unknown', '探针没结果 ⇒ unknown');
    ok(C.shapeReport({ type: 'x' }, 'u', false).webgl === 'no', 'false ⇒ no');
    ok(C.shapeReport({ type: 'x' }, 'u', true).webgl === 'yes', 'true ⇒ yes');
    ok(C.shapeReport({ type: 'x', message: 'm'.repeat(3000) }, 'u', null).message.length === 2000,
        'message 截到 2000（与后端一致，且先于后端截：>8KB 的体整个被 413 掉）');
    ok(C.shapeReport({ type: 'x', stack: 's'.repeat(9000) }, 'u', null).stack.length === 4000, 'stack 截到 4000');
    ok(C.shapeReport({ type: 'x', url: 'u'.repeat(900) }, 'u', null).url.length === 500, 'url 截到 500');

    // 去重键：同 kind 不同 url 必须分开（否则一个页面的图挂了会盖掉另一个页面的）
    ok(C.dedupeKey({ type: 'a', message: 'm', url: 'u1' }) !== C.dedupeKey({ type: 'a', message: 'm', url: 'u2' }),
        'key 含 url');
    ok(C.dedupeKey({ type: 'a', message: 'm', url: 'u' }) !== C.dedupeKey({ type: 'b', message: 'm', url: 'u' }),
        'key 含 type');

    // 资源失败判别式：认得出，且**不把运行时 JS 异常算进来**
    const img = C.resourceFailure({ target: { tagName: 'IMG', src: 'https://h/a.png' } });
    ok(img && img.tag === 'IMG' && img.url === 'https://h/a.png', 'img 失败认得出', img);
    const script = C.resourceFailure({ target: { tagName: 'script', src: '/x.js' } });
    ok(script && script.tag === 'SCRIPT', '小写 tagName 归一成大写', script);
    const link = C.resourceFailure({ target: { tagName: 'LINK', href: '/a.css' } });
    ok(link && link.url === '/a.css', 'link 读 href', link);
    ok(C.resourceFailure({ target: { tagName: 'IMG', src: '' } })?.url === '',
        'src 空串时返回空 url（由调用方兜底到当前页）');
    ok(C.resourceFailure({ target: { tagName: 'DIV' } }) === null, '非资源标签不算');
    // ★ 负空间：运行时 JS 异常的 target 是 window（没有 tagName）——它归 boot.js 的
    //   js_error 管，这里必须放行通过，否则同一次异常会落两行
    ok(C.resourceFailure({ target: {} }) === null, '运行时异常（target 无 tagName）不算资源失败');
    ok(C.resourceFailure({ target: null }) === null, 'target 为 null 不算');
    ok(C.resourceFailure(null) === null, '事件本身为空不算');
}

console.log('\n⑤ 服务端落盘行的契约（对账侧按位置解析 type=/uid=）');
{
    const rs = readRepo('src/routes/monitor.rs');
    const fmt = /let line = format!\(\s*"([^"]+)"/.exec(rs);
    ok(!!fmt, '找到落盘行的 format!');
    if (fmt) {
        const f = fmt[1];
        // 顺序 = 契约：type/uid 在前，新字段一律追加在尾部
        const order = ['type={kind}', 'uid={uid}', 'url={url}', 'msg={msg}', 'stack={stack}', 'ua={ua}', 'webgl={webgl}', 'dup={dup}'];
        let at = -1, ordered = true;
        for (const token of order) {
            const i = f.indexOf(token);
            if (i < 0 || i < at) { ordered = false; break; }
            at = i;
        }
        ok(ordered, '字段顺序 type→uid→url→msg→stack→ua→webgl→dup（追加在尾部，旧解析器不受影响）', f);
    }
    // 宽容类型：脏 webgl 不能把整条载荷 400 掉
    ok(/pub webgl: Option<serde_json::Value>/.test(rs), 'webgl 是 Value（局部脏值不许毁掉整条记录）');
    ok(!/pub webgl: Option<bool>/.test(rs), 'webgl 不是 bool（`"yes"` 会让 serde 整条失败）');
    ok(/fn normalize_webgl/.test(rs) && rs.includes('_ => "unknown"'), '缺席/脏值收敛成 unknown（不是 no）');

    // UA 必须在 into_body() **之前**取：之后 req 只剩 body，读不到头。
    // 判据找的是 `req.into_body()`（带前缀）——注释里也写着这个词，不限定只在代码里找
    // 会拿注释的位置当判据。
    const uaAt = rs.indexOf('get(header::USER_AGENT)');
    ok(uaAt > 0, 'UA 从请求头取（客户端伪造不了载荷里的这个字段）');
    ok(rs.indexOf('req.into_body()') > 0 && uaAt < rs.indexOf('req.into_body()'),
        'UA 在 into_body 之前取（顺序错了会编译不过或拿到空）');
    ok(/fn normalize_ua/.test(rs) && /truncate\(&clean\(/.test(rs), 'UA 一样清洗+截断（头里塞换行能整行伪造）');

    // 去重：60 秒固定窗口 + 跨访客
    ok(/DEDUPE_WINDOW: Duration = Duration::from_secs\(60\)/.test(rs), '去重窗口 = 60 秒');
    ok(/fn dedupe_hit\([^{]*now: Instant/.test(rs), '窗口判定注入 now（否则"窗口过期"这一支测不到，只能 sleep）');
    ok(/truncate\(msg\.as_str\(\), 80\)/.test(rs), '去重键取 msg 前 80 字');
    ok(/DEDUPE_MAX_KEYS/.test(rs), '去重表有容量上限（匿名端点，不能让它无界长）');
}

console.log(`\n${pass}/${pass + fail} 项通过`);
if (fail) process.exit(1);
