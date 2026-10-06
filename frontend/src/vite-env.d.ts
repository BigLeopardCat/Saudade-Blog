/// <reference types="vite/client" />

/**
 * 构建期注入的站点身份（`vite.config.ts` 的 `define`）。
 * 这些名字在**源码里不该直接读** —— 请从 `./utils/siteUrl` 取值，
 * 那里有取值与默认值的说明。这里只是让 TS 知道它们存在。
 */
declare const __SITE_URL__: string;
declare const __SITE_AUTHOR__: string;
declare const __SITE_TITLE__: string;
declare const __SITE_DESCRIPTION__: string;
declare const __SITE_KEYWORDS__: string;
