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

export default defineConfig(() => ({
    base: '/',
    mode: 'production',
    plugins: [
        react(),
        siteIdentity(),
    ],

    // `vite dev` 的 API 代理（20261003）。图谱产物改由 API 供出后，开发态的
    // `loadManifest()` 会先打 `/api/public/graph/manifest`——不代理的话那条路
    // 永远 404（dev server 不认识 /api），本机看到的就永远是静态种子那份，
    // "后台重建 → 刷新首页即新图"这条链在开发态根本验不了。Rust 在本机 3000。
    // 注意只影响 dev（`vite build` 不看这个键），线上仍是 nginx 反代 /api。
    server: {
        proxy: {
            '/api': 'http://127.0.0.1:3000',
        },
    },

    // 站点身份注入给 TS（类型声明在 `src/vite-env.d.ts`，读法在 `src/utils/siteUrl.ts`）。
    // 与上面插件里的 HTML 占位符**同一个名字、同一个值**，只是注入目标不同。
    // （图谱的语料归属闸 20261003 从构建期搬到了运行期，不再有 `__GRAPH_LOCAL__`；
    //   判据见 `Vitrine/wordgraph/loader.ts` 的 `siteMatches`。）
    define: {
        __SITE_URL__: JSON.stringify(SITE_URL),
        __SITE_AUTHOR__: JSON.stringify(SITE_AUTHOR),
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
}));
