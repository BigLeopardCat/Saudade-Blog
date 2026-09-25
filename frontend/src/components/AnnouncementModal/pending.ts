/**
 * 「此刻该不该弹公告」的唯一判据 + 已读落在哪里 + 什么时候复查（20260926）。
 *
 * ── 为什么从 localStorage 水位搬到服务端 ──────────────────────────────────
 * 旧实现把"看过哪条公告"记在 `localStorage['announcement_seen_id']`（关窗时写最大 id）。
 * 那是**按浏览器**记的：换一台机器、换个浏览器、清一次缓存，同一批公告又弹一遍；
 * 反过来，用户在个人中心里把公告标成已读，弹窗并不知道，照样在首页弹。同一件事
 * （这条公告这个人看过没有）散成了两份互不通气的账。
 *
 * 现在：**登录用户读服务端的 `user_notification` 行**——公告在发布时按用户逐行展开
 * （src/routes/announcements.rs 的 fan_out），行上有 `type='announcement'`、`isRead`，
 * 个人中心的通知面板读的是同一批行、红点（`notifications/summary`）也是同一批行。
 * 于是"弹过的公告"与"红点里的未读公告"**是同一件事的两种显示**，不会再打架。
 * 关窗 = 把那行标已读（`POST /api/protected/notifications/read`）⇒ 红点当场跟着掉。
 *
 * 游客（没有 token）没有账号可挂，只能继续用本机水位 `announcement_seen_id`
 * （键名沿用，老访客的水位照旧生效、不会因为这次改动重弹一遍）。这是**有意保留的
 * 边界**，不是遗漏：游客在服务端根本没有身份。
 *
 * ── 弹哪一条：只弹"最新的那条公告"，且它未被读过 ──────────────────────────
 * 判据是 `type==='announcement'` 的**第一行**（列表按 createdAt desc 给），再看它的
 * `isRead`——不是"找第一条未读的公告"。两者的差别在多条未读时：
 *   · 「第一条未读」会一条接一条地弹（关掉 #5 再弹 #4、#3…），这正是用户受不了的形态；
 *   · 「最新那条未被读过才弹」与旧水位语义完全一致（水位 = 见过的最大 id ⇒ 更旧的
 *     永不弹），而且**不把更旧的标成已读**：它们照旧在个人中心里是未读，红点照旧亮着，
 *     只是不再用弹窗打扰。关窗只标**弹过的那一行**就够了——它一变成已读，"最新那条
 *     未被读过"这个条件对更旧的那些就不再成立。
 * 编辑公告不产生新行（update_announcement 只同步标题正文），所以**改过的公告不会重弹**；
 * 没读过的人看到的仍是改后的正文（同步过）——改前改后都对。
 *
 * ── 什么时候复查（"只有刷新才弹"的那个毛病）────────────────────────────
 * `watchAnnouncements` 把触发源收在一处：挂载即查、标签页切回可见、`agent-turn-done`
 * （看板娘刚可能发过公告／标过已读）、`unread-change`（用户刚在个人中心点了全部已读）、
 * `announcement-published`（后台公告管理页刚发/改/删，见 Dashboard/Announcement）、
 * 以及**可见时每 60 秒一次**（跨浏览器/跨设备唯一能靠的就是这条：本站没有全站推送通道，
 * 60 秒是既有未读轮询的同一档节奏）。代价是每个开着的标签页每分钟一个小 GET，
 * 与 unread.ts 的轮询同量级。
 *
 * ── 读不到 ≠ 没有 ──────────────────────────────────────────────────────
 * 通知接口失败时**不弹**（返回 null）。这与 unread.ts 的"读失败保留上一次读数"不同：
 * 红点那边保的是**已经显示过的读数**，而这里失败时既不知道有没有新公告、也不知道
 * 这个人读过没有——此时弹出来就是把"读不到"演成"你没读过"（旧实现的换浏览器重弹
 * 正是这个后果）。宁可晚一步（下一次复查或切回标签页），也不误弹。
 */
import getToken from '../../apis/getToken.tsx'
import { getAnnouncements } from '../../apis/AnnouncementMethods.tsx'
import { getNotifications, readNotifications, ok } from '../../apis/ProfileMethods.tsx'
import { AGENT_TURN_DONE_EVENT } from '../UserCenter/agentTurn.ts'
import { UNREAD_CHANGED_EVENT, notifyUnreadChanged } from '../UserCenter/unread.ts'

/** 游客的已读水位键（按本机记，只服务没有账号的人；键名沿用 20260925 之前的那个） */
export const ANNOUNCEMENT_SEEN_KEY = 'announcement_seen_id'
/** 后台公告管理页发布/编辑/删除成功后派发：同浏览器当场复查，不必等下一拍轮询 */
export const ANNOUNCEMENT_PUBLISHED_EVENT = 'announcement-published'
/** 跨标签页复查节奏（与 unread.ts 的未读轮询同一档；隐藏时跳过，切回时补一次） */
export const ANNOUNCEMENT_RECHECK_MS = 60 * 1000

/** 公开公告接口的单行（`GET /api/public/announcements`，见 src/routes/announcements.rs 的
 * `AnnouncementDto`：id/title/content/createdAt/updatedAt 都是字符串形态的钟面时间）。 */
interface AnnouncementRow {
    id: number
    title: string
    content: string
    createdAt?: string
    updatedAt?: string
}

export interface PendingAnnouncement {
    /** 已读落点：服务端 = 通知行 id（POST read 用），游客 = 公告 id（写水位用） */
    id: number
    /** 已读记在哪：'server' 按账号、'local' 按本机（游客） */
    source: 'server' | 'local'
    title: string
    content: string
    /** 展示用时间串（后端已是 +08:00 钟面，见 index.tsx 的 fmtCnTime） */
    time: string
}

/** 发布/编辑/删除公告成功后调用：让弹窗当场复查（调用方不用知道弹窗在哪一页） */
export function notifyAnnouncementPublished(): void {
    try {
        window.dispatchEvent(new CustomEvent(ANNOUNCEMENT_PUBLISHED_EVENT))
    } catch (e) { /* ignore */ }
}

function readSeenId(): number {
    try { return parseInt(localStorage.getItem(ANNOUNCEMENT_SEEN_KEY) || '0', 10) || 0 } catch (e) { return 0 }
}

/** 拉一次"此刻该弹的那条公告"；没有 → null（未登录走本机水位，见文件头） */
export async function fetchPendingAnnouncement(): Promise<PendingAnnouncement | null> {
    if (getToken()) {
        const res = await getNotifications()
        if (!ok(res)) return null            // 读不到 ≠ 没有（见文件头，不弹）
        const items = res.data?.data?.items ?? []
        const newest = items.find((n) => n.type === 'announcement')
        if (!newest || newest.isRead) return null
        return {
            id: newest.id,
            source: 'server',
            title: newest.title,
            content: newest.content,
            time: newest.createdAt,
        }
    }
    const res = await getAnnouncements()
    if (!(res?.status === 200 && res?.data?.code === 200)) return null
    const list = (res.data.data ?? []) as AnnouncementRow[]
    const latest = list[0]                    // 后端按 id 倒序（list_announcements）
    if (!latest || !(latest.id > readSeenId())) return null
    return {
        id: latest.id,
        source: 'local',
        title: latest.title,
        content: latest.content,
        // 有编辑时间就显示编辑时间（旧实现同款）；通知行那条只有发布时间，见文件头
        time: latest.updatedAt || latest.createdAt || '',
    }
}

/**
 * 记这条公告已读（关窗时调用，弹窗出现时**不**记——出现即标记等于替用户读了）。
 * 服务端那条走既有接口，顺带派发 `unread-change`：红点当场重算，不必等下一次轮询
 * （用户刚在弹窗上点掉一条公告，红点却还挂着那一分，就成了"点了没生效"）。
 */
export async function markAnnouncementRead(p: PendingAnnouncement): Promise<void> {
    if (p.source === 'local') {
        try { localStorage.setItem(ANNOUNCEMENT_SEEN_KEY, String(p.id)) } catch (e) { /* ignore */ }
        return
    }
    try {
        const res = await readNotifications({ ids: [p.id] })
        if (ok(res)) notifyUnreadChanged()
    } catch (e) { /* 记不上就地留着：下次复查还会弹一次，比静默丢掉强 */ }
}

/**
 * 登记复查：返回解除登记的函数（组件卸载时调，定时器一并撤掉）。
 * **同一位置只挂一个**——`check` 的重入由调用方按"弹窗已经开着"挡住（见 index.tsx）。
 */
export function watchAnnouncements(check: () => void): () => void {
    const onVisible = () => { if (!document.hidden) check() }
    const timer = setInterval(() => { if (!document.hidden) check() }, ANNOUNCEMENT_RECHECK_MS)
    window.addEventListener(AGENT_TURN_DONE_EVENT, check)
    window.addEventListener(UNREAD_CHANGED_EVENT, check)
    window.addEventListener(ANNOUNCEMENT_PUBLISHED_EVENT, check)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
        clearInterval(timer)
        window.removeEventListener(AGENT_TURN_DONE_EVENT, check)
        window.removeEventListener(UNREAD_CHANGED_EVENT, check)
        window.removeEventListener(ANNOUNCEMENT_PUBLISHED_EVENT, check)
        document.removeEventListener('visibilitychange', onVisible)
    }
}
