import {useCallback} from 'react'
import {privateApi, currentPrivateOwner} from '../../apis/privateApi'
import type {FavoriteMutation} from '../../apis/ProfileMethods'
import {getUidFromToken} from '../../utils/auth'
import {useAuthToken} from '../../utils/useAuthToken'
import store from '../../store'
export {FAVORITES_CHANGED_EVENT} from '../../apis/privateApi'

/** Apply only a confirmed result belonging to the currently authenticated account. */
export async function applyLocalFavorite(result: FavoriteMutation): Promise<boolean> {
    const owner = currentPrivateOwner()
    if (!owner || result?.ownerUserId !== owner || !Number.isSafeInteger(result.noteId)
        || result.noteId <= 0 || typeof result.isFavorite !== 'boolean') return false
    const arg = {ownerUserId: owner, noteId: result.noteId}
    const stateRead = store.dispatch(privateApi.util.getRunningQueryThunk('favoriteState', arg))
    const listRead = store.dispatch(privateApi.util.getRunningQueryThunk('favorites', owner))
    stateRead?.abort()
    listRead?.abort()
    await Promise.all([stateRead, listRead])
    if (currentPrivateOwner() !== owner) return false
    store.dispatch(privateApi.util.upsertQueryEntries([{endpointName: 'favoriteState', arg,
        value: {ownerUserId: owner, noteId: result.noteId, isFavorite: result.isFavorite}}]))
    if (!result.isFavorite) store.dispatch(privateApi.util.updateQueryData('favorites', owner,
        rows => rows.filter(row => row.noteId !== result.noteId)))
    store.dispatch(privateApi.util.invalidateTags([{type: 'Favorites', id: owner}]))
    // A cancelled first read may not have registered tags yet.
    if (listRead) void listRead.refetch()
    return true
}

export function useFavorites(enabled: boolean) {
    const owner = getUidFromToken(useAuthToken())
    const active = enabled && owner !== null
    const query = privateApi.useFavoritesQuery(owner ?? 0, {skip: !active, refetchOnMountOrArgChange: true})
    return {
        list: active ? query.currentData ?? null : null,
        failed: active && query.isError,
        refresh: useCallback(() => {if (!query.isUninitialized) void query.refetch()},
            [query.isUninitialized, query.refetch]),
    }
}

export function useFavoriteState(noteId: number): boolean {
    const owner = getUidFromToken(useAuthToken())
    const active = owner !== null && Number.isSafeInteger(noteId) && noteId > 0
    const query = privateApi.useFavoriteStateQuery({ownerUserId: owner ?? 0, noteId}, {skip: !active})
    return active && !!query.currentData?.isFavorite
}
