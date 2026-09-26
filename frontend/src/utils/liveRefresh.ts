/**
 * 「这份列表该重拉一次了」的通用触发器（20260926，用户报「评论状态变更前端跟不上 agent」）。
 *
 * 现场：后台开着评论管理页，让看板娘驳回一条留言 —— **页面不动**，得手动刷新才看得到。
 * 同族的毛病散在好几个页面（用户列表、文章/标签/分类、前台河灯），成因是同一个：
 * 这些列表都在**挂载时拉一次**，之后只有它自己那次操作会改本地状态；agent 从服务端改的
 * 那一笔，浏览器没有任何理由知道。
 *
 * ── 为什么不上 SSE / WebSocket（用户已拍板）──────────────────────────────
 * 要的是 15–30 秒级的「我刚从那边改完，这边别还旧着」，**不是推送**。SSE 通道本身是通的
 * （nginx 反代 + `X-Accel-Buffering: no`，对话流就在用），但要为它加一条 Rust 端点、一套
 * 连接与广播管理、逐页的订阅器；WS 还得动 nginx 的 Upgrade 头。代价与收益不成比例：
 * 事件 + 可见性 + 轻轮询已经覆盖了全部真实场景（"我自己改的"由 `agent-turn-done` 兜、
 * "别人/另一个端改的"由轮询兜）。访客页面**零轮询**（`poll: false`），成本关在后台。
 *
 * ── 触发时机（四条，少一条就会"某个方向不灵"）────────────────────────────
 *   1. `agent-turn-done`（`components/UserCenter/agentTurn.ts` 的常量）：看板娘一轮收尾
 *      —— agent 可能刚写过服务端的账，这是**最**要紧的一条；
 *   2. `visibilitychange` 变可见：后台标签页里定时器被浏览器降频，切回来必须补一次；
 *   3. `focus`：可见性与焦点不是一回事（同屏两个窗口都"可见"，但只有一个有焦点）；
 *   4. 轮询（默认 20 秒，**只在页面可见时跑**）：兜住"另一个端/另一个人改的"。
 *
 * ── 四条纪律（每条都对应一个踩过或几乎踩到的坑）──────────────────────────
 *   · **挂载时不拉**：调用方的挂载期加载已经是一次了，这里再拉一次就是把每个后台页面
 *     的初始请求翻倍。本 hook 只管"挂载之后发生的变化"。
 *   · **在途去重**（`inflight`）：一次事件与一次轮询挨在一起时，不叠加成两个请求。
 *   · **节流窗口**（`MIN_GAP_MS`，事件与轮询**共用**）：`agent-turn-done` + `focus` +
 *     `visibilitychange` 常常在同一毫秒里到齐，不设窗口就是三个请求。
 *   · **`skip()` 优先于一切**：本地有未落库的改动、或弹窗正开着在编辑 ⇒ 这一轮**不拉**
 *     ——**绝不覆盖主人正在编辑的东西**。这与后台首页待办卡那条 `pendingReload` 是同一个
 *     道理，只是这里的合并判据由页面自己给（通用 hook 不知道你的表单长什么样）。
 *
 * 消费者计数与定时器生命周期照 `components/UserCenter/unread.ts` 那一族：**第一个**要看
 * 的页面出现时挂上全站唯一那个定时器，**最后一个**离开时撤掉（没人在看的页面为什么要
 * 轮询）。与那个 store 的差别：那边多个显示位置共享**同一份事实**、所以是单例 store；
 * 这边每个页面各有各的数据，共享的只有"什么时候该醒来"。
 */
import { useEffect, useRef } from 'react'
import { AGENT_TURN_DONE_EVENT } from '../components/UserCenter/agentTurn.ts'

/** 默认轮询间隔：个人博客 + 后台自己用，20 秒足够"别还旧着"，也不至于把后台打成心跳 */
export const DEFAULT_POLL_MS = 20 * 1000
/** 事件与轮询共用的最小间隔（同一毫秒里到的三个事件只该变成一次拉取） */
export const MIN_GAP_MS = 2000

export type LiveRefreshOptions = {
    /** 轮询间隔（毫秒）。全站只认**第一个**带轮询的消费者给的值，见 `syncTimer`。 */
    pollMs?: number
    /** 要不要轮询（默认要）。访客页面传 `false`：不为我自己的编辑给访客加流量。 */
    poll?: boolean
    /** 此刻能不能拉（返回 true = **这次别拉**）。本地有未落库的改动 / 弹窗开着正在编辑。 */
    skip?: () => boolean
}

type Consumer = { fire: () => void; poll: boolean }

/** 挂载中的消费者（每个 = 一个用了本 hook 的页面组件） */
const consumers = new Set<Consumer>()
/** 全站唯一那个轮询定时器（第一个带轮询的消费者出现时挂、最后一个离开时撤） */
let timer: ReturnType<typeof setInterval> | null = null
/** 当前生效的轮询间隔（由第一个带轮询的消费者决定；它走了就回到默认值） */
let pollMs = DEFAULT_POLL_MS

function visible(): boolean {
    return typeof document === 'undefined' || !document.hidden
}

/** 叫醒所有（或是"要轮询的那部分"）消费者。**每个 fire 自己判 skip/节流/在途**。 */
function fanout(pollersOnly: boolean): void {
    consumers.forEach((c) => {
        if (pollersOnly && !c.poll) return
        try {
            c.fire()
        } catch (e) { /* 一个消费者抛错不该拖垮其余（与 unread.ts 的 emit 同一条） */
        }
    })
}

/** 定时器跟着"还要不要轮询"走（consumers 变了就调一次） */
function syncTimer(): void {
    const want = Array.from(consumers).some((c) => c.poll)
    if (want && timer === null) {
        timer = setInterval(() => {
            // 后台标签页里定时器照跑，但没必要拉；切回可见时 visibilitychange 会补一次
            if (visible()) fanout(true)
        }, pollMs)
    } else if (!want && timer !== null) {
        clearInterval(timer)
        timer = null
        pollMs = DEFAULT_POLL_MS
    }
}

// 全局监听在**模块加载时**挂一次（任一页面引用本模块即生效，同 unread.ts）：
// 事件可能在任意时刻到达，挂载点不该由"这一刻谁在看列表"决定；真要拉不拉由
// consumers 是否为空决定（空集时 fanout 什么都不做）。
if (typeof window !== 'undefined') {
    window.addEventListener(AGENT_TURN_DONE_EVENT, () => { fanout(false) })
    window.addEventListener('focus', () => { fanout(false) })
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) fanout(false)
    })
}

/**
 * 登记一个消费者：`reload` 是调用方"重拉这一份列表"的函数（返回 promise 就等它，
 * 期间不叠加第二次）。返回注销函数——**组件卸载必须调**（否则这条记录的定时器留着、
 * 而它的 setState 落在已经卸载的组件上）。
 *
 * 测试与排障可以直接用这个（不必造 React 环境）：`tests/live-refresh.test.mjs` 就是
 * 直接驱动它来锁下面四条纪律的。
 */
export function retainLive(
    reload: () => void | Promise<void>,
    opts: LiveRefreshOptions = {},
): () => void {
    let last = 0
    let inflight = false
    let alive = true

    const fire = (): void => {
        if (!alive || inflight) return
        // skip 在**节流之前**判：这一轮不拉就等于这件事没发生过，不该吃掉节流窗口
        // 而让"弹窗关掉之后"的那一次也跟着被吞（那会让关窗后还得再等一个窗口）。
        if (opts.skip && opts.skip()) return
        const now = Date.now()
        if (now - last < MIN_GAP_MS) return
        last = now
        const out = reload()
        // 只有真返回 promise 才占用在途位：同步 reload（就地 setState）没有"在途"可言
        if (out && typeof (out as Promise<void>).then === 'function') {
            inflight = true
            Promise.resolve(out)
                .catch(() => { /* 拉取失败由页面自己提示，这里只负责放开在途位 */ })
                .then(() => { inflight = false })
        }
    }

    const c: Consumer = { fire, poll: opts.poll !== false }
    // 间隔由**第一个带轮询的**消费者决定（先来的若是访客页面那种 poll:false，
    // 不该把它的默认值当既成事实）
    if (c.poll && opts.pollMs && !Array.from(consumers).some((x) => x.poll)) {
        pollMs = opts.pollMs
    }
    consumers.add(c)
    syncTimer()

    return () => {
        alive = false
        consumers.delete(c)
        syncTimer()
    }
}

/**
 * 页面侧入口。`reload` 每轮渲染都是新的闭包，但订阅只建立一次 ⇒ 用 ref 转发
 * （`opts` 同理：依赖数组只收原始值，避免调用方每轮传字面量把订阅拆了重建）。
 */
export function useLiveRefresh(
    reload: () => void | Promise<void>,
    opts: LiveRefreshOptions = {},
): void {
    const reloadRef = useRef(reload)
    reloadRef.current = reload
    const skipRef = useRef(opts.skip)
    skipRef.current = opts.skip
    const { pollMs: ms, poll } = opts
    useEffect(() => retainLive(() => reloadRef.current(), {
        pollMs: ms,
        poll,
        skip: () => (skipRef.current ? skipRef.current() : false),
    }), [ms, poll])
}

/** 供测试与排障：此刻几个消费者、定时器在不在、间隔多少 */
export function liveRefreshDebug(): { consumers: number; polling: boolean; pollMs: number } {
    return { consumers: consumers.size, polling: timer !== null, pollMs }
}
