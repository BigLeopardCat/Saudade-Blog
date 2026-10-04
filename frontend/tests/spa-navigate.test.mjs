// ═ 站内跳转桥（20260926）══
//   node tests/spa-navigate.test.mjs
//
// 现场（用户报的）：「我希望 agent 带着转跳页面时对话窗口不变。还有不要弹出泠月喵建议转跳
// XXX，暂时注释掉」。前半句的成因不是"跳转逻辑错"，而是**跳转方式**：前端两条导航出路都是
// `window.location.href = …`（整页装载），而对话面板挂在 `#root` 之外（boot.js 注入），
// 整页重载会把它连同输入框里没发出去的半句话整个重建。后半句是确认卡被停用（用户拍板
// 「agent 回复文本就有超链接根本用不着弹窗」）。
//
// 本套件锁三件：
//   ① 判据（`spaNavReason`/`spaNavTarget` 纯函数）——该接管的接管、不该接管的原样拒绝；
//   ② 桥的接线（`registerSpaNavigate` 挂 `window.__spaNavigate`，路由跳失败必须回落 false，
//      绝不静默吞掉一次跳转）；
//   ③ 源码契约——**两份白名单不许悄悄漂移**（widget 是不经打包的独立脚本，import 不到这个
//      TS 模块，只能各存一份）、确认卡真的被注释掉且留着一行恢复路径、气泡链接委托在位。
//
// spaNavigate.ts 是纯 TS（只在**调用时**才碰 window，模块加载零副作用），esbuild 摊平后直接 import。
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'spanav-'));
const file = path.join(out, 'spaNavigate.mjs');
await esbuild.build({
    entryPoints: [path.join(root, 'src/router/spaNavigate.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
});
// 假 window：`spaNavTarget` 不传 base/host 时读它（桥挂上后就是这条默认路，
// 也是浏览器里唯一的路）——本机 node 没有 window，必须先装好再调桥。
globalThis.window = {
    location: { href: 'https://saudade.site/article/16', host: 'saudade.site' },
};
const M = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, want, name) => ok(got === want, name, { got, want });

const BASE = 'https://saudade.site/article/16';
const HOST = 'saudade.site';
const target = (u) => M.spaNavTarget(u, BASE, HOST);
const reason = (u) => M.spaNavReason(u, BASE, HOST);

console.log('\n① 该接管的：同源 + 站内白名单 ⇒ 给出站内相对地址（query/hash 一并带走）');
{
    eq(target('/guestbook'), '/guestbook', '站内相对路径');
    eq(target('/talk/'), '/talk/', '尾斜杠保留（幻觉常省略/带上，两种都得能跳）');
    eq(target('https://saudade.site/dashboard/notes'), '/dashboard/notes', '同源绝对地址 → 只留 path');
    eq(target('/article/16?from=chat#top'), '/article/16?from=chat#top', 'query 与 hash 不被丢掉');
    eq(target('/category/3'), '/category/3', '文章/分类/后台都在白名单');
    // http 与 https 同 host 都算站内（与 chat-stream.js 既有的 hostOk 同口径）——
    // 否则站内一条 http 链接会退化成整页跳转，用户看到的"面板没保住"会随机复现
    eq(reason('http://saudade.site/talk'), null, '同 host 的 http 地址也算站内');
    // 相对基线：base 是当前页（文章页）⇒ 拼接结果交给 router 的仍是站内绝对路径
    eq(target('../../guestbook'), '/guestbook', '相对路径按当前页解析（base 生效）');
}

console.log('\n② 不该接管的：一律原样拒绝（判据是原因码，不是"跳不跳"的猜测）');
{
    eq(reason('/iot'), 'off-whitelist', '白名单外的站内路径（agent 幻觉出的页面）');
    eq(reason('/api/protected/tag/move'), 'denied-prefix', '/api* 不是页面');
    eq(reason('/device-console/'), 'denied-prefix', '/device-console/ 是 nginx 直服的静态控制台，必须整页装载');
    eq(reason('/device-console'), 'denied-prefix', '  无尾斜杠同样拦');
    eq(reason('https://evil.com/talk'), 'cross-host', '跨域（路径合法也不例外）');
    eq(reason('mailto:a@b.com'), 'not-http', 'mailto 不是页面');
    eq(reason('javascript:alert(1)'), 'not-http', 'javascript: 伪协议');
    eq(reason('http://['), 'unparsable', '解析不了就拒绝');
    eq(target('/api/login'), null, '拒绝时没有可交给路由的目标');
    ok(M.BLOG_PATH_PATTERNS.length >= 10, '白名单条目数正常（写死成空数组会让所有跳转退化成整页）',
        { n: M.BLOG_PATH_PATTERNS.length });
    ok(M.SPA_NAV_DENY.length === 2, 'deny 表就两条（api / device-console）', { n: M.SPA_NAV_DENY.length });
}

console.log('\n③ 桥的接线：挂上 window.__spaNavigate，命中才 true，跳失败必须回落');
{
    const calls = [];
    const sink = {};
    M.registerSpaNavigate({ navigate: (to) => calls.push(to) }, sink);
    eq(typeof sink.__spaNavigate, 'function', 'window.__spaNavigate 是一个函数');
    eq(sink.__spaNavigate('/guestbook'), true, '命中 ⇒ true');
    eq(calls.join('|'), '/guestbook', 'router.navigate 收到了站内相对地址');
    eq(sink.__spaNavigate('https://evil.com/talk'), false, '跨域 ⇒ false（调用方回落整页跳转）');
    eq(calls.length, 1, '  拒绝的目标一次都没进 router');
    eq(sink.__spaNavigate('/device-console/'), false, '静态控制台 ⇒ false');

    // 路由跳失败（不该发生）⇒ 必须返回 false，让调用方回落整页跳转；
    // 返回 true 就成了"静默吞掉一次跳转"——用户点了链接什么都没发生
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
        const sink2 = {};
        M.registerSpaNavigate({ navigate: () => { throw new Error('boom'); } }, sink2);
        eq(sink2.__spaNavigate('/guestbook'), false, 'router.navigate 抛错 ⇒ false（回落整页，不静默吞）');
        ok(warns.some((w) => w.includes('[spa-nav]')), '  留一条 warn 便于排障', { warns });
        // 幂等：重复注册只是覆盖同一个函数
        M.registerSpaNavigate({ navigate: (to) => calls.push(to) }, sink2);
        eq(sink2.__spaNavigate('/talk'), true, '重复注册后仍可用（幂等）');
    } finally {
        console.warn = origWarn;
    }
}

console.log('\n④ 源码契约：两份白名单不许漂移（差集必须恰好是 device-console 那一条）');
{
    const ts = readFileSync(path.join(root, 'src/router/spaNavigate.ts'), 'utf8');
    const widget = readFileSync(path.join(root, 'public/live2d-widgets/chat-stream.js'), 'utf8');

    // 从源码里读正则字面量的**源文本**（`/…/ ` 之间那一段），不 eval——
    // 比的是两份清单写的是不是同一批字符串
    const sourcesOf = (src, name) => {
        const m = src.match(new RegExp('(?:const\\s+' + name + '|' + name + ')[^=]*=\\s*\\[([\\s\\S]*?)\\]'));
        if (!m) return null;
        return [...m[1].matchAll(/\/((?:\\\/|[^/\\])+)\/[a-z]*/g)].map((x) => x[1]);
    };
    const bridgeList = sourcesOf(ts, 'BLOG_PATH_PATTERNS');
    const widgetList = sourcesOf(widget, 'BLOG_ROUTES');
    ok(!!bridgeList && bridgeList.length > 0, '能从 spaNavigate.ts 读出白名单');
    ok(!!widgetList && widgetList.length > 0, '能从 chat-stream.js 读出 BLOG_ROUTES');
    const onlyWidget = (widgetList || []).filter((s) => !(bridgeList || []).includes(s));
    const onlyBridge = (bridgeList || []).filter((s) => !(widgetList || []).includes(s));
    ok(onlyBridge.length === 0, '桥的白名单是 widget 那份的子集（桥不许自己偷偷多认页面）', { onlyBridge });
    // 差集只许有 device-console 一条（它归桥的 deny 管：nginx 直服的静态页，SPA 里没有对应路由）。
    // 这里按**含义**比而不是按字面比：widget 那份写作 `/^\/device-console\/?/`（没有 `$`，
    // 是前缀匹配），桥的 deny 是 `$` 锚定的 `/^\/device-console\/?$/`。两者都拦——
    // 桥多出的那个 `$` 只是更严（`/device-console/x` 落到 off-whitelist 一样是拒绝），
    // 行为等价由 ② 直接验过。
    eq(onlyWidget.length, 1, '两份清单的差集只有一条', { onlyWidget });
    ok(/device-console/.test(onlyWidget[0] || ''), '  那一条就是 device-console', { onlyWidget });
}

console.log('\n⑤ 源码契约：导航卡停用、直达走桥、气泡链接委托、兜底判据仍在');
{
    const widget = readFileSync(path.join(root, 'public/live2d-widgets/chat-stream.js'), 'utf8');
    // 只看**没被注释掉**的行：停用方式就是把那三行注释掉 ⇒ 判据必须区分注释与代码
    const live = widget.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

    ok(!live.includes("navConfirm.classList.add('active')"),
        '确认卡不再被激活（navConfirm.classList.add 只在注释里）');
    ok(widget.includes('// navConfirm.classList.add(\'active\');')
        && widget.includes('// navQuestion.textContent =')
        && widget.includes('// ctx.state.pendingNavUrl = navUrl;'),
        '  三行恢复路径都留着（"暂时注释掉"字面执行）');
    ok(/20260926[^\n]*恢复/.test(widget) || /恢复[^\n]*注释/.test(widget),
        '  注释里写明了怎么恢复');
    ok(live.includes("console.warn('[nav] 确认式跳转已停用（不弹卡、不跳转）')"),
        '  停用时留一条 warn（不是静默什么都不做）');
    ok(!live.includes('泠月喵建议跳转到'),
        '卡面文案不再出现在活代码里（用户点名不要这句）');

    // 直达分支先走桥，桥说 false 才整页跳转；两行 sessionStorage 标记只在整页那条路上才有意义
    ok(/window\.__spaNavigate && window\.__spaNavigate\(navUrl\)/.test(live),
        'AUTO_NAVIGATE 直达先问桥');
    ok(/window\.location\.href = navUrl/.test(live), '  桥拒绝时仍回落整页跳转（跨域/静态页那条路没断）');
    ok(/window\.__spaNavigate\(url\)/.test(live), '卡上的「确定」也走桥（休眠代码，一行恢复即用）');
    // 纵深防御：白名单自校验与"非博客页面"注记都还在（桥是第二道，不是唯一一道）
    ok(/BLOG_ROUTES\.some\(/.test(live) && /navOk/.test(live), 'widget 自己的白名单自校验保留');
    ok(/nav-skip-note/.test(live) && /hostOk/.test(live), '跨域/非白名单的注记与 host 校验保留');

    // 气泡里的站内超链接（"用超链接跳转"那条路的最后一米）
    ok(/messages\.addEventListener\('click'/.test(live), '消息容器上挂了 click 委托');
    ok(/closest\('a\[href\]'\)/.test(live), '  只认 a[href]');
    ok(/e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/.test(live),
        '  带修饰键的点击放行（那是用户明确要开新标签页）');

    // 停用 ≠ 删除：卡面标记与样式留着，恢复只需去掉注释
    const render = readFileSync(path.join(root, 'public/live2d-widgets/chat-render.js'), 'utf8');
    ok(render.includes('id="chat-nav-confirm"') && render.includes('id="nav-yes"') && render.includes('id="nav-no"'),
        '卡面 DOM（#chat-nav-confirm / #nav-yes / #nav-no）仍由 chat-render.js 注入');
    ok(/chat-nav-confirm/.test(readFileSync(path.join(root, 'public/live2d-widgets/widget.css'), 'utf8')),
        'widget.css 里的卡片样式保留');

    // 桥必须在路由模块里注册（不注册 = 所有跳转都退回整页）
    const router = readFileSync(path.join(root, 'src/router/index.tsx'), 'utf8');
    ok(/import\s*\{\s*registerSpaNavigate\s*\}\s*from\s*["']\.\/spaNavigate\.ts["']/.test(router),
        'router/index.tsx 引了 registerSpaNavigate');
    ok(/registerSpaNavigate\(router\)/.test(router), '  并且在 createBrowserRouter 之后调用了一次');
}

console.log('\n⑥ 版本号：改了 widget 脚本必须 bump（nginx 对 live2d-widgets 是 1 年 immutable 缓存）');
{
    const widget = readFileSync(path.join(root, 'public/live2d-widgets/boot.js'), 'utf8');
    const ver = (widget.match(/const VER = '([^']+)'/) || [])[1];
    ok(!!ver, '能读到 boot.js 的 VER');
    // 这个字面量**就是刻意钉死的**：改了 widget 脚本却没 bump 时，这里会红（20261001b
    // 是对话面板去胶带 + 标题进签 + 四条边框收成一个那一轮——widget.css 与
    // chat-render.js / chat-session.js 都改了，必须换版本号才能越过 nginx 那
    // 1 年 immutable 缓存）。bump 时同步改这一行。
    //
    // 20261001c = 「待决定的确认卡片被迟到的历史气泡压在下面」那一轮（chat-stream.js 改了
    // 就位判据）。那次 bump 时漏了本行 ⇒ 套件一直红；注意**漏改本行不会让 bump 失效**
    // （版本号照样换新、缓存照样越过），红的只是这道纪律本身——所以它红的时候先看
    // boot.js 的 VER 是不是已经走在前面了，别当成"bump 没做"再 bump 一次。
    //
    // 20261001d = 「主动打断的一轮不丢」那一轮（chat-stream.js / chat-engine.js 都改了：
    // 保留语义、补删时机与顺序、提示条措辞按 kind 分家）。改这两支必须 bump——nginx 对
    // live2d-widgets 是 1 年 immutable。
    //
    // 20261001e = 「开源前准备：私人域名外移」那一轮（chat-stream.js 的导航命令补全
    // 从写死 `https://saudade.site` 改成 `location.origin` —— 写死会让**别人部署**上
    // agent 的跳转命令一律被判跨域取消）。同样必须 bump。
    //
    // 20261001f = 「开源前准备：上游文件名清场」那一轮（autoload.js→boot.js、
    // live2d-widget.js→stage.js、waifu.css→widget.css）。改名本身就让入口与样式表
    // 变成新 URL，bump 是为了让**子模块**（chat-*.js / stage.js）也一起换 URL——
    // 它们内容也改了（loader 里那份子模块名单、CSS 路径），不 bump 就吃 1 年缓存。
    // 20261001g = 「开源前准备：看板娘渲染层换自研」那一轮（waifu-tips.20260905.js +
    // chunk/* 整块剔除，换成 renderer.js）。子模块名单里 stage→renderer 直接体现在
    // boot.js 正文里，样式表与子模块 URL 都跟着 VER 走——不 bump 就吃 1 年缓存，
    // 浏览器会拿旧 renderer 配新 boot.js。
    // 20261001h = 「命令到达即执行」那一轮（chat-stream.js 改了命令的处置时机：
    // `__CMD__` 到达就跑一次能当场做的，流尾那一趟只捞整页目标）。改 chat-stream.js
    // 必须 bump——nginx 对 live2d-widgets 是 1 年 immutable。
    // 20261001i = 「看板娘图标错位 / 拖动反向 / 代码芯片两档都读不出」那一轮
    // （renderer.js 的 ICONS 与 setupDrag、widget.css 的代码芯片令牌）。三者都改了
    // live2d-widgets 下的文件 ⇒ 必须 bump，否则访客吃 1 年缓存看到的是旧图标与旧拖动。
    // 20261002a = 「工具条 tooltip 补齐 + 挂载改有界重试」那一轮（renderer.js 的 TITLES、
    // chat-stream.js 的 bindTool）。按钮 4.8–6.2s 才建出来，旧的一次性 1s 定时器在慢机上
    // **必然踩空**（CPU 节流 ×6 实测两条 title 从未挂上），photo/info/quit 则一直没有提示。
    // 20261002b = 「看板娘层级交给宿主页面的阶梯」那一轮（widget.css 的 #waifu 与
    // #waifu-toggle 从写死的 2147483000 / 9999 改成 var(--z-agent, 1000)）。改的是
    // live2d-widgets 下的样式表 ⇒ 同样必须 bump。
    // 20261002c = 「流式早退不再用 200+JSON 装成成功」那一轮（chat-stream.js 加了
    // content-type 兜底：不是 text/event-stream 就如实报错）。改 chat-stream.js 必须
    // bump——nginx 对 live2d-widgets 是 1 年 immutable，不 bump 访客吃的是旧脚本，
    // 而**旧脚本没有这道兜底**（也正是那次事故里前端一声不吭的原因）。
    // 20261002d = 「看板娘初始位置右移半个板块宽」那一轮（widget.css 的 #waifu
    // left: 15px → 165px = #live2d 板块 300px 的一半，并补一条 <480px 的回落）。
    // 20261003a = 「初始位置再左移 20px、下移 10px」那一轮（#waifu 的 left 145px、
    // transform translateY(-5px)）。
    // 位置写在样式表里 ⇒ 同样必须 bump，否则访客吃 1 年缓存仍看到贴左的旧位置。
    // 20261005a = 「选图按钮的图标夜间看不见」那一轮（widget.css 把 .chat-img-btn 加进
    // .chat-rail-btn / .conv-head-btn 那两组 color 名单）。改的是 live2d-widgets 下的
    // 样式表 ⇒ 同样必须 bump。
    // 20261005b = 「手机档看板娘盖住正文」那一轮（widget.css 的 <480px 块：整块缩到半尺寸、
    // 贴住左缘、空白处放行命中）。同上——样式表在 live2d-widgets 下，不 bump 访客吃
    // 1 年 immutable 缓存，手机上看到的还是那个占半个屏的旧盒子。
    ok(ver === '20261005b', 'VER 已 bump 到本轮（20261005b）', { ver });
    const tsx = readFileSync(path.join(root, 'src/components/Live2dAgent/index.tsx'), 'utf8');
    ok(tsx.includes('boot.js?v=' + ver), 'Live2dAgent 的 ?v= 与 VER 一致');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
