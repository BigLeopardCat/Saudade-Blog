/**
 * 前端错误上报的**纯逻辑内核**（20261004）。
 *
 * 与 `report.ts` 的分工：这里只放不碰 DOM / 网络的纯函数（能被打包后直接单测，
 * 见 `tests/monitor-report.test.mjs`），副作用（监听器、fetch、WebGL 探针）全在
 * `report.ts`。日志侧的字段名与截断上限**必须**与 Rust 那头对齐：
 * `src/routes/monitor.rs`（`size 上限 8KB ⇒ 这里先截，免得整条被 413 掉）。
 */

/** 上报端点的相对路径（与后端 `src/routes/monitor.rs` 的路由、`boot.js` 的 REPORT_URL 同源）。 */
export const REPORT_URL = '/api/monitor/log'

/** 后端 `truncate` 的同口径上限（message 2000 / stack 4000 / url 500）。 */
const MAX_MESSAGE = 2000
const MAX_STACK = 4000
const MAX_URL = 500

/** 去重 key 里 message 只取前 80 字（同 boot.js 与其后的服务端去重）。 */
const KEY_MESSAGE = 80

export interface ReportPayload {
    type: string
    message?: string
    stack?: string
    url?: string
}

/** 真正发出去的请求体。字段名 = 后端 `ReportPayload` 的字段名，改这里要同步那边。 */
export interface ReportBody {
    type: string
    message: string
    stack: string
    url: string
    webgl: 'yes' | 'no' | 'unknown'
}

/**
 * 按**码点**截断。
 *
 * 不能用 `String.prototype.slice`：它按 UTF-16 码元切，会把一个 emoji（代理对）切成
 * 两半，落盘就是一个孤立代理。Rust 那头同一个坑（审计 A1）会直接 panic —— 这里不会
 * 崩，但会产生一串谁也不认识的乱码，而且是**静默**的。
 */
export function clip(s: string, max: number): string {
    if (s.length <= max) return s
    return Array.from(s).slice(0, max).join('')
}

/** URL 的路径部分：相对（`/api/x`）、绝对（`https://h/api/x`）都归一成 `/api/x`。 */
export function urlPath(url: string): string {
    try {
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return new URL(url).pathname
    } catch {
        /* 不是合法绝对 URL ⇒ 走下面的相对分支 */
    }
    let end = url.length
    const q = url.indexOf('?')
    const h = url.indexOf('#')
    if (q >= 0) end = Math.min(end, q)
    if (h >= 0) end = Math.min(end, h)
    return url.slice(0, end)
}

/**
 * 上报端点自己发的请求不许被上报。
 *
 * 没有这道闸就是死循环：上报失败 → 捕获到失败 → 再上报（boot.js 的 fetch 包装与
 * 这里的 axios 拦截器各有一条同样的排除，三处都要有）。
 */
export function isOwnReport(url: string): boolean {
    return urlPath(url).indexOf(REPORT_URL) === 0
}

/**
 * 401 不进日志：它有专门处理（清 token + 跳登录）且**必然发生**——过期令牌的访客
 * 每开一个页面就报一次，真异常会被它淹掉。403 不在这里（角色不足是"谁在点"的问题，
 * 值得看得见）。与 `apis/axios.tsx` 里那段注释是同一件事的两半。
 */
const QUIET_STATUS = [401]

/** 这个状态码值不值得进日志。`undefined`（网络层失败、无响应）不算状态码。 */
export function shouldReportStatus(status: number | undefined): boolean {
    return typeof status === 'number' && status >= 400 && !QUIET_STATUS.includes(status)
}

/** 组装请求体：截断 + `webgl` 归一（`null` = 没探到 ⇒ `unknown`，**不是 `no`**）。 */
export function shapeReport(p: ReportPayload, pageUrl: string, webgl: boolean | null): ReportBody {
    return {
        type: p.type,
        message: clip(String(p.message ?? ''), MAX_MESSAGE),
        stack: clip(String(p.stack ?? ''), MAX_STACK),
        url: clip(p.url || pageUrl, MAX_URL),
        webgl: webgl === true ? 'yes' : webgl === false ? 'no' : 'unknown',
    }
}

/**
 * 本页会话内的去重键（刷新即重置）。
 *
 * 与服务端那 60 秒计数是**两道不同用途的闸**：这一道防的是"同一个渲染循环里报一万次"
 * （在那之前就把网络请求省掉），服务端那道跨访客合并。两边都用同一套 key 形状。
 */
export function dedupeKey(b: { type: string; message: string; url: string }): string {
    return b.type + '|' + b.message.slice(0, KEY_MESSAGE) + '|' + b.url
}

/** 会发 `error` 事件的资源标签。 */
const RESOURCE_TAGS = new Set(['IMG', 'SCRIPT', 'LINK', 'VIDEO', 'AUDIO', 'SOURCE', 'IFRAME'])

export interface ResourceFailure {
    url: string
    tag: string
}

/**
 * 从 `error` 事件里认出"资源加载失败"，认不出返回 `null`。
 *
 * 这个判别式是必需的：**运行时 JS 异常也走 window 的 error 事件**，那种情况下
 * `target` 是 window 自己（没有 tagName）⇒ 返回 null，不会被这里重复报一遍
 * （`boot.js` 已经在报 `js_error` 了）。
 *
 * 参数故意写成鸭子类型而不是 `ErrorEvent`：单测里可以用一个普通对象驱动它，
 * 不用起 DOM。
 */
export function resourceFailure(evt: { target?: unknown }): ResourceFailure | null {
    const el = (evt && typeof evt === 'object' ? evt.target : null) as {
        tagName?: unknown
        src?: unknown
        href?: unknown
        currentSrc?: unknown
    } | null
    if (!el || typeof el !== 'object') return null
    const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
    if (!RESOURCE_TAGS.has(tag)) return null
    for (const v of [el.currentSrc, el.src, el.href]) {
        if (typeof v === 'string' && v) return { url: v, tag }
    }
    return { url: '', tag }
}
