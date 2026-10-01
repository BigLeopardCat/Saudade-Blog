import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 站点身份：**默认值只写在这一次**，HTML 与 TS 两侧都从这里取。
 *
 * 为什么不用 Vite 内置的 `%VITE_XXX%`：那套只认 `.env*` 与真实进程环境，而本仓的
 * `.env*` **整类都在 .gitignore 里**（`.gitignore:40`）——别人 clone 后一个 .env 都没有，
 * 占位符会原样留在 HTML 里（canonical / og:url 变成字面量 `%VITE_SITE_URL%`），
 * 比硬编码更难查。这里在**受版本控制**的配置里给默认值：缺环境变量时退化成本站地址
 * （线上行为零变化），部署者改成自己的域名只需设一个 `VITE_SITE_URL`。
 *
 * 两处消费：① 下面的 siteIdentity 插件替换 index.html 里的占位符；
 * ② 同名的 `define` 把值注入给 TS（读法见 `src/utils/siteUrl.ts`）。
 * 用 `define` 而不是 `import.meta.env` 就是为了**默认值只有这一份** ——
 * 否则 HTML 一个默认值、TS 一个默认值，改一处忘一处就会 canonical 与 og:url 打架。
 */
const SITE_URL = (process.env.VITE_SITE_URL || 'https://saudade.site').replace(/\/+$/, '');
const SITE_AUTHOR = process.env.VITE_SITE_AUTHOR || 'Sora';

const siteIdentity = (): Plugin => ({
    name: 'saudade-site-identity',
    transformIndexHtml: {
        // 'pre'：先于 Vite 自己的 env 替换跑。两边占位符不重叠，但显式定序免得将来撞上。
        order: 'pre',
        handler: (html: string) => html
            .replace(/__SITE_URL__/g, SITE_URL)
            .replace(/__SITE_AUTHOR__/g, SITE_AUTHOR),
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

export default defineConfig({
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
    },
});
