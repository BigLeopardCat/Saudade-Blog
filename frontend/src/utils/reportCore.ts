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

/** 按 Unicode 码点截断，避免拆开代理对。 */
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

/** 排除日志端点自身，避免报告失败递归。 */
export function isOwnReport(url: string): boolean {
    return urlPath(url).indexOf(REPORT_URL) === 0
}

/** 401 由登录失效流程处理，不重复记录。 */
const QUIET_STATUS = [401]

/** 这个状态码值不值得进日志。`undefined`（网络层失败、无响应）不算状态码。 */
export function shouldReportStatus(status: number | undefined): boolean {
    return typeof status === 'number' && status >= 400 && !QUIET_STATUS.includes(status)
}

/** Retain the resource origin/path, never credentials, query secrets or inline data. */
export function diagnosticUrl(value: string): string {
    if (/^(data|blob):/i.test(value)) return value.slice(0, value.indexOf(':')).toLowerCase() + ':[redacted]'
    if (/^(https?:)?\/\//i.test(value)) {
        try {
            const url = new URL(value, 'https://diagnostic.invalid')
            return (value.startsWith('//') ? '//' + url.host : url.origin) + url.pathname
        } catch { return '[invalid-url]' }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '[unsupported-url]'
    return urlPath(value)
}

function diagnosticText(value: unknown, source: string, safeSource: string): string {
    const text = String(value ?? '')
    const replaced = source ? text.split(source).join(safeSource) : text
    return replaced.replace(/data:[\s\S]*|blob:[^\s<>"']+|https?:\/\/[^\s<>"']+|\/api\/[^\s<>"']+/gi, diagnosticUrl)
}

/** 组装请求体：截断 + `webgl` 归一（`null` = 没探到 ⇒ `unknown`，**不是 `no`**）。 */
export function shapeReport(p: ReportPayload, pageUrl: string, webgl: boolean | null): ReportBody {
    const source = p.url || pageUrl
    const safeSource = diagnosticUrl(source)
    return {
        type: p.type,
        message: clip(diagnosticText(p.message, source, safeSource), MAX_MESSAGE),
        stack: clip(diagnosticText(p.stack, source, safeSource), MAX_STACK),
        url: clip(safeSource, MAX_URL),
        webgl: webgl === true ? 'yes' : webgl === false ? 'no' : 'unknown',
    }
}

/** 本页去重独立于服务端跨访客窗口，键包含错误类型、消息前缀及资源路径。 */
export function dedupeKey(b: { type: string; message: string; url: string }): string {
    return b.type + '|' + b.message.slice(0, KEY_MESSAGE) + '|' + b.url
}

/** 会发 `error` 事件的资源标签。 */
const RESOURCE_TAGS = new Set(['IMG', 'SCRIPT', 'LINK', 'VIDEO', 'AUDIO', 'SOURCE', 'IFRAME'])

export interface ResourceFailure {
    url: string
    tag: string
}

/** 仅识别资源元素错误；window 上的运行时异常不归入此类。 */
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
        if (typeof v === 'string' && v) return { url: diagnosticUrl(v), tag }
    }
    return { url: '', tag }
}
