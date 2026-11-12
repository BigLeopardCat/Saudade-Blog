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

/** 先记录刷新标记，再尝试恢复缺失资源，避免失败刷新循环。
 * 仅报告一次 module_load_fail；调用方根据返回值决定是否展示手动刷新入口。 */
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
