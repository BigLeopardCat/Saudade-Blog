import { useCallback, useEffect, useState } from 'react'
import getToken from '../../../apis/getToken.tsx'
import http from '../../../apis/axios.tsx'
import { AGENT_TURN_DONE_EVENT } from '../../../components/UserCenter/agentTurn.ts'

/** 账号列表变了 → 让所有显示它的地方立刻重算（调用方不用知道谁在看）。 */
export const TEMP_USERS_CHANGED_EVENT = 'temp-users-change'

/** `/api/temp-users` 那一行的形状（**裸数组**，见 `src/routes/temp_user.rs::list_temp_users`）。
 *  字段只列这一页真的用到的；后端**只加字段**，所以这里也允许带未列出的键。 */
export interface TempUser {
    id: number
    username: string
    role: string
    status: number
    chatQuotaUsed: number
    chatQuotaLimit: number
    muted?: boolean
    /** 禁言到期时刻，**原始库值**（`null` = 从未禁言，`9999-12-31 23:59:59` = 永久）。
     *  与 `TempUserInfo::muted_until` 是同一个跨语言契约，显示翻译见 `muteUntilText`。 */
    mutedUntil?: string | null
    [k: string]: unknown
}

/** 账号列表（null = 还没成功读到过）。**同一个引用**只在拉到新数据时被替换。 */
let list: TempUser[] | null = null
/** 上一次拉取是不是失败了。**必须与"读到的是空的"分开**：读不到却显示"暂无账号"
 *  是同一族谎（本仓纪律：读不到 ≠ 空）。 */
let failed = false
/** 去重：同一时刻只发一次 GET（页签挂载时的刷新与 `useLiveRefresh` 的轮询可能同时要） */
let inflight: Promise<void> | null = null
/** 请求代次：只有"最后一次发出"的那份读数才作数（见头注纪律 4） */
let seq = 0
/** 活着的订阅者数：0 时不发请求（没人在看账号列表，拉它干嘛） */
let active = 0
const subs = new Set<() => void>()

function emit(): void {
    subs.forEach((fn) => { try { fn() } catch { /* 一个订阅者抛错不该拖垮其余 */ } })
}

/** 订阅本 store（组件不要直接调，走 useTempUsers） */
function subscribe(fn: () => void): () => void {
    subs.add(fn)
    return () => { subs.delete(fn) }
}

/**
 * 登记一个"此刻真的在看账号列表"的消费者（`useTempUsers(enabled)` 生效时调用），
 * 返回取消登记的函数。**登记期间**才真去拉——0 个消费者时一次请求都不发。
 */
export function retainTempUsers(): () => void {
    active += 1
    refreshTempUsers()
    return () => { active = Math.max(0, active - 1) }
}

// 全局监听在**模块加载时**挂一次：事件可能在任何时刻到达（看板娘那边刚冻了人），
// 挂载点不该由"这一刻谁在显示账号列表"决定——要不要真去拉由 refreshTempUsers 的 active 判据决定。
if (typeof window !== 'undefined') {
    window.addEventListener(TEMP_USERS_CHANGED_EVENT, () => { refreshTempUsers() })
    // 看板娘的 `freeze_account` / 以后的管理写工具改的就是这份数据（同 favorites.ts 那条理由）
    window.addEventListener(AGENT_TURN_DONE_EVENT, () => { refreshTempUsers() })
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshTempUsers()
    })
}

/**
 * 拉一次全量（并发去重 + 未登录即清空 + 丢弃过期读数）。
 *
 * 这个接口回的是**裸数组**（不是 `{code,message,data}` 那层壳）——所以判据是 `res.data`
 * 本身，别顺手写成 `res.data.data`（那会永远拿到 undefined、列表恒空，而 axios 不报错、
 * 页面不红，看起来只是"没有账号"）。
 */
export function refreshTempUsers(): Promise<void> {
    if (typeof window === 'undefined' || !active) return Promise.resolve()
    if (!getToken()) {
        if (list !== null || failed) {
            list = null
            failed = false
            emit()
        }
        return Promise.resolve()
    }
    if (inflight) return inflight
    const mine = ++seq
    const p: Promise<void> = http.get('/api/temp-users')
        .then((res) => {
            // 期间有过本地写入（或更新的请求）⇒ 这份读数是旧快照，丢掉
            if (mine !== seq) return
            // **每次成功读数都换一个新数组实例**（不是 `res.data` 原样存）。不拷贝的话，
            // 读接口只要把同一个数组交回来，新快照与旧快照 `Object.is` 相等 ⇒ 订阅者的
            // setSnap 被 React 判为无变化而**静默不重渲染**（favorites.ts 头注里那条教训同源）。
            if (Array.isArray(res?.data)) {
                list = [...(res.data as TempUser[])]
                failed = false
            } else {
                // 不是数组 = 后端没按契约回（错误信封 / 网关页），**不能当成空列表**
                failed = true
            }
            emit()
        })
        .catch(() => {
            if (mine !== seq) return
            // 失败：保留上一次的 list（见头注纪律 3——清空是在说谎），但记住这次没读到
            failed = true
            emit()
        })
        .finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
}

/**
 * 写操作**成功之后**调用：作废在途读数、通知所有显示位置、立刻重拉。
 *
 * 与 `favorites.ts` 的 `applyLocalFavorite` 不同，这里**不塞本地推测值**：账号行的字段
 * 由后端算（额度上限走 `quota::limit_of`、状态是库里的数字），前端猜一个不如让那次重拉
 * 说话；代价只是这一行晚一个往返才更新，而列表本身**当场就是可见的**（不会空屏）。
 */
export function invalidateTempUsers(): void {
    seq += 1          // 在途的那份读数可能是写入之前的快照 ⇒ 作废它
    inflight = null
    emit()
    window.dispatchEvent(new CustomEvent(TEMP_USERS_CHANGED_EVENT))
    refreshTempUsers()
}

/**
 * 订阅账号列表。
 * @param enabled 该显示位置现在是否真的在看它（不在账号页签 / 未登录 → false）。
 *                至少一个订阅者是 true 时才会发请求。
 */
export function useTempUsers(enabled: boolean): {
    users: TempUser[] | null
    failed: boolean
    refresh: () => void
} {
    const [snap, setSnap] = useState<TempUser[] | null>(() => list)
    const [bad, setBad] = useState<boolean>(() => failed)

    useEffect(() => subscribe(() => { setSnap(list); setBad(failed) }), [])

    useEffect(() => {
        if (!enabled) return
        return retainTempUsers()
    }, [enabled])

    return {
        users: snap,
        failed: bad,
        refresh: useCallback(() => { refreshTempUsers() }, []),
    }
}

/** 供测试与排障：当前 store 的快照（`active` = 有几个消费者在看；0 时一次请求都不发） */
export function tempUsersDebug(): { list: TempUser[] | null; failed: boolean; active: number } {
    return { list, failed, active }
}
