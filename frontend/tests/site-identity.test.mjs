// Verify build-time site identity without starting Vite or accessing external services.
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const has = (hay, needle, name) => ok(hay.includes(needle), name, { needle, found: hay.includes(needle) });
const lacks = (hay, needle, name) => ok(!hay.includes(needle), name, { needle });

const SITE_VARS = [
    'VITE_SITE_URL', 'VITE_SITE_AUTHOR', 'VITE_SITE_TITLE',
    'VITE_SITE_DESCRIPTION', 'VITE_SITE_KEYWORDS',
];
const clearSiteVars = () => SITE_VARS.forEach((k) => { delete process.env[k]; });

const out = mkdtempSync(path.join(tmpdir(), 'sitident-'));

// 配置里的默认值在**模块加载时**求值 ⇒ 必须"先设环境、再 import"。文件名带序号，
// 两次 import 是两个模块实例，各自读自己那份 process.env。
const bundle = async (n) => {
    const file = path.join(out, `vite.config.${n}.mjs`);
    await esbuild.build({
        entryPoints: [path.join(root, 'vite.config.ts')],
        bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
        plugins: [{
            name: 'stub-vite-deps',
            setup(build) {
                // namespace 里带上包名：两个 stub 的导出形状不同，必须分别 onLoad
                build.onResolve({ filter: /^(vite|@vitejs\/plugin-react)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
                build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
                    loader: 'js',
                    contents: a.path === 'vite'
                        ? 'export const defineConfig = (c) => c; export const loadEnv = () => ({});'
                        : 'export const react = () => ({ name: "react-stub" }); export default react;',
                }));
            },
        }],
    });
    const mod = await import(pathToFileURL(file).href);
    return typeof mod.default === 'function' ? mod.default() : mod.default;
};

const pluginOf = (cfg) => (cfg.plugins || []).find((p) => p && p.name === 'saudade-site-identity');
const transform = (cfg, html) => pluginOf(cfg).transformIndexHtml.handler(html);

const htmlIn = readFileSync(path.join(root, 'index.html'), 'utf8');

try {
    // ── ① 什么都不设（= 别人 fork 走、没配任何变量）──────────────
    clearSiteVars();
    const cfgDefault = await bundle('default');

    // ── ② 全设（= 自己的站点，值从仓库 Variable 来）──────────────
    process.env.VITE_SITE_URL = 'https://example.org';
    process.env.VITE_SITE_AUTHOR = '某位部署者';
    process.env.VITE_SITE_TITLE = '示例站名';
    process.env.VITE_SITE_DESCRIPTION = '这是一句自己写的站点描述。';
    process.env.VITE_SITE_KEYWORDS = '甲, 乙, 丙';
    const cfgConfigured = await bundle('configured');

    // ── ③ 值里有引号 / 尖括号（属性注入的形态）────────────────────
    process.env.VITE_SITE_TITLE = '带"引号"与<script>的站名';
    process.env.VITE_SITE_DESCRIPTION = 'a"b<c>d&e';
    const cfgQuoted = await bundle('quoted');

    console.log('① 不设任何 VITE_SITE_* （fork 出去的默认形态）');
    const d = transform(cfgDefault, htmlIn);
    ok(!d.includes('__SITE_'), 'index.html 的占位符全被替换掉（不许原样留在产物里）', d.match(/__SITE_[A-Z_]*__/g));
    has(d, '<title>个人博客</title>', '站名回落到中性占位「个人博客」');
    has(d, 'content="本站开发地址，尚未配置站点描述。"', '描述回落到中性占位');
    has(d, 'content="http://localhost:5173/"', 'og:url 回落到中性地址（不是任何真实域名）');
    lacks(d, 'Saudade', '产物里没有本项目的站名');
    lacks(d, 'Rust、React、IoT', '产物里没有本项目的技术分享文案');
    lacks(d, '<meta name="keywords"', 'keywords 没配 ⇒ 整行删掉（不留空 content 的 meta）');
    lacks(d, '<meta name="author"', '署名没配 ⇒ 整行删掉');

    console.log('② 全设（自己的站点）');
    const c = transform(cfgConfigured, htmlIn);
    has(c, '<title>示例站名</title>', 'title 用自己的站名');
    has(c, 'content="这是一句自己写的站点描述。"', 'meta description 用自己的描述');
    has(c, 'property="og:title" content="示例站名"', 'og:title 用自己的站名');
    has(c, 'property="og:description" content="这是一句自己写的站点描述。"', 'og:description 用自己的描述');
    has(c, 'name="twitter:title" content="示例站名"', 'twitter:title 用自己的站名');
    has(c, 'name="twitter:description" content="这是一句自己写的站点描述。"', 'twitter:description 用自己的描述');
    has(c, 'content="甲, 乙, 丙"', 'keywords 配了就写进去');
    has(c, 'content="某位部署者"', '署名配了就写进去');
    lacks(c, 'rel="canonical"', '共享 SPA 外壳不把所有路径标成首页');
    has(c, 'content="https://example.org/logo.png"', 'og:image 用自己的域名');
    lacks(c, 'localhost:5173', '配了域名后不再出现中性占位地址');
    // robots.txt 的 Sitemap 行必须是绝对 URL（Google 明确要求 fully qualified）
    let emitted;
    pluginOf(cfgConfigured).generateBundle.call({ emitFile: (f) => { emitted = f; } });
    ok(emitted && emitted.fileName === 'robots.txt', 'robots.txt 由插件生成（public/ 下那份已删）', emitted && emitted.fileName);
    has(String(emitted && emitted.source), 'Sitemap: https://example.org/sitemap.xml', 'robots.txt 的 Sitemap 行是绝对 URL');

    console.log('③ 配置值里的引号与尖括号');
    const q = transform(cfgQuoted, htmlIn);
    has(q, '<title>带&quot;引号&quot;与&lt;script&gt;的站名</title>', 'title 里的引号/标签被转义后仍是完整的一行');
    lacks(q, '带"引号"与<script>的站名', 'title 里的原始引号/标签没有原样进 HTML');
    has(q, '&quot;', '引号被转义成 &quot;');
    has(q, '&lt;script&gt;', '尖括号被转义');
    lacks(q, 'content="a"b<c>d&e"', '属性值里没有未转义的引号（否则整条 meta 会被撕成两半）');

    console.log('④ 源码契约（防回潮：这几个文件里不许再写死站名 / 描述）');
    const spots = [
        'index.html',
        'src/components/SeoHelmet.tsx',
        'src/frontHome/Content/ContentHome/index.tsx',
        'src/utils/siteUrl.ts',
    ];
    for (const rel of spots) {
        const src = readFileSync(path.join(root, rel), 'utf8');
        lacks(src, 'Saudade Blog', `${rel} 里没有写死的站名`);
        lacks(src, '个人技术博客', `${rel} 里没有写死的描述文案`);
    }
    const idx = readFileSync(path.join(root, 'index.html'), 'utf8');
    for (const ph of ['__SITE_URL__', '__SITE_AUTHOR__', '__SITE_TITLE__', '__SITE_DESCRIPTION__', '__SITE_KEYWORDS__']) {
        has(idx, ph, `index.html 用占位符 ${ph}`);
    }
} finally {
    rmSync(out, { recursive: true, force: true });
    clearSiteVars();
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
