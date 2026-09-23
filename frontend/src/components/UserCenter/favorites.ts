/**
 * 收藏状态的**单一真源**（20260923 三轮，修「两处收藏状态互不同步」）。
 *
 * 事故形态（用户报的）：详情页的「收藏/已收藏」按钮与个人中心「收藏的文章」列表各拉各的、
 * 各存各的 state，谁改了另一边都不知道——
 *   · 在个人中心点「取消收藏」→ 详情页（同一篇、同一个标签页，SPA 不重挂）按钮还是「已收藏」；
 *   · 在详情页点了收藏 → 个人中心列表还是旧的那两条（`loadTab` 用 `xxx === null` 门控，
 *     组件常挂载 ⇒ 这一次页面生命周期里再也不会重拉）；
 *   · 看板娘那边的写工具（agent 的 add_favorite/remove_favorite）改完，两处都不知道。
 *
 * 现在：**收藏列表只有一份**（本模块的 `list`），谁要显示就来订阅，谁改了就说一声。
 * 刷新时机（少一个就会"改完不变"）：
 *   1. `useFavorites(true)` 生效时拉一次（详情页进页面 / 个人中心点开收藏页签）；
 *   2. `favorites-change` 自定义事件（本站自己改完当场对齐，不等下一次）；
 *   3. `agent-turn-done`（chat-stream.js 每轮对话收尾派发）——agent 可能刚写过收藏；
 *   4. `visibilitychange`（切回来补一次——后台标签页里事件/定时器会被降频）。
 *
 * 四处**刻意**的设计，改之前先看：
 *   · `overrides`（本地写入的即时结果）：写成功到全量拉回来之间有个空窗，没有它图标要等
 *     一个往返才翻；有它就不怕"写成功但这次拉取失败"把界面钉在错的那一侧。
 *   · `seq`（请求代次）：在途的读数是**写入之前**的快照，直接采纳会把刚点掉的那颗★又点亮
 *     （进页面即拉、用户趁没回来就点收藏，是很常见的一条时序）⇒ 本地写入会让在途读数作废。
 *   · 拉取失败**不清空**已有的 list：清空会让详情页的★闪一下、个人中心列表空一屏，
 *     而失败本身并没有改变任何事实。
 *   · 未登录（无 token）时才清空——那不是失败，是"这台机器上没有收藏可言"。
 */
import { useCallback, useEffect, useState } from 'react'
import getToken from '../../apis/getToken.tsx'
import { getFavorites, ok } from '../../apis/ProfileMethods.tsx'
import type { FavoriteItem } from '../../interface/ProfileType'
import { AGENT_TURN_DONE_EVENT } from './agentTurn.ts'

/** 收藏变了 → 让所有显示收藏的地方立刻重算（调用方不用知道谁在看收藏） */
export const FAVORITES_CHANGED_EVENT = 'favorites-change'

/** 收藏列表（null = 还没成功读到过）。**同一个引用**只在拉到新数据时被替换。 */
let list: FavoriteItem[] | null = null
/** 上一次拉取是不是失败了。**必须与"读到的是空的"分开**：读不到却显示"还没有收藏的文章"
 * 是同一族谎（本仓纪律：未登录/读不到 ≠ 空，见 narrator 纪律 20 的同一判据）。 */
let failed = false
/** 本地已知的写入结果（noteId → 是否已收藏），一次"写入之后发出"的读成功即清空 */
let overrides = new Map<string, boolean>()
/** 去重：同一时刻只发一次 GET（详情页与个人中心可能同时要） */
let inflight: Promise<void> | null = null
/** 请求代次：只有"最后一次发出"的那份读数才作数（见头注 seq） */
let seq = 0
/** 活着的订阅者数：0 时不发请求（没人在看收藏，拉它干嘛） */
let active = 0
const subs = new Set<() => void>()

const key = (id: number | string) => String(id)

function emit(): void {
    subs.forEach((fn) => { try { fn() } catch (e) { /* 一个订阅者抛错不该拖垮其余 */ } })
}

/** 订阅本 store（组件不要直接调，走 useFavorites） */
function subscribe(fn: () => void): () => void {
    subs.add(fn)
    return () => { subs.delete(fn) }
}

/**
 * 登记一个"此刻真的在看收藏"的消费者（`useFavorites(enabled)` 生效时调用），
 * 返回取消登记的函数。**登记期间**事件驱动（agent 轮次结束/收藏变更/切回标签页）
 * 才会真去拉——没人在看收藏时拉它是白花流量。0 个消费者时一次请求都不发。
 */
export function retainFavorites(): () => void {
    active += 1
    refreshFavorites()
    return () => { active = Math.max(0, active - 1) }
}

// 全局监听在**模块加载时**挂一次（本模块被详情页/个人中心任一引用即生效）：
// 事件可能在任何时刻到达（用户在看公告页时看板娘改了收藏），挂载点不该由"这一刻谁在
// 显示收藏"决定——要不要真去拉，由 refreshFavorites 里的 active 判据决定。
if (typeof window !== 'undefined') {
    window.addEventListener(FAVORITES_CHANGED_EVENT, () => { refreshFavorites() })
    window.addEventListener(AGENT_TURN_DONE_EVENT, () => { refreshFavorites() })
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshFavorites()
    })
}

/** 某篇是否已收藏（本地写入的结果优先——见头注 overrides） */
export function hasFavorite(id: number | string | null | undefined): boolean {
    if (id === null || id === undefined || id === '') return false
    const k = key(id)
    const local = overrides.get(k)
    if (local !== undefined) return local
    return (list || []).some((f) => key(f.noteId) === k)
}

/**
 * 写侧**成功之后**调用：立刻把这次写入的结果落到本地，再拉一次全量对齐。
 * `faved` 是写入后的真实状态（不是"翻转一下"——并发两次点击时翻转会算错）。
 */
export function applyLocalFavorite(noteId: number, faved: boolean): void {
    overrides.set(key(noteId), faved)
    if (list && !faved) {
        // 取消收藏：手里就有那一行，直接摘掉（列表当场对得上，不用等一个往返）。
        // 新增则**不塞行**——这里拿不到 title/createdAt，塞一行空的会在个人中心列表里
        // 显示成一条没有标题的记录；交给随后那次全量拉取补上。
        list = list.filter((f) => key(f.noteId) !== key(noteId))
    }
    // 在途的那份读数可能是**写入之前**的快照（进页面即拉、用户趁没回来就点收藏）⇒
    // 作废它（代次 +1）并允许立刻发一份新的，否则它会拿旧 list 把刚点掉的那颗★又点亮。
    seq += 1
    inflight = null
    emit()
    refreshFavorites()
}

/**
 * 拉一次全量（并发去重 + 未登录即清空 + 丢弃过期读数）。
 * 返回的 promise 在两个调用点都被 await/忽略，语义是"这次对齐结束"。
 */
export function refreshFavorites(): Promise<void> {
    if (typeof window === 'undefined' || !active) return Promise.resolve()
    if (!getToken()) {
        if (list !== null || overrides.size || failed) {
            list = null
            overrides.clear()
            failed = false
            emit()
        }
        return Promise.resolve()
    }
    if (inflight) return inflight
    const mine = ++seq
    const p: Promise<void> = getFavorites()
        .then((res) => {
            // 期间有过本地写入（或更新的请求）⇒ 这份读数是旧快照，丢掉
            if (mine !== seq) return
            if (ok(res)) {
                // **每次成功读数都换一个新数组实例**（不是 `res.data.data` 原样存）。
                // 不拷贝的话，读接口只要把同一个数组交回来（缓存、桩、或调用方就地 push），
                // 新快照与旧快照 `Object.is` 相等 ⇒ 订阅者的 setSnap 被 React 判为无变化而
                // **静默不重渲染**——界面停在旧条数上，而 store 里其实已经是新的了。
                // 本仓 20260923 的无头沙箱就是这么抓到的（假后端返回同一个 `state.favorites`）。
                list = [...(res.data.data || [])]
                overrides = new Map()   // 全量读数到手，本地判断功成身退
                failed = false
            } else {
                // 失败：保留上一次的 list（见头注——清空是在说谎），但记住这次没读到
                failed = true
            }
            emit()
        })
        .catch(() => {
            if (mine !== seq) return
            failed = true
            emit()
        })
        .finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
}

/**
 * 订阅收藏状态。
 * @param enabled 该显示位置现在是否真的要看收藏（未登录 / 窗没开 / 这一页不显示收藏 → false）。
 *                至少一个订阅者是 true 时才会发请求。
 */
export function useFavorites(enabled: boolean): {
    list: FavoriteItem[] | null
    failed: boolean
    has: (id: number | string | null | undefined) => boolean
    refresh: () => void
} {
    const [snap, setSnap] = useState<FavoriteItem[] | null>(() => list)
    const [bad, setBad] = useState<boolean>(() => failed)

    useEffect(() => subscribe(() => { setSnap(list); setBad(failed) }), [])

    useEffect(() => {
        if (!enabled) return
        return retainFavorites()
    }, [enabled])

    return {
        list: snap,
        failed: bad,
        has: useCallback((id: number | string | null | undefined) => hasFavorite(id), []),
        refresh: useCallback(() => { refreshFavorites() }, []),
    }
}

/** 供测试与排障：当前 store 的快照（`active` = 有几个消费者在看；0 时一次请求都不发） */
export function favoritesDebug(): { list: FavoriteItem[] | null; failed: boolean; active: number } {
    return { list, failed, active }
}
