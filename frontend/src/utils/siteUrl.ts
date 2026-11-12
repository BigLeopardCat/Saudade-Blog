/** 站点身份由 vite.config.ts 统一注入 TS 与 HTML；本模块不重复定义默认值。 */

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
