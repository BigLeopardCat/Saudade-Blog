/** 站内白名单：**与 chat-stream.js 的 `BLOG_ROUTES` 逐项一致**（除它多出来的
 *  device-console 那一条——归 SPA 管不了，见 `SPA_NAV_DENY`）。改这里必须同步那边，
 *  否则 `tests/spa-navigate.test.mjs` 的比对照会红。 */
export const BLOG_PATH_PATTERNS: RegExp[] = [
    /^\/$/, /^\/about\/?$/, /^\/guestbook\/?$/, /^\/talk\/?$/, /^\/times\/?$/, /^\/login\/?$/,
    /^\/dashboard/, /^\/category\//, /^\/article\//,
];

/** 即便同源也**不归 SPA 管**的前缀。`/api*` 根本不是页面；`/device-console/` 是 nginx
 *  直服的静态控制台（非 React 路由），只能整页装载。命中这里 ⇒ 桥返回 false。 */
export const SPA_NAV_DENY: RegExp[] = [/^\/api(\/|$)/, /^\/device-console\/?$/];

/** 不接管的原因码（测试与排障用；`null` = 该接管） */
export type SpaNavSkip = 'unparsable' | 'not-http' | 'cross-host' | 'denied-prefix' | 'off-whitelist';

/** 纯函数：这个地址该不该由 SPA 接管？不该则给出原因码。
 *  `base`（当前页面绝对地址）用于解析相对 href；`host` 是本站 host（`location.host`）。 */
export function spaNavReason(url: string, base: string, host: string): SpaNavSkip | null {
    let u: URL;
    try {
        u = new URL(url, base);
    } catch {
        return 'unparsable';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'not-http';
    if (u.host !== host) return 'cross-host';
    if (SPA_NAV_DENY.some((r) => r.test(u.pathname))) return 'denied-prefix';
    if (!BLOG_PATH_PATTERNS.some((r) => r.test(u.pathname))) return 'off-whitelist';
    return null;
}

/** 接管时要交给 `router.navigate` 的**站内相对地址**（path + query + hash，
 *  丢掉 scheme/host——跨域早就被上面挡掉了）；不接管返回 `null`。 */
export function spaNavTarget(url: string, base?: string, host?: string): string | null {
    const b = base ?? window.location.href;
    const h = host ?? window.location.host;
    if (spaNavReason(url, b, h)) return null;
    const u = new URL(url, b);
    return u.pathname + u.search + u.hash;
}

/** 桥要用的最小 router 形状（`createBrowserRouter` 的返回值满足它） */
export interface SpaRouterLike {
    navigate(to: string): void | Promise<void>;
}

/** 桥挂在哪里（就是 `window`；这个形状只为测试能塞一个假 window） */
export interface SpaNavSink {
    __spaNavigate?: (url: string) => boolean;
    __spaNavigationComplete?: Promise<void>;
}

/** 把桥挂到 `window.__spaNavigate`（幂等：重复调用只是覆盖同一个函数）。
 *  `sink` 只为测试能塞一个假 window——浏览器里走默认值。 */
export function registerSpaNavigate(router: SpaRouterLike, sink: SpaNavSink = window): void {
    sink.__spaNavigate = (url: string): boolean => {
        const to = spaNavTarget(url);
        if (!to) return false;
        try {
            sink.__spaNavigationComplete = Promise.resolve(router.navigate(to));
            // Legacy clients do not await the promise; new clients inspect its result.
            void sink.__spaNavigationComplete.catch(() => {});
        } catch (e) {
            // 路由跳失败（不该发生）就当没接管过：调用方会回落整页跳转，绝不静默吞掉一次跳转
            console.warn('[spa-nav] router.navigate 失败，回落整页跳转: ' + to, e);
            return false;
        }
        return true;
    };
}

declare global {
    interface Window {
        /** 站内跳转桥（`registerSpaNavigate` 挂上）。命中 true = 已换路由；
         *  false/缺席 = 调用方回落 `window.location.href`。 */
        __spaNavigate?: (url: string) => boolean;
        __spaNavigationComplete?: Promise<void>;
    }
}
