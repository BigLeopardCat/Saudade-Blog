/**
 * 站点身份：地址、署名、站名、描述、keywords。**全前端读这里，别在别处写死域名/名字/文案。**
 *
 * 值不是常量，是构建期注入的（`vite.config.ts` 的 `define`）—— 没设对应的 `VITE_SITE_*` 时
 * 回落到中性占位（地址是 `http://localhost:5173`，站名是"个人博客"，描述是"本站开发地址…"，
 * 署名与 keywords 是空串 ⇒ HTML 里**整行删掉**）。见 `vite.config.ts` 的注释：
 * 缺省值必须一眼看得出"没配好"，而不是恰好指向本项目作者的站。
 * 部署者设 `VITE_SITE_URL` / `VITE_SITE_AUTHOR` / `VITE_SITE_TITLE` /
 * `VITE_SITE_DESCRIPTION` / `VITE_SITE_KEYWORDS` 即可换成自己的，**不用改源码**。
 * 默认值只写在 `vite.config.ts` 一处；本模块只负责把它接到 TS 侧。
 *
 * 为什么要绕这一道而不直接写 `import.meta.env.VITE_SITE_URL`：
 *   那样 TS 侧就得自己再写一份默认值，与 `vite.config.ts` 里那份迟早对不上
 *   （canonical 说 A 域名、og:url 说 B 域名，还只在没设环境变量的部署上复现）。
 *
 * `index.html` 用的是同名占位符（`__SITE_URL__` / `__SITE_AUTHOR__` / `__SITE_TITLE__` /
 * `__SITE_DESCRIPTION__` / `__SITE_KEYWORDS__`），由同一个插件替换 —— 静态 HTML 里没法
 * `import`，所以那一侧只能走文本替换。
 */

/** 形如 `https://example.com`，**无尾斜杠**（拼接 `SITE_URL + '/article/1'` 是常见写法）。 */
export const SITE_URL = __SITE_URL__;

/** 站点署名（`<meta name="author">`）；空串表示没配。 */
export const SITE_AUTHOR = __SITE_AUTHOR__;

/** 站名（`<title>` / og:title / 各页标题后缀 `X | 站名`）。 */
export const SITE_TITLE = __SITE_TITLE__;

/** 站点描述（`<meta name="description">` / og:description / twitter:description）。 */
export const SITE_DESCRIPTION = __SITE_DESCRIPTION__;

/** keywords（`<meta name="keywords">`）；空串表示没配，构建时整行删掉。 */
export const SITE_KEYWORDS = __SITE_KEYWORDS__;
