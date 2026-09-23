/**
 * 头像红点的未读数（20260922 个人中心一期）。
 *
 * 红点 = **未读通知（含公告）+ 未读站内信**，唯一数据源是
 * `GET /api/protected/notifications/summary`（后端一次算全，前端不并发几次）。
 *
 * 刷新时机（四个都要有，少一个就会"点了已读红点还在"或"别人发来消息十分钟不亮"）：
 *   1. 挂载 + 定时轮询（60 秒——本站是个人博客，没必要做长连接）；
 *   2. `unread-change` 自定义事件（个人中心里点"全部已读"当场归零，不等下一次轮询）；
 *   3. `visibilitychange`（标签页切回来时补一次——后台标签页里定时器会被浏览器降频）；
 *   4. `agent-turn-done`（20260924 补）：看板娘那边刚把通知/站内信标成已读 ⇒ 当场重算。
 *      **只靠 60 秒轮询是不够的**：用户让 agent 标已读之后盯着红点看，一分钟不变就等于
 *      "没生效"（实测反馈：要刷新网页才掉）——红点是提示，提示晚一分钟没有意义。
 *
 * 未登录 / 请求失败一律**按 0 处理**：红点是提示不是状态，拿不到数据时宁可不显示，
 * 也不编一个数字（后端那族接口在无 token 时返回 HTTP 200 + code=500，所以这里既看
 * HTTP 状态也看 code）。
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

export function useUnread(enabled: boolean): { counts: UnreadSummary; refresh: () => void } {
    const [counts, setCounts] = useState<UnreadSummary>({ notifications: 0, messages: 0, total: 0 })

    const refresh = useCallback(() => {
        if (!enabled || !getToken()) {
            setCounts({ notifications: 0, messages: 0, total: 0 })
            return
        }
        getUnreadSummary()
            .then((res) => {
                if (ok(res)) {
                    const d = res.data.data
                    setCounts({
                        notifications: d?.notifications ?? 0,
                        messages: d?.messages ?? 0,
                        total: d?.total ?? 0,
                    })
                } else {
                    // 未登录/失败：不显示红点，也不清空成 0 后再也不刷新（下次轮询还会再试）
                    setCounts({ notifications: 0, messages: 0, total: 0 })
                }
            })
            .catch(() => setCounts({ notifications: 0, messages: 0, total: 0 }))
    }, [enabled])

    useEffect(() => {
        if (!enabled) {
            setCounts({ notifications: 0, messages: 0, total: 0 })
            return
        }
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        const onVis = () => { if (!document.hidden) refresh() }
        window.addEventListener(UNREAD_CHANGED_EVENT, refresh)
        window.addEventListener(AGENT_TURN_DONE_EVENT, refresh)
        document.addEventListener('visibilitychange', onVis)
        return () => {
            clearInterval(timer)
            window.removeEventListener(UNREAD_CHANGED_EVENT, refresh)
            window.removeEventListener(AGENT_TURN_DONE_EVENT, refresh)
            document.removeEventListener('visibilitychange', onVis)
        }
    }, [enabled, refresh])

    return { counts, refresh }
}
