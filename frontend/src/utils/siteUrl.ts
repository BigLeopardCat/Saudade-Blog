/**
 * 站点身份：地址与署名。**全前端读这里，别在别处写死域名/名字。**
 *
 * 值不是常量，是构建期注入的（`vite.config.ts` 的 `define`）—— 没设 `VITE_SITE_URL` 时
 * 回落到中性占位 `http://localhost:5173`（**不是任何真实域名**，见 `vite.config.ts` 的注释），
 * 部署者设 `VITE_SITE_URL` / `VITE_SITE_AUTHOR` 即可换成自己的，**不用改源码**。
 * 默认值只写在 `vite.config.ts` 一处；本模块只负责把它接到 TS 侧。
 *
 * 为什么要绕这一道而不直接写 `import.meta.env.VITE_SITE_URL`：
 *   那样 TS 侧就得自己再写一份默认值，与 `vite.config.ts` 里那份迟早对不上
 *   （canonical 说 A 域名、og:url 说 B 域名，还只在没设环境变量的部署上复现）。
 *
 * `index.html` 用的是同名占位符 `__SITE_URL__` / `__SITE_AUTHOR__`，由同一个插件替换 ——
 * 静态 HTML 里没法 `import`，所以那一侧只能走文本替换。
 */

/** 形如 `https://example.com`，**无尾斜杠**（拼接 `SITE_URL + '/article/1'` 是常见写法）。 */
export const SITE_URL = __SITE_URL__;

/** 站点署名（`<meta name="author">`）。 */
export const SITE_AUTHOR = __SITE_AUTHOR__;
