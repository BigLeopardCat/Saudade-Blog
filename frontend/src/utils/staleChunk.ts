/**
 * 换代后的悬空 chunk：识别 + **带闸的一次性自愈**（20261005，A 案）。
 *
 * 纯逻辑在 `staleChunkCore.ts`（含"认哪些措辞""闸怎么算"两件事），这里只放副作用
 * （读 `sessionStorage`、`location.reload`）。两个触发点共用这一份实现：
 *   · `components/ErrorBoundary` —— 生产里**真正**会走的那条（React.lazy 的 import 被拒
 *     ⇒ 边界接住，`monitor.log` 里那行 react_error 就是它）；
 *   · `main.tsx` 的 `vite:preloadError` 监听 —— Vite 预载那条路的兜底（原生 `import()`
 *     不经过它，所以两者都得接）。
 */
import { reportError } from './report'
import { isStaleChunkMessage, messageOf, shouldAutoReload } from './staleChunkCore'

/** 本标签页上一次自愈的时间戳（sessionStorage：刷新后仍在、关掉标签页即消失）。 */
const FLAG = 'staleChunkReloadAt'

const readStamp = (): number | null => {
    try {
        const raw = sessionStorage.getItem(FLAG)
        return raw === null ? null : Number(raw)
    } catch {
        return null // 隐私模式 / 存储被禁：当作"从没刷过"
    }
}

const writeStamp = (t: number): void => {
    try {
        sessionStorage.setItem(FLAG, String(t))
    } catch {
        /* 写不进去只影响"少刷一次"，不影响正确性 */
    }
}

/** 这个错误是不是"换代的痕迹"（判据在 `staleChunkCore`）。 */
export const isStaleChunkError = (err: unknown): boolean => isStaleChunkMessage(messageOf(err))

/**
 * 试一次自愈：真的刷了返回 `true`，闸挡住（刚刷过）返回 `false`。
 *
 * ⚠️ 顺序是**先写标记、再刷新**，不是反过来：万一刷新本身失败（离线、服务端 502、
 * 用户按了停止），标记已经落下了 ⇒ 下一次撞上同一个错误不会再刷，页面老老实实显示
 * 兜底卡 —— 否则就是"刷—坏—刷"的死循环。
 * 调用方（ErrorBoundary）据此决定是"正在刷新"还是"请你手动刷新"。
 *
 * 落日志就在这一处（**一次事故一行**）：`module_load_fail` 是白名单里现成的一档，
 * 语义正好（`type` 是闭集，见 `utils/report.ts` 头注）。所以 ErrorBoundary 那边遇到
 * 这一类错误**不再另报** react_error —— 两行说的是同一件事，而 componentStack 在这个
 * 场景恒是 `at Lazy at Suspense`，没有信息量。`fetch(keepalive)` 活得比这次导航长，
 * 刷走之前送得出去。
 */
export const recoverFromStaleChunk = (err?: unknown): boolean => {
    const now = Date.now()
    if (!shouldAutoReload(readStamp(), now)) return false
    writeStamp(now)
    reportError({
        type: 'module_load_fail',
        message: 'stale chunk（部署换代，已自动刷新）: ' + messageOf(err),
        url: location.href,
    })
    location.reload()
    return true
}
