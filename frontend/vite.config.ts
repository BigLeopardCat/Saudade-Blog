import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 站点身份：**默认值只写在这一次**，HTML 与 TS 两侧都从这里取。
 *
 * 为什么不用 Vite 内置的 `%VITE_XXX%`：那套只认 `.env*` 与真实进程环境，而本仓的
 * `.env*` **整类都在 .gitignore 里**（`.gitignore:40`）——别人 clone 后一个 .env 都没有，
 * 占位符会原样留在 HTML 里（canonical / og:url 变成字面量 `%VITE_SITE_URL%`），
 * 比硬编码更难查。这里在**受版本控制**的配置里给默认值。
 *
 * **默认值是中性占位（本机开发地址），不是任何真实域名**：缺 `VITE_SITE_URL` 时宁可
 * 产出一个明显没配好的地址（本地开发恰好就是它），也不要静默指向项目作者的站点——
 * 那样 fork 出去部署时，搜索引擎会把别人的文章挂到作者域名下，且没有任何东西会报错。
 * 线上部署通过 CI 的仓库 Variable `VITE_SITE_URL` 显式传入（见 `.github/workflows/deploy.yml`）。
 *
 * 两处消费：① 下面的 siteIdentity 插件替换 index.html 里的占位符；
 * ② 同名的 `define` 把值注入给 TS（读法见 `src/utils/siteUrl.ts`）。
 * 用 `define` 而不是 `import.meta.env` 就是为了**默认值只有这一份** ——
 * 否则 HTML 一个默认值、TS 一个默认值，改一处忘一处就会 canonical 与 og:url 打架。
 */
const SITE_URL = (process.env.VITE_SITE_URL || 'http://localhost:5173').replace(/\/+$/, '');
// 署名同理：**缺省是空串**，不预设任何人的名字。fork 出去的人不设它，页面上就没有署名，
// 而不是继承本项目作者的。线上由 CI 的仓库 Variable `VITE_SITE_AUTHOR` 显式传入。
const SITE_AUTHOR = process.env.VITE_SITE_AUTHOR || '';

if (!process.env.VITE_SITE_URL) {
    console.warn(
        '[site-identity] 未设 VITE_SITE_URL，canonical / og:url / robots.txt 将回落到 '
        + `${SITE_URL} —— 线上构建必须设它（CI 见 deploy.yml 的 VITE_SITE_URL 环境变量）。`,
    );
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 取 URL 的 origin；不是合法 URL 就返回 null（不抛）。 */
function originOf(u: string): string | null {
    try { return new URL(u).origin; } catch { return null; }
}

/** 这个地址是不是回环地址 —— 产物是在某人自己机器上建出来的标记。 */
function isLoopbackOrigin(u: string): boolean {
    try { return LOOPBACK_HOSTS.has(new URL(u).hostname.toLowerCase()); } catch { return false; }
}

/**
 * 图谱产物的**语料归属自校验**（构建期判定，读一次 manifest，不碰产物本身）。
 *
 * `frontend/public/graph/graph-*.js` 是**从真实文章算出来的**向量空间：它内嵌那些文章的
 * 标题与词表。别人 clone 这个仓直接部署，如果不加判断，展品会把**原作者的文章**画到他
 * 的首页上。产物 manifest 里由建图脚本写入 `site`（产物的归属站点），这里拿它跟本站
 * 地址比一比，不是本站就不注册这件展品（见 `exhibits.ts`）。
 *
 * 规则：
 *   - manifest 缺席 / 不是合法 JSON  → 本地。没建过图时本就没有数据，交给 loader 兜底。
 *   - 没有 `site` 键                  → 本地。老产物没有这个字段，向后兼容。
 *   - `site` 是回环地址              → 本地。作者/开发者在自己机器上建的图。
 *   - 其余                           → 与本站同源才算本地，否则不是。
 *
 * **生产构建不给 `SITE_URL` 的 localhost 默认值豁免**：站点地址配错时，结果是"隐藏"
 * （安全方向），而不是把作者的文章挂到别人站上。本地 `vite dev` 另有豁免，见下面
 * `command === 'serve'` 那一处的说明。
 */
const GRAPH_OWNERSHIP = (() => {
    let raw: string;
    try {
        raw = readFileSync(new URL('./public/graph/manifest.json', import.meta.url), 'utf-8');
    } catch {
        return { local: true, why: '没有 manifest（还没建过图）' };
    }
    let m: { site?: unknown };
    try {
        m = JSON.parse(raw);
    } catch {
        return { local: true, why: 'manifest 不是合法 JSON' };
    }
    const site = typeof m.site === 'string' ? m.site.trim() : '';
    if (!site) return { local: true, why: '产物未写 site（老产物，向后兼容）' };

    const siteOrigin = originOf(site);
    if (!siteOrigin) return { local: false, why: `manifest.site 不是合法 URL：${site}` };
    if (isLoopbackOrigin(siteOrigin)) return { local: true, why: `产物建在回环地址 ${siteOrigin}` };

    const here = originOf(SITE_URL);
    return siteOrigin === here
        ? { local: true, why: `产物与本站同源（${here}）` }
        : { local: false, why: `产物属于 ${siteOrigin}，本站是 ${here}` };
})();

const siteIdentity = (): Plugin => ({
    name: 'saudade-site-identity',
    transformIndexHtml: {
        // 'pre'：先于 Vite 自己的 env 替换跑。两边占位符不重叠，但显式定序免得将来撞上。
        order: 'pre',
        handler: (html: string) => {
            const out = html
                .replace(/__SITE_URL__/g, SITE_URL)
                .replace(/__SITE_AUTHOR__/g, SITE_AUTHOR);
            // 没配署名就把整行删掉：留 `<meta name="author" content="">` 对爬虫与人
            // 都没有意义，而**留占位符原样**更糟（这正是本文件头注反对的那种做法）。
            return SITE_AUTHOR
                ? out
                : out.replace(/^[^\S\n]*<meta name="author"[^>]*>\n/m, '');
        },
    },
    // robots.txt 整份由这里生成（`public/robots.txt` 已删）。
    //
    // 为什么不能像 index.html 那样留占位符了事：`Sitemap:` 那一行**必须是绝对 URL**
    // ——Google 的文档明确要求 fully qualified，写相对路径 `/sitemap.xml` 该行会被忽略，
    // 等于白白丢掉 sitemap 的自动发现。而 `public/` 下的文件 Vite 原样拷贝、不做任何
    // 构建期替换，所以只有"由插件生成"这一条路能让别人的部署指向自己的域名。
    generateBundle() {
        this.emitFile({
            type: 'asset',
            fileName: 'robots.txt',
            source: `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
        });
    },
});

export default defineConfig(({ command }) => {
    // `serve` = `vite dev`。开发态一律认作本地：这时 `SITE_URL` 是默认的 localhost:5173，
    // 而 manifest 里写的是真实站点 ⇒ 严格比 origin 会把展品藏掉，改前端的人就再也看不到
    // 它在改什么了。**这条豁免只给开发服务器**，`vite build` 拿不到（这正是上面说的
    // "生产构建不给 localhost 豁免"）。
    const graphLocal = command === 'serve' || GRAPH_OWNERSHIP.local;
    if (!graphLocal) {
        console.warn(
            `[graph-ownership] 隐藏「文章向量空间」展品：${GRAPH_OWNERSHIP.why}。`
            + '若本站确实该展示它，用 --site 指定本站地址重建图谱产物（见 docs/word-graph.md）。',
        );
    }

    return {
        base: '/',
        mode: 'production',
        plugins: [
            react(),
            siteIdentity(),
        ],

        // 站点身份注入给 TS（类型声明在 `src/vite-env.d.ts`，读法在 `src/utils/siteUrl.ts`）。
        // 与上面插件里的 HTML 占位符**同一个名字、同一个值**，只是注入目标不同。
        define: {
            __SITE_URL__: JSON.stringify(SITE_URL),
            __SITE_AUTHOR__: JSON.stringify(SITE_AUTHOR),
            __GRAPH_LOCAL__: JSON.stringify(graphLocal),
        },

        build: {
            cssCodeSplit: true,
            terserOptions: {
                compress: {
                    drop_console: true,
                    drop_debugger: true,
                }
            },
            assetsDir: 'assets',
            assetsInlineLimit: 4096,
            sourcemap: false,
            reportCompressedSize: false,
            rollupOptions: {
                output: {
                    chunkFileNames: 'vendor/[name]-[hash].js',
                    entryFileNames: 'js/[name]-[hash].js',
                    assetFileNames: '[ext]/[name]-[hash].[ext]',
                    manualChunks: {
                        'react-vendor': ['react', 'react-dom'],
                    },
                },
            }
        }
    };
});
