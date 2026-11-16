import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Native builds share fixed HTML/TS identity; portable images resolve their public origin in the browser. */
const PORTABLE_SITE = process.env.VITE_PORTABLE_SITE === '1';
const SITE_URL = PORTABLE_SITE ? '' : (process.env.VITE_SITE_URL || 'http://localhost:5173').replace(/\/+$/, '');
// 未配置署名时省略对应元数据。
const SITE_AUTHOR = process.env.VITE_SITE_AUTHOR || '';
const SITE_TITLE = process.env.VITE_SITE_TITLE || '个人博客';
const SITE_DESCRIPTION = process.env.VITE_SITE_DESCRIPTION || (PORTABLE_SITE ? '个人博客与内容分享。' : '本站开发地址，尚未配置站点描述。');
// 关键词留空时省略对应元数据。
const SITE_KEYWORDS = process.env.VITE_SITE_KEYWORDS || '';

if (!PORTABLE_SITE && !process.env.VITE_SITE_URL) {
    console.warn(
        '[site-identity] 未设 VITE_SITE_URL，canonical / og:url / robots.txt 将回落到 '
        + `${SITE_URL} —— 线上构建必须设它（CI 见 deploy.yml 的 VITE_SITE_URL 环境变量）。`,
    );
}
if (!process.env.VITE_SITE_TITLE || !process.env.VITE_SITE_DESCRIPTION) {
    console.warn(
        '[site-identity] 未设 VITE_SITE_TITLE / VITE_SITE_DESCRIPTION，站名与描述用中性占位 '
        + `("${SITE_TITLE}" / "${SITE_DESCRIPTION}") —— 自己的站点要设这两个（CI 见 deploy.yml）。`,
    );
}

/** Escape deployment-supplied metadata before inserting HTML attributes or text. */
const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const siteIdentity = (): Plugin => ({
    name: 'saudade-site-identity',
    transformIndexHtml: {
        // 'pre'：先于 Vite 自己的 env 替换跑。两边占位符不重叠，但显式定序免得将来撞上。
        order: 'pre',
        handler: (html: string) => {
            let out = html
                .replace(/__SITE_URL__/g, SITE_URL)
                .replace(/__SITE_AUTHOR__/g, SITE_AUTHOR)
                .replace(/__SITE_TITLE__/g, esc(SITE_TITLE))
                .replace(/__SITE_DESCRIPTION__/g, esc(SITE_DESCRIPTION))
                .replace(/__SITE_KEYWORDS__/g, esc(SITE_KEYWORDS));
            // 未配置的可选元数据不输出空标签。
            if (!SITE_AUTHOR) out = out.replace(/^[^\S\n]*<meta name="author"[^>]*>\n/m, '');
            if (!SITE_KEYWORDS) out = out.replace(/^[^\S\n]*<meta name="keywords"[^>]*>\n/m, '');
            if (PORTABLE_SITE) out = out.replace(/^[^\S\n]*<meta[^>]*property="og:(url|image)"[^>]*>\n/gm, '');
            return out;
        },
    },
    // Native builds emit an absolute sitemap URL; portable containers serve robots from runtime SITE_URL.
    generateBundle() {
        this.emitFile({
            type: 'asset',
            fileName: 'robots.txt',
            source: `User-agent: *\nAllow: /\n${SITE_URL ? `\nSitemap: ${SITE_URL}/sitemap.xml\n` : ''}`,
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

    server: {
        // 远程开发容器需要监听所有网卡，VS Code 才能发现并转发 5173。
        host: '0.0.0.0',
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': 'http://127.0.0.1:3000',
        },
    },

    define: {
        __SITE_URL__: JSON.stringify(SITE_URL),
        __SITE_AUTHOR__: JSON.stringify(SITE_AUTHOR),
        // 站名 / 描述 / keywords 同理：**TS 侧不许有第二份默认值**。
        // 这里注入的是**未转义**的原值（TS 里是字符串，交给 React 转义）。
        __SITE_TITLE__: JSON.stringify(SITE_TITLE),
        __SITE_DESCRIPTION__: JSON.stringify(SITE_DESCRIPTION),
        __SITE_KEYWORDS__: JSON.stringify(SITE_KEYWORDS),
    },

    build: {
        cssCodeSplit: true,
        assetsDir: 'assets',
        assetsInlineLimit: 4096,
        sourcemap: false,
        reportCompressedSize: false,
        rolldownOptions: {
            output: {
                chunkFileNames: 'vendor/[name]-[hash].js',
                entryFileNames: 'js/[name]-[hash].js',
                assetFileNames: '[ext]/[name]-[hash].[ext]',
                // Rolldown groups keep React and its scheduler in a shared cacheable chunk.
                codeSplitting: {
                    groups: [
                        {
                            name: 'react-vendor',
                            test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                        },
                    ],
                },
            },
        },
    }
}));
