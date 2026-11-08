import {createApi, fakeBaseQuery} from '@reduxjs/toolkit/query/react'
import {getFavorites, getFavoriteState, getUnreadSummary, ok, type Envelope, type FavoriteState} from './ProfileMethods'
import type {FavoriteItem, UnreadSummary} from '../interface/ProfileType'
import {getUidFromToken} from '../utils/auth'
import {getLiveAuthToken} from '../utils/useAuthToken'

export const FAVORITES_CHANGED_EVENT = 'favorites-change'
export const UNREAD_CHANGED_EVENT = 'unread-change'
export type PrivateApiError = {message: string}
export type FavoriteStateArgs = {ownerUserId: number; noteId: number}

export function currentPrivateOwner(): number | null {
    const owner = getUidFromToken(getLiveAuthToken())
    return owner !== null && Number.isSafeInteger(owner) && owner > 0 ? owner : null
}

async function readOwned<T>(owner: number, read: () => Promise<{status: number; data: Envelope<T>}>,
    valid: (value: T) => boolean): Promise<{data: T} | {error: PrivateApiError}> {
    const token = getLiveAuthToken()
    if (!token || currentPrivateOwner() !== owner) return {error: {message: '登录状态已变化'}}
    try {
        const result = await read()
        if (getLiveAuthToken() !== token) return {error: {message: '登录状态已变化'}}
        if (!ok(result) || !valid(result.data.data)) {
            return {error: {message: result.data?.message && result.data.message !== 'ok'
                ? result.data.message : '读取失败，请稍后重试'}}
        }
        return {data: result.data.data}
    } catch {
        return {error: {message: '读取失败，请稍后重试'}}
    }
}

const validFavorites = (rows: FavoriteItem[]) => Array.isArray(rows) && rows.every(row => row
    && Number.isSafeInteger(row.noteId) && row.noteId > 0 && typeof row.title === 'string'
    && typeof row.status === 'string' && typeof row.createdAt === 'string')
const validUnread = (value: UnreadSummary) => !!value && ['notifications', 'messages', 'total',
    'pendingReview', 'pendingQuota', 'pendingComments'].every(key => {
        const count = value[key as keyof UnreadSummary]
        return Number.isSafeInteger(count) && count >= 0
    })

/** Private query keys identify the owner, never the login credential. */
export const privateApi = createApi({
    reducerPath: 'privateApi',
    baseQuery: fakeBaseQuery<PrivateApiError>(),
    tagTypes: ['Favorites', 'FavoriteState', 'Unread'],
    keepUnusedDataFor: 60,
    refetchOnFocus: true,
    refetchOnReconnect: true,
    endpoints: build => ({
        favorites: build.query<FavoriteItem[], number>({
            queryFn: (owner, {signal}) => readOwned(owner, () => getFavorites(signal), validFavorites),
            providesTags: (_data, _error, owner) => [{type: 'Favorites', id: owner}],
        }),
        favoriteState: build.query<FavoriteState, FavoriteStateArgs>({
            queryFn: ({ownerUserId, noteId}, {signal}) => readOwned(ownerUserId,
                () => getFavoriteState(noteId, signal), value => !!value
                    && value.ownerUserId === ownerUserId && value.noteId === noteId
                    && typeof value.isFavorite === 'boolean'),
            providesTags: (_data, _error, arg) => [{type: 'FavoriteState', id: `${arg.ownerUserId}:${arg.noteId}`}],
        }),
        unread: build.query<UnreadSummary, number>({
            queryFn: (owner, {signal}) => readOwned(owner, () => getUnreadSummary(signal), validUnread),
            providesTags: (_data, _error, owner) => [{type: 'Unread', id: owner}],
        }),
    }),
})
