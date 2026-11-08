import {useCallback} from 'react'
import {privateApi, UNREAD_CHANGED_EVENT} from '../../apis/privateApi'
import type {UnreadSummary} from '../../interface/ProfileType'
import {getUidFromToken} from '../../utils/auth'
import {useAuthToken} from '../../utils/useAuthToken'
export {UNREAD_CHANGED_EVENT} from '../../apis/privateApi'

const EMPTY: UnreadSummary = {notifications: 0, messages: 0, total: 0,
    pendingReview: 0, pendingQuota: 0, pendingComments: 0}

export function notifyUnreadChanged(): void {
    window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT))
}

export function useUnread(enabled: boolean) {
    const owner = getUidFromToken(useAuthToken())
    const active = enabled && owner !== null
    const query = privateApi.useUnreadQuery(owner ?? 0, {skip: !active, pollingInterval: 60_000,
        skipPollingIfUnfocused: true, refetchOnMountOrArgChange: true})
    return {
        counts: active ? query.currentData ?? EMPTY : EMPTY,
        refresh: useCallback(() => {if (!query.isUninitialized) void query.refetch()},
            [query.isUninitialized, query.refetch]),
    }
}
