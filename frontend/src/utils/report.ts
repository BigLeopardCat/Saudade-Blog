import { runtimeBaseURL } from './runtimeApi'
import {
    REPORT_URL,
    dedupeKey,
    isOwnReport,
    resourceFailure,
    shapeReport,
} from './reportCore'
import type { ReportPayload } from './reportCore'

/** 本页会话内已报过的 key（刷新重置）。上限一到就整体清空：这里只做粗筛，真去重在服务端。 */
const seen = new Set<string>()
const SEEN_MAX = 200

let webglCache: boolean | null | undefined

function webglAvailable(): boolean | null {
    if (webglCache !== undefined) return webglCache
    webglCache = null
    try {
        const canvas = document.createElement('canvas')
        const gl = (canvas.getContext('webgl') ||
            canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
        webglCache = !!gl
        // 探完主动释放：浏览器同时活着的 WebGL context 数有上限（约 16），
        // 看板娘自己要占一个 —— 探针不该成为"看板娘注册失败"的新成因。
        gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.()
    } catch {
        /* canvas 都建不出来 ⇒ 保持 null（unknown） */
    }
    return webglCache
}

/** 上报一条前端错误。**永远不抛、永远不 await**——上报不该有能力影响页面。 */
export function reportError(payload: ReportPayload): void {
    try {
        const body = shapeReport(payload, location.href, webglAvailable())
        const key = dedupeKey(body)
        if (seen.has(key)) return
        if (seen.size >= SEEN_MAX) seen.clear()
        seen.add(key)

        let token = ''
        try {
            token = localStorage.getItem('tokenKey') || ''
        } catch {
            /* 隐私模式 / 存储被禁 */
        }
        fetch(runtimeBaseURL + REPORT_URL, {
            method: 'POST',
            // 与 boot.js 一致：导航/关闭页面时也尽量把这一条送出去
            keepalive: true,
            headers: {
                'Content-Type': 'application/json',
                ...(token
                    ? { Authorization: token.startsWith('Bearer ') ? token : 'Bearer ' + token }
                    : {}),
            },
            body: JSON.stringify(body),
        }).catch(() => {
            /* 上报自身失败静默：它没有第二层兜底，也不能递归 */
        })
    } catch {
        /* 组装/发起任何一步出问题都不许往上传 */
    }
}

/**
 * 资源加载失败（`<img>` / `<script>` / `<link>` / …）。
 *
 * **必须 `capture: true`**：资源加载失败的 `error` 事件在元素上派发、**不冒泡**，
 * 冒泡阶段的 window 监听器根本收不到（`boot.js` 那条就是这样漏了四年的）。
 * 捕获阶段能听到，且 `resourceFailure()` 会把运行时 JS 异常（target = window）
 * 分辨出去，不与 `boot.js` 的 `js_error` 重复。
 */
// `typeof window` 那道判断不是装饰：本仓的沙箱会把这些模块**打包进 node** 里 import
// （见 frontend/README 的测试一节），而 axios 是被组件广泛引用的——监听器在 import 期
// 就注册的话，没有 window 的环境会当场 ReferenceError，炸的是别人的套件。
if (typeof window !== 'undefined') {
    window.addEventListener(
        'error',
        (e) => {
            const failure = resourceFailure(e)
            if (!failure) return
            if (isOwnReport(failure.url)) return
            reportError({
                type: 'resource_error',
                message: failure.tag.toLowerCase() + ' 资源加载失败',
                url: failure.url || location.href,
            })
        },
        true
    )
}
