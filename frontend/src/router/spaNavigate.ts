/**
 * 站内跳转桥（20260926）：把「agent 让页面跳转」从**整页装载**改成 SPA 路由跳转。
 *
 * ── 现场（用户报的）──────────────────────────────────────────────────
 * 「我希望 agent 带着转跳页面时对话窗口不变」。此前前端只有两条跳转出路，两条都是
 * `window.location.href = …`：整页重载 ⇒ 对话面板、看板娘、会话抽屉、输入框里没发出去的
 * 半句话全部重建（面板在 `#root` **之外**、由 `boot.js` 注入，重载后靠 `chat_open`
 * 标记重新打开——"能回来"不等于"没动过"）。同一个目标用 SPA 路由走，`#root` 内换页、
 * 面板纹丝不动，这才是用户要的"不变"。
 *
 * ── 谁说了算：桥是**权威**，调用方只在它说 false 时回落 ─────────────────────
 * `window.__spaNavigate(url)`：命中返回 `true`（已换路由），未命中返回 `false`
 * （调用方照旧 `window.location.href`）。三条判据全中才算命中：
 *   ① 同源（比 `host`，与 chat-stream.js 既有的 `hostOk` 同口径——http/https 同 host
 *      也算同站，否则站内一条 http 链接会退化成整页跳转）；
 *   ② 路径在**站内白名单**里（`BLOG_PATH_PATTERNS`）；
 *   ③ 不在 `SPA_NAV_DENY` 里：`/api*` 不是页面；**`/device-console/` 不是 React 路由**
 *      （那是 nginx 直服的静态控制台，SPA 里没有对应页面 ⇒ 必须整页装载）。
 *
 * ── 白名单为什么有两份 ────────────────────────────────────────────────
 * `public/live2d-widgets/chat-stream.js` 是**不经打包的独立脚本**（看板娘那一套里，
 * 由 boot.js 注入），它 import 不到这个 TS 模块，所以它自己那份 `BLOG_ROUTES` 必须
 * 留着（跳转前它仍要自校验一遍，纵深防御）。两份同在的风险由测试消灭：
 * `tests/spa-navigate.test.mjs` 逐项比对两份清单，且断言"差集恰好等于 device-console"。
 *
 * ── 与"确认式跳转"无关 ────────────────────────────────────────────────
 * 本桥只负责**怎么跳**（SPA 还是整页）。"跳之前要不要弹卡问一句"是另一件事，已于
 * 20260926 停用（见 chat-stream.js 里那段注释掉的确认分支）——回复正文里本来就有超链接，
 * 而"推荐某个页面"被默认成跳转会把询问意图割裂掉。
 */

/** 站内白名单：**与 chat-stream.js 的 `BLOG_ROUTES` 逐项一致**（除它多出来的
 *  device-console 那一条——归 SPA 管不了，见 `SPA_NAV_DENY`）。改这里必须同步那边，
 *  否则 `tests/spa-navigate.test.mjs` 的比对照会红。 */
export const BLOG_PATH_PATTERNS: RegExp[] = [
    /^\/$/, /^\/about\/?$/, /^\/friends\/?$/, /^\/guestbook\/?$/, /^\/talk\/?$/, /^\/times\/?$/, /^\/login\/?$/,
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
    navigate(to: string): void;
}

/** 桥挂在哪里（就是 `window`；这个形状只为测试能塞一个假 window） */
export interface SpaNavSink {
    __spaNavigate?: (url: string) => boolean;
}

/** 把桥挂到 `window.__spaNavigate`（幂等：重复调用只是覆盖同一个函数）。
 *  `sink` 只为测试能塞一个假 window——浏览器里走默认值。 */
export function registerSpaNavigate(router: SpaRouterLike, sink: SpaNavSink = window): void {
    sink.__spaNavigate = (url: string): boolean => {
        const to = spaNavTarget(url);
        if (!to) return false;
        try {
            router.navigate(to);
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
    }
}
