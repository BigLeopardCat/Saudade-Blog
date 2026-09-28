/**
 * 头像红点的未读数（20260922 个人中心一期；20260924 四轮改成模块级单例）。
 *
 * 红点 = **未读通知（含公告）+ 未读站内信**，唯一数据源是
 * `GET /api/protected/notifications/summary`（后端一次算全，前端不并发几次）。
 * 20260924 四轮起这条接口还带 `pendingReview`（等人工裁决的留言条数，非管理员恒 0），
 * 供后台首页那行提示用——它**不计进 `total`**（红点是"你有事没看"，待审是"后台有事等你
 * 处理"，两件事），只是同一个消费者的另一项读数：后台那一页也登记成这个 store 的消费者。
 * 20260929 起再加 `pendingQuota`（等处理的额度重置申请条数），与 pendingReview 逐条同构：
 * 同一个 `is_console_user` 才算、不计进 `total`、后台首页另起一行提示。
 *
 * 刷新时机（四个都要有，少一个就会"点了已读红点还在"或"别人发来消息十分钟不亮"）：
 *   1. 有人开始看时挂上定时轮询（60 秒——本站是个人博客，没必要做长连接）；
 *   2. `unread-change` 自定义事件（个人中心里点"全部已读"当场归零，不等下一次轮询）；
 *   3. `visibilitychange`（标签页切回来时补一次——后台标签页里定时器会被浏览器降频）；
 *   4. `agent-turn-done`（20260924 补）：看板娘那边刚把通知/站内信标成已读 ⇒ 当场重算。
 *      **只靠 60 秒轮询是不够的**：用户让 agent 标已读之后盯着红点看，一分钟不变就等于
 *      "没生效"（实测反馈：要刷新网页才掉）——红点是提示，提示晚一分钟没有意义。
 *
 * 未登录**按 0 处理**（红点是提示不是状态，拿不到账号时宁可不显示，也不编一个数字）；
 * 但**读失败保留上一次的读数**——"读不到"与"确实没有"是两件事，见 `refreshUnread`。
 * 后端那族接口在没做成时返回 HTTP 200 + code=500，所以这里既看 HTTP 状态也看 code。
 *
 * ── 为什么是**单例 store**（20260924 四轮，与 favorites.ts 同一套形态）──
 * 此前 `useUnread` 是普通 hook：每个调用点各持一份 `useState` + 各挂一个 `setInterval`。
 * 而红点有**两处**显示位置——头部头像（常驻）与个人中心页签角标（开窗时）——
 * 于是开着个人中心时，同一张表每分钟被同一个浏览器打两次（实测：站内真轮询只有两条
 * 接口，一天约 1300 次请求，99.4% 来自主人自己那一个 IP）。这不是"多花点流量"的问题，
 * 而是同一份事实有两个各自计时的副本：一处先拿到新值、另一处还停在旧值，红点自己跟
 * 自己不一致。
 * 现在：**未读数只有一份**（本模块的 `snap`），谁要显示就来订阅；`setInterval` 只在
 * **第一个消费者**出现时挂、**最后一个**离开时撤（`active` 计数）；事件驱动的刷新也只在
 * 真的有人在看时才发（`refreshUnread` 里的 active 判据），在途请求去重（`inflight`）。
 * 想知道此刻有几个消费者：`unreadDebug()`（测试与排障用）。
 */
import { useCallback, useEffect, useState } from 'react'
import getToken from '../../apis/getToken.tsx'
import { getUnreadSummary, ok } from '../../apis/ProfileMethods.tsx'
import type { UnreadSummary } from '../../interface/ProfileType'
import { AGENT_TURN_DONE_EVENT } from './agentTurn.ts'

export const UNREAD_CHANGED_EVENT = 'unread-change'

/** 通知/私信已读状态变了 → 让红点立刻重算（调用方不用知道红点在哪） */
export function notifyUnreadChanged(): void {
    try {
        window.dispatchEvent(new CustomEvent(UNREAD_CHANGED_EVENT))
    } catch (e) { /* ignore */ }
}

const POLL_MS = 60 * 1000

/**
 * 空读数。**同一个实例复用**（不是每次新造一个字面量）：订阅者拿它进 `useEffect`
 * 依赖或 `setState` 时，新实例会被 React 判为"变了"而多渲染一轮（favorites.ts 里
 * 那条"每次成功读数都换新数组"的教训反过来用——这里没有新事实就不该换引用）。
 */
const EMPTY: UnreadSummary = {
    notifications: 0,
    messages: 0,
    total: 0,
    pendingReview: 0,
    // 20260929 加额度申请数。**EMPTY 漏一个键不会报错、只会让 `same()` 拿 undefined
    // 比 undefined**（恒等）⇒ 那一项的变化永远看不见。三个地方必须同进同出：
    // EMPTY / same / pick。
    pendingQuota: 0,
}

/** 值相等？就比这几个数，不引深比较库。
 *  **每加一个读数都必须在这里加一项**：漏了不会红，症状是"那个数变了但界面不动"——
 *  额度申请正是这样：`pendingQuota` 从 0 变 1 时若被判"没变"，后台首页那行提示与红点
 *  永远不会冒出来，而且没有任何报错。前端 `unread-sync.test.mjs` 有一条专门断言
 *  "两份只有 pendingQuota 不同的 summary 必须判不同并 emit"。 */
function same(a: UnreadSummary, b: UnreadSummary): boolean {
    return a.notifications === b.notifications && a.messages === b.messages
        && a.total === b.total && a.pendingReview === b.pendingReview
        && a.pendingQuota === b.pendingQuota
}

/** 当前未读数（NULL 语义的替代品是 EMPTY：红点是提示，读不到就不显示）。 */
let snap: UnreadSummary = EMPTY
/** 活着的消费者数：0 时既不轮询也不发请求（没人在看红点，拉它干嘛） */
let active = 0
/** 全站**唯一**那个轮询定时器（active 从 0 起时挂、回到 0 时撤） */
let timer: ReturnType<typeof setInterval> | null = null
/** 去重：同一时刻只发一次 GET（头部与个人中心可能同时要） */
let inflight: Promise<void> | null = null
const subs = new Set<() => void>()

function emit(): void {
    subs.forEach((fn) => { try { fn() } catch (e) { /* 一个订阅者抛错不该拖垮其余 */ } })
}

/** 订阅本 store（组件不要直接调，走 useUnread） */
function subscribe(fn: () => void): () => void {
    subs.add(fn)
    return () => { subs.delete(fn) }
}

/**
 * 换快照：**值没变就不换引用、不发通知**。
 * 轮询每 60 秒醒一次，绝大多数时候读到的还是同样的三个数——照单换一个新对象会让每个
 * 订阅者白渲染一轮（`useUnread` 的订阅者把快照写进 state，新引用 = React 判"变了"）。
 * 值相等却当作"新事实"是假的新事实，与 favorites.ts 那条"每次成功读数都换新数组"看似
 * 矛盾、其实相反：那边的隐患是**同一个引用**被当成没变（缓存/桩把同一个数组交回来），
 * 这边的隐患是**内容相同的新引用**被当成变了——两边防的都是"React 的引用相等判据"这一个东西。
 */
function setSnap(next: UnreadSummary): void {
    if (same(next, snap)) return
    snap = next
    emit()
}

/** 从回包取出各个计数（缺字段按 0——不编数字，也不把缺字段当失败） */
function pick(d: UnreadSummary | null | undefined): UnreadSummary {
    return {
        notifications: d?.notifications ?? 0,
        messages: d?.messages ?? 0,
        total: d?.total ?? 0,
        // 旧后端（20260924 四轮之前的回包）没有这个字段 ⇒ 0，界面那一行不画
        pendingReview: d?.pendingReview ?? 0,
        // 同 pendingReview 的旧后端容忍（20260929）
        pendingQuota: d?.pendingQuota ?? 0,
    }
}

// 全局监听在**模块加载时**挂一次（头部/个人中心任一引用本模块即生效）：事件可能在任何
// 时刻到达（用户在看公告页时看板娘把通知标成已读），挂载点不该由"这一刻谁在显示红点"
// 决定——要不要真去拉，由 refreshUnread 里的 active 判据决定。
if (typeof window !== 'undefined') {
    window.addEventListener(UNREAD_CHANGED_EVENT, () => { refreshUnread() })
    window.addEventListener(AGENT_TURN_DONE_EVENT, () => { refreshUnread() })
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshUnread()
    })
}

/**
 * 登记一个"此刻真的在看红点"的消费者（`useUnread(enabled)` 生效时调用），返回取消登记
 * 的函数。**第一个**登记时挂上全站唯一的轮询定时器，**最后一个**离开时撤掉。
 */
export function retainUnread(): () => void {
    active += 1
    if (timer === null) timer = setInterval(() => { refreshUnread() }, POLL_MS)
    refreshUnread()
    return () => {
        active = Math.max(0, active - 1)
        if (active === 0 && timer !== null) {
            clearInterval(timer)
            timer = null
        }
    }
}

/**
 * 拉一次未读汇总（并发去重 + 未登录即清空）。
 *
 * **读失败不改动读数**（保留上一次的），理由与 favorites.ts 那条"拉取失败不清空已有的
 * list"是同一条：失败本身并没有改变任何事实，清成 0 是拿"读不到"冒充"没有"。
 * 对红点：通知没被读掉，红点凭什么灭。对后台那行待审提示更要紧——一次网络抖动就让
 * "3 条待审"变成"没有待审"，是把读失败演成了审完了。
 * （这与 `tools/base.py` 的 `unavailable` 纪律同源：服务不可用不是事实。）
 * 未登录是**事实**不是失败 ⇒ 清空（红点不该在退登之后还亮着）。
 */
export function refreshUnread(): Promise<void> {
    if (typeof window === 'undefined' || !active) return Promise.resolve()
    if (!getToken()) {
        setSnap(EMPTY)
        return Promise.resolve()
    }
    if (inflight) return inflight
    const p: Promise<void> = getUnreadSummary()
        .then((res) => { if (ok(res)) setSnap(pick(res.data.data)) })
        .catch(() => { /* 见上：失败不动读数 */ })
        .finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
}

/**
 * 订阅未读数。
 * @param enabled 该显示位置现在是否真的要看红点（未登录 / 窗没开 / 这一页不显示红点 → false）。
 *                `false` 时**不登记**（一次请求都不发）且返回 0，与旧的"未登录红点不亮"一致。
 */
export function useUnread(enabled: boolean): { counts: UnreadSummary; refresh: () => void } {
    const [seen, setSeen] = useState<UnreadSummary>(() => snap)

    useEffect(() => subscribe(() => { setSeen(snap) }), [])

    useEffect(() => {
        if (!enabled) return
        return retainUnread()
    }, [enabled])

    return {
        counts: enabled ? seen : EMPTY,
        refresh: useCallback(() => { refreshUnread() }, []),
    }
}

/** 供测试与排障：当前 store 的快照（`active` = 几个消费者在看；`polling` = 定时器在不在） */
export function unreadDebug(): {
    counts: UnreadSummary; active: number; polling: boolean; subscribers: number
} {
    return { counts: snap, active, polling: timer !== null, subscribers: subs.size }
}
