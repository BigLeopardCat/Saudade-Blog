/**
 * SPA 侧的错误上报（20261004）。
 *
 * 为什么要有这一层：`boot.js`（看板娘入口，住在 agent 仓，按 pin 取来）里那套全局捕获
 * 只覆盖它自己那半边，而且有三处结构性缺口：
 *   ① 它包的是 `window.fetch`，而 **SPA 唯一的 HTTP 客户端是 axios（走 XHR 适配器）**
 *      ⇒ 博客自身的接口失败在日志里一个字都没有（日志里只有看板娘的声音）；
 *   ② 它的 `error` 监听**没带 capture**，而资源加载失败的事件**不冒泡**
 *      ⇒ `<img>`/`<script>`/`<link>` 挂掉从来没进过日志；
 *   ③ 它是 `<script>` 挂进页面才注册的，React 渲染期抛错它抓不到（View 崩了但
 *      路由还活着，用户看到的是一片空白，日志里是干净的）。
 *
 * 这一层补的就是这三处，全部走同一个后端端点 `/api/monitor/log`。
 * 真源与副作用分开：纯函数在 `./reportCore`（可单测），这里只放碰 DOM / 网络的部分。
 *
 * ⚠️ `type` 是**闭集**：后端 `src/routes/monitor.rs` 的 `MONITOR_KINDS` 之外的取值
 * 会被收敛成 `other`（防匿名访客伪造整行）。这里新加一个 type，就要同步那边——
 * `tests/monitor-report.test.mjs` 会扫这份文件与 `MONITOR_KINDS` 逐字比对，漏了会红。
 */
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

/**
 * WebGL 可用性探针：一辈子只探一次。
 *
 * 为什么要它：`20261004` 那天 `monitor.log` 里 8 条 `Texture loading error` 究竟是
 * 真实访客还是无 GPU 的爬虫（同一时段还有一条来自裸 IP 的
 * `Unable to auto-detect a suitable renderer`），从落盘行里**分不出来** ——
 * 两类故障在日志里长得一模一样。带上这个标记就能一眼分开。
 */
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
