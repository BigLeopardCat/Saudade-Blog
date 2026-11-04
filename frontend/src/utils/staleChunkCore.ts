const STALE_CHUNK_RES: RegExp[] = [
    /failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    /unable to preload css/i,
]

/** 从任意抛出来的东西里取一句可读文本（`Error` / 字符串 / 带 message 的对象 / 其它）。 */
export const messageOf = (err: unknown): string => {
    if (typeof err === 'string') return err
    if (err instanceof Error) return err.message || String(err)
    if (err && typeof err === 'object') {
        const m = (err as { message?: unknown }).message
        if (typeof m === 'string') return m
    }
    return String(err ?? '')
}

/** 这条消息是不是"换代的痕迹"。 */
export const isStaleChunkMessage = (message: string): boolean =>
    STALE_CHUNK_RES.some((re) => re.test(message))

/** 两次自愈之间的最小间隔（毫秒）。 */
export const RELOAD_GUARD_MS = 60_000

/**
 * 现在该不该自动刷新一次？
 *
 * `lastReloadAt` = 本标签页**上一次自愈**的时间戳（从没刷过是 `null`）。闸的意义：
 * 自动刷新只在"刷新真的能解决"时才对——而如果刷完还是同一个错误，说明那条 chunk
 * **真的不在服务器上**（构建里就没有它 / 被安全软件拦了 / 离线），此时再刷就是死循环，
 * 用户会看着页面永远在转圈。所以：刷过一次之后，一分钟内一律不再刷，让兜底卡说话
 * （卡上有手动「刷新页面」，用户自己决定）。一分钟以外重新放行：那是"又发生了一次换代"，
 * 该再自愈一次。
 */
export const shouldAutoReload = (lastReloadAt: number | null, now: number): boolean => {
    if (lastReloadAt === null || !Number.isFinite(lastReloadAt)) return true
    return now - lastReloadAt > RELOAD_GUARD_MS
}
