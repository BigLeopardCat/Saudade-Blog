import * as esbuild from 'esbuild';
import { runtime, widgetSource } from './helpers/widget-runtime.mjs';
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

    eq(reason('http://saudade.site/talk'), null, '同 host 的 http 地址也算站内');

    eq(target('../../guestbook'), '/guestbook', '相对路径按当前页解析（base 生效）');
}

console.log('\n② 不该接管的：一律原样拒绝（判据是原因码，不是"跳不跳"的猜测）');
eq(reason('/friends'), 'off-whitelist', '退役友链不再接管');
eq(reason('/he'), 'off-whitelist', '退役 /he 不再接管');
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
    ok(M.BLOG_PATH_PATTERNS.length >= 9, '白名单条目数正常（写死成空数组会让所有跳转退化成整页）',
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

    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
        const sink2 = {};
        M.registerSpaNavigate({ navigate: () => { throw new Error('boom'); } }, sink2);
        eq(sink2.__spaNavigate('/guestbook'), false, 'router.navigate 抛错 ⇒ false（回落整页，不静默吞）');
        ok(warns.some((w) => w.includes('[spa-nav]')), '  留一条 warn 便于排障', { warns });

        M.registerSpaNavigate({ navigate: (to) => calls.push(to) }, sink2);
        eq(sink2.__spaNavigate('/talk'), true, '重复注册后仍可用（幂等）');
    } finally {
        console.warn = origWarn;
    }
}

console.log('\n④ 源码契约：两份白名单不许漂移（差集必须恰好是 device-console 那一条）');
{
    const ts = readFileSync(path.join(root, 'src/router/spaNavigate.ts'), 'utf8');
    const widget = widgetSource('chat-stream.js');

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

    eq(onlyWidget.length, 1, '两份清单的差集只有一条', { onlyWidget });
    ok(/device-console/.test(onlyWidget[0] || ''), '  那一条就是 device-console', { onlyWidget });
}

console.log('\n⑤ 源码契约：导航卡停用、直达走桥、气泡链接委托、兜底判据仍在');
{
    const widget = widgetSource('chat-stream.js');

    const live = widget.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

    ok(!live.includes("navConfirm.classList.add('active')"),
        '确认式导航不激活卡片');
    ok(live.includes("console.warn('[nav] 确认式跳转已停用（不弹卡、不跳转）')"),
        '  停用时留一条 warn（不是静默什么都不做）');
    ok(!live.includes('泠月喵建议跳转到'),
        '卡面文案不再出现在活代码里（用户点名不要这句）');

    ok(/window\.__spaNavigate && window\.__spaNavigate\(navUrl\)/.test(live),
        'AUTO_NAVIGATE 直达先问桥');
    ok(/window\.location\.href = navUrl/.test(live), '  桥拒绝时仍回落整页跳转（跨域/静态页那条路没断）');
    ok(/window\.__spaNavigate\(url\)/.test(live), '卡上的「确定」也走桥（休眠代码，一行恢复即用）');

    ok(/BLOG_ROUTES\.some\(/.test(live) && /navOk/.test(live), 'widget 自己的白名单自校验保留');
    ok(/nav-skip-note/.test(live) && /hostOk/.test(live), '跨域/非白名单的注记与 host 校验保留');

    ok(/messages\.addEventListener\('click'/.test(live), '消息容器上挂了 click 委托');
    ok(/closest\('a\[href\]'\)/.test(live), '  只认 a[href]');
    ok(/e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/.test(live),
        '  带修饰键的点击放行（那是用户明确要开新标签页）');

    const render = readFileSync(path.join(root, 'public/live2d-widgets/chat-render.js'), 'utf8');
    ok(render.includes('id="chat-nav-confirm"') && render.includes('id="nav-yes"') && render.includes('id="nav-no"'),
        '卡面 DOM（#chat-nav-confirm / #nav-yes / #nav-no）仍由 chat-render.js 注入');
    ok(/chat-nav-confirm/.test(readFileSync(path.join(root, 'public/live2d-widgets/widget.css'), 'utf8')),
        'widget.css 里的卡片样式保留');

    const router = readFileSync(path.join(root, 'src/router/index.tsx'), 'utf8');
    ok(/import\s*\{\s*registerSpaNavigate\s*\}\s*from\s*["']\.\/spaNavigate\.ts["']/.test(router),
        'router/index.tsx 引了 registerSpaNavigate');
    ok(/registerSpaNavigate\(router\)/.test(router), '  并且在 createBrowserRouter 之后调用了一次');
}

{
    const f = runtime();
    try {
        const destinations = [];
        f.win.__spaNavigate = url => {
            const target = M.spaNavTarget(url, f.win.location.href, f.win.location.host);
            if (!target) return false;
            destinations.push(target); return true;
        };
        for (const [href, options, prevented] of [
            ['/guestbook', {}, true], ['/talk', {ctrlKey:true}, false],
            ['https://other.invalid/guestbook', {}, false],
        ]) {
            const a = f.doc.createElement('a'); a.href=href; f.ctx.dom.messages.appendChild(a);
            const event = new f.win.MouseEvent('click', {bubbles:true,cancelable:true,button:0,...options});
            a.dispatchEvent(event);
            eq(event.defaultPrevented,prevented,'实际消息链接委托保留修饰键和跨域规则');
        }
        eq(destinations.join(','),'/guestbook','只有合法站内普通点击进入路由');
    } finally {f.close();}
}

console.log('\n⑥ 组件缓存版本来自锁文件并传播给子资源');
{
    const widget = readFileSync(path.join(root, 'public/live2d-widgets/boot.js'), 'utf8');
    ok(widget.includes('document.currentScript?.src'), '入口读取宿主提供的脚本版本');
    ok(widget.includes("entry.searchParams.get('v')"), '子资源版本使用入口缓存键');
    const tsx = readFileSync(path.join(root, 'src/components/Live2dAgent/loader.ts'), 'utf8');
    ok(tsx.includes("import widgetLock from '../../../widget.lock.json'"), '宿主导入组件锁文件');
    ok(tsx.includes('boot.js?v=${widgetLock.sha}'), '入口 URL 直接使用锁定提交版本');
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
