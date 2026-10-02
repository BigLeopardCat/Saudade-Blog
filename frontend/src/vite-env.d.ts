/// <reference types="vite/client" />

/**
 * 构建期注入的站点身份（`vite.config.ts` 的 `define`）。
 * 这两个名字在**源码里不该直接读** —— 请 `import { SITE_URL, SITE_AUTHOR } from './utils/siteUrl'`，
 * 那里有取值与默认值的说明。这里只是让 TS 知道它们存在。
 */
declare const __SITE_URL__: string;
declare const __SITE_AUTHOR__: string;

/**
 * 构建期注入：图谱产物的语料是否属于本站（判定见 `vite.config.ts` 的 GRAPH_OWNERSHIP）。
 * 消费方只有 `Vitrine/exhibits.ts` —— 不是本站就不注册那件展品。
 */
declare const __GRAPH_LOCAL__: boolean;
