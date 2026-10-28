import getToken from '../../apis/getToken.tsx'
import { getAnnouncements } from '../../apis/AnnouncementMethods.tsx'
import { getPendingAnnouncement, readNotifications, ok } from '../../apis/ProfileMethods.tsx'
import { AGENT_TURN_DONE_EVENT } from '../UserCenter/agentTurn.ts'
import { UNREAD_CHANGED_EVENT, notifyUnreadChanged } from '../UserCenter/unread.ts'

/** Per-account latest-announcement state; guests use a local seen watermark.
 * The server retains removed announcements as a barrier against older popups.
 */
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
    } catch { /* ignore */ }
}

function readSeenId(): number {
    try { return parseInt(localStorage.getItem(ANNOUNCEMENT_SEEN_KEY) || '0', 10) || 0 } catch { return 0 }
}

/** 拉一次"此刻该弹的那条公告"；没有 → null（未登录走本机水位，见文件头） */
export async function fetchPendingAnnouncement(): Promise<PendingAnnouncement | null> {
    if (getToken()) {
        const res = await getPendingAnnouncement()
        if (!ok(res)) return null            // 读不到 ≠ 没有（见文件头，不弹）
        const newest = res.data.data
        if (!newest || !Number.isSafeInteger(newest.id) || newest.id <= 0
            || newest.type !== 'announcement' || newest.isRead !== false
            || typeof newest.title !== 'string' || typeof newest.content !== 'string') return null
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
 * 记这条公告已读（**只在点「我知道了」时**调用——出现即标记等于替用户读了，
 * 从弹窗外关掉也不算读过，见文件头的两个出口）。
 * 服务端那条走既有接口，顺带派发 `unread-change`：红点当场重算，不必等下一次轮询
 * （用户刚在弹窗上点掉一条公告，红点却还挂着那一分，就成了"点了没生效"）。
 */
export async function markAnnouncementRead(p: PendingAnnouncement): Promise<void> {
    if (p.source === 'local') {
        try { localStorage.setItem(ANNOUNCEMENT_SEEN_KEY, String(p.id)) } catch { /* ignore */ }
        return
    }
    try {
        const res = await readNotifications({ ids: [p.id] })
        if (ok(res)) notifyUnreadChanged()
    } catch { /* 记不上就地留着：下次复查还会弹一次，比静默丢掉强 */ }
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
