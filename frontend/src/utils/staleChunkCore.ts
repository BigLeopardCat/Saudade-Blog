/**
 * 「这一页要的那条 chunk 已经不在服务器上了」——识别与自愈闸的**纯逻辑内核**（20261005）。
 *
 * 现场（A 案，20261005 用户拍板）：部署换代时 `deploy_from_r2.sh` 会拿**本次构建的
 * dist 清单**做集合差，把上一代的文件删掉（这正是它该干的）。而一个**一直开着的**标签页
 * 还停留在老那一版：它的 `index.html` 与主包是老一代的，其中的 `import()` 指向老一代的
 * 分块文件名（带内容哈希）——点开首页展示柜（`lazy(() => import('./wordgraph/WordGraphExhibit'))`）
 * 时那条 URL 已经 404，于是 `monitor.log` 里落下一行
 * `react_error … Failed to fetch dynamically imported module: …/WordGraphExhibit-<hash>.js`，
 * 用户看到的是一张「页面出了点小问题」的兜底卡，而且卡上那颗**重试永远不会成功**
 * （重新挂载子树拿的还是同一个 URL）。唯一的出路是整页刷新 —— 刷完就是新那一代。
 *
 * 与 `reportCore.ts` 的分工一样：这里只放不碰 DOM / `sessionStorage` 的纯函数，能被
 * esbuild 打包后直接单测（见 `tests/stale-chunk.test.mjs`）；副作用全在 `staleChunk.ts`。
 */

/**
 * 认得出的几种措辞。**按"浏览器真会这么说"列**，不是按"看着像"：
 *   · Chrome / Edge：`Failed to fetch dynamically imported module: <url>`
 *     ——生产日志里那一行就是这句（20261005 之前它是被当成普通 react_error 收的）；
 *   · Chromium 另一条分支：`error loading dynamically imported module`；
 *   · Safari / 旧 Chromium：`Importing a module script failed.`；
 *   · Vite `__vitePreload` 的 CSS 分支：`Unable to preload CSS for <url>`
 *     ——分块里的样式表没预载上来，同样是"老一代的引用"。
 * 匹配的是**整句话**而不是"含 fetch 就算"：这条判据的另一头是"整页刷新"，
 * 误伤（把普通网络错误也当成换代的痕迹）会让用户在好好的页面被刷掉一次。
 */
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
