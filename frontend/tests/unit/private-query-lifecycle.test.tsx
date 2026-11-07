import {act, render, screen, waitFor} from '@testing-library/react'
import {Provider} from 'react-redux'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import store from '../../src/store'
import {privateApi} from '../../src/apis/privateApi'
import {galleryApi} from '../../src/apis/galleryApi'
import {applyLocalFavorite, useFavorites, useFavoriteState} from '../../src/components/UserCenter/favorites'
import {useUnread} from '../../src/components/UserCenter/unread'
import {startAuthExpiry} from '../../src/utils/authSession'
import {deferred} from '../helpers/deferred'
const {http} = vi.hoisted(() => ({http: vi.fn()}))
vi.mock('../../src/apis/axios', () => ({default: http}))

const token = (id: number, signature = 'current', exp = Math.floor(Date.now() / 1000) + 3600) =>
    `header.${btoa(JSON.stringify({sub: id, role: 'user', exp}))}.${signature}`
const login = (id: number, signature = 'current') => {
    localStorage.setItem('tokenKey', token(id, signature))
    window.dispatchEvent(new Event('auth-change'))
}
const envelope = (data: unknown, code = 200) => ({status: 200, data: {code, data}})
const favorite = (noteId: number, title = '文章') => ({noteId, title, status: 'public', createdAt: '2026-01-01'})
const counts = (n = 0) => ({notifications: n, messages: 0, total: n, pendingReview: 0,
    pendingQuota: 0, pendingComments: 0})
const stateArg = (owner = 1) => ({ownerUserId: owner, noteId: 54})
const stateFact = (owner = 1, isFavorite = true) => ({...stateArg(owner), isFavorite})
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve))

function reset() {
    for (const query of store.dispatch(privateApi.util.getRunningQueriesThunk())) query.abort()
    for (const query of store.dispatch(galleryApi.util.getRunningQueriesThunk())) query.abort()
    store.dispatch(privateApi.util.resetApiState())
    store.dispatch(galleryApi.util.resetApiState())
}
beforeEach(() => {reset(); http.mockReset(); login(1)})
afterEach(() => {reset(); localStorage.clear()})

describe('private query identity and framework lifecycle', () => {
    it('deduplicates concurrent subscriptions and keeps the credential out of cache keys', async () => {
        const pending = deferred<ReturnType<typeof envelope>>()
        http.mockReturnValueOnce(pending.promise)
        const first = store.dispatch(privateApi.endpoints.favorites.initiate(1))
        const second = store.dispatch(privateApi.endpoints.favorites.initiate(1))
        expect(http).toHaveBeenCalledTimes(1)
        pending.resolve(envelope([favorite(54)]))
        await Promise.all([first.unwrap(), second.unwrap()])
        expect(privateApi.endpoints.favorites.select(1)(store.getState()).data).toEqual([favorite(54)])
        expect(JSON.stringify(Object.keys(store.getState().privateApi.queries))).not.toContain(localStorage.getItem('tokenKey'))
        first.unsubscribe(); second.unsubscribe()
    })

    it.each([2, 1])('drops all A reads after switching credentials to owner %s, including transports ignoring abort', async owner => {
        const oldList = deferred<ReturnType<typeof envelope>>()
        const oldState = deferred<ReturnType<typeof envelope>>()
        const oldUnread = deferred<ReturnType<typeof envelope>>()
        http.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(oldState.promise).mockReturnValueOnce(oldUnread.promise)
        const old = [store.dispatch(privateApi.endpoints.favorites.initiate(1)),
            store.dispatch(privateApi.endpoints.favoriteState.initiate(stateArg())),
            store.dispatch(privateApi.endpoints.unread.initiate(1))]
        const signals = http.mock.calls.map(([config]) => config.signal as AbortSignal)
        login(owner, 'rotated')
        expect(signals.every(signal => signal.aborted)).toBe(true)
        http.mockResolvedValueOnce(envelope([favorite(99, 'B')]))
            .mockResolvedValueOnce(envelope(stateFact(owner, false))).mockResolvedValueOnce(envelope(counts(2)))
        await Promise.all([store.dispatch(privateApi.endpoints.favorites.initiate(owner)).unwrap(),
            store.dispatch(privateApi.endpoints.favoriteState.initiate(stateArg(owner))).unwrap(),
            store.dispatch(privateApi.endpoints.unread.initiate(owner)).unwrap()])
        oldList.resolve(envelope([favorite(54, 'A')]))
        oldState.resolve(envelope(stateFact()))
        oldUnread.resolve(envelope(counts(100)))
        await Promise.all(old); await flush()
        expect(privateApi.endpoints.favorites.select(owner)(store.getState()).data).toEqual([favorite(99, 'B')])
        expect(privateApi.endpoints.favoriteState.select(stateArg(owner))(store.getState()).data?.isFavorite).toBe(false)
        expect(privateApi.endpoints.unread.select(owner)(store.getState()).data).toEqual(counts(2))
        if (owner !== 1) expect(privateApi.endpoints.favorites.select(1)(store.getState()).isUninitialized).toBe(true)
    })

    it.each(['logout', 'storage-token', 'storage-clear'] as const)('clears cached and in-flight reads on %s', async reason => {
        http.mockResolvedValueOnce(envelope([favorite(54, 'private')]))
        const request = store.dispatch(privateApi.endpoints.favorites.initiate(1))
        await request.unwrap()
        store.dispatch(galleryApi.util.upsertQueryEntries([{endpointName: 'folders', arg: undefined,
            value: [{id: 1, parentId: 0, name: 'private-folder', imageCount: 0}]}]))
        const pending = deferred<ReturnType<typeof envelope>>()
        http.mockReturnValueOnce(pending.promise)
        const late = request.refetch()
        const signal = http.mock.calls[1][0].signal as AbortSignal
        localStorage.clear()
        window.dispatchEvent(reason === 'logout' ? new Event('auth-change')
            : new StorageEvent('storage', {key: reason === 'storage-clear' ? null : 'tokenKey'}))
        expect(signal.aborted).toBe(true)
        pending.resolve(envelope([favorite(54, 'late-private')]))
        await late; await flush()
        expect(privateApi.endpoints.favorites.select(1)(store.getState()).isUninitialized).toBe(true)
        expect(galleryApi.endpoints.folders.select()(store.getState()).isUninitialized).toBe(true)
    })

    it('clears the actual query store when the existing authentication expiry timer fires', async () => {
        vi.useFakeTimers()
        localStorage.setItem('tokenKey', token(1, 'short', Math.floor(Date.now() / 1000) + 1))
        const stop = startAuthExpiry()
        try {
            http.mockResolvedValueOnce(envelope(counts(5)))
            await store.dispatch(privateApi.endpoints.unread.initiate(1)).unwrap()
            await vi.advanceTimersByTimeAsync(1100)
            expect(localStorage.getItem('tokenKey')).toBeNull()
            expect(privateApi.endpoints.unread.select(1)(store.getState()).isUninitialized).toBe(true)
        } finally {stop(); vi.useRealTimers()}
    })

    it('preserves confirmed data on business failure and rejects malformed success payloads', async () => {
        http.mockResolvedValueOnce(envelope([favorite(54)])).mockResolvedValueOnce(envelope(null, 500))
        const list = store.dispatch(privateApi.endpoints.favorites.initiate(1))
        await list.unwrap()
        await expect(list.refetch().unwrap()).rejects.toBeTruthy()
        expect(privateApi.endpoints.favorites.select(1)(store.getState()).data).toEqual([favorite(54)])
        http.mockResolvedValueOnce(envelope({total: 0}))
        await expect(store.dispatch(privateApi.endpoints.unread.initiate(1)).unwrap()).rejects.toBeTruthy()
        http.mockResolvedValueOnce(envelope(stateFact(2)))
        await expect(store.dispatch(privateApi.endpoints.favoriteState.initiate(stateArg())).unwrap()).rejects.toBeTruthy()
    })

    it('does not refresh private queries for chat, reads, preparations or inactive subscribers', async () => {
        http.mockResolvedValue(envelope(counts(3)))
        const read = store.dispatch(privateApi.endpoints.unread.initiate(1))
        await read.unwrap()
        for (const detail of [undefined, {}, {confirmationAttempted:false}])
            window.dispatchEvent(new CustomEvent('agent-turn-done',{detail}))
        await flush()
        expect(http).toHaveBeenCalledTimes(1)
        window.dispatchEvent(new CustomEvent('agent-turn-done',{detail:{confirmationAttempted:true}}))
        await waitFor(() => expect(http).toHaveBeenCalledTimes(2))
        await store.dispatch(privateApi.util.getRunningQueriesThunk())[0]
        reset()
        http.mockClear()
        http.mockResolvedValue(envelope([favorite(54)]))
        await store.dispatch(privateApi.endpoints.favorites.initiate(1,{subscribe:false})).unwrap()
        window.dispatchEvent(new Event('favorites-change'))
        await flush()
        expect(http).toHaveBeenCalledTimes(1)
        expect(privateApi.endpoints.favorites.select(1)(store.getState()).isUninitialized).toBe(true)
        read.unsubscribe()
    })

    it('retains every unread counter, including isolated moderation and quota changes', async () => {
        http.mockResolvedValueOnce(envelope(counts()))
            .mockResolvedValueOnce(envelope({...counts(),pendingQuota:2,pendingComments:4}))
        const read=store.dispatch(privateApi.endpoints.unread.initiate(1))
        await read.unwrap();await read.refetch().unwrap()
        expect(privateApi.endpoints.unread.select(1)(store.getState()).data)
            .toEqual({...counts(),pendingQuota:2,pendingComments:4})
        read.unsubscribe()
    })
})

function Profile() {
    const favorites = useFavorites(true)
    const unread = useUnread(true)
    const faved = useFavoriteState(54)
    return <><output data-testid="rows">{favorites.list?.map(row => row.title).join(',') ?? 'loading'}</output>
        <output data-testid="counts">{unread.counts.total}</output><output data-testid="faved">{String(faved)}</output></>
}
describe('mounted private consumers', () => {
    it('shares unread polling, pauses when unfocused and stops after unmount', async () => {
        vi.useFakeTimers()
        const Badge=()=>{const {counts}=useUnread(true);return <output>{counts.pendingQuota}</output>}
        http.mockResolvedValue(envelope(counts(1)))
        const mounted=render(<Provider store={store}><Badge/><Badge/></Provider>)
        try {
            await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
            expect(http).toHaveBeenCalledTimes(1)
            await act(async()=>{await vi.advanceTimersByTimeAsync(61_000)})
            expect(http).toHaveBeenCalledTimes(2)
            act(()=>window.dispatchEvent(new Event('blur')))
            await act(async()=>{await vi.advanceTimersByTimeAsync(61_000)})
            expect(http).toHaveBeenCalledTimes(2)
            act(()=>window.dispatchEvent(new Event('focus')))
            await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
            expect(http).toHaveBeenCalledTimes(3)
            mounted.unmount()
            await act(async()=>{await vi.advanceTimersByTimeAsync(121_000)})
            expect(http).toHaveBeenCalledTimes(3)
        } finally {mounted.unmount();vi.useRealTimers()}
    })

    it('never renders A data as B while B requests are pending', async () => {
        http.mockImplementation(config => Promise.resolve(envelope(config.url.endsWith('/summary') ? counts(5)
            : config.url.endsWith('/54') ? stateFact() : [favorite(54, 'A')])) )
        render(<Provider store={store}><Profile/></Provider>)
        await screen.findByText('A')
        const pending = deferred<ReturnType<typeof envelope>>()
        http.mockReturnValue(pending.promise)
        act(() => login(2))
        expect(screen.getByTestId('rows').textContent).toBe('loading')
        expect(screen.getByTestId('counts').textContent).toBe('0')
        expect(screen.getByTestId('faved').textContent).toBe('false')
        pending.resolve(envelope(null, 500))
        await waitFor(() => expect(privateApi.endpoints.favorites.select(2)(store.getState()).isError).toBe(true))
        expect(screen.getByTestId('rows').textContent).not.toContain('A')
    })

    it('updates a confirmed favorite without accepting an older read or inventing an incomplete list row', async () => {
        const oldState = deferred<ReturnType<typeof envelope>>()
        const oldList = deferred<ReturnType<typeof envelope>>()
        http.mockReturnValueOnce(oldState.promise).mockReturnValueOnce(oldList.promise)
            .mockResolvedValue(envelope([]))
        store.dispatch(privateApi.endpoints.favoriteState.initiate(stateArg()))
        store.dispatch(privateApi.endpoints.favorites.initiate(1))
        expect(await applyLocalFavorite({...stateFact(1, false), changed: true})).toBe(true)
        oldState.resolve(envelope(stateFact(1, true)))
        oldList.resolve(envelope([favorite(54, 'stale')]))
        await flush()
        expect(privateApi.endpoints.favoriteState.select(stateArg())(store.getState()).data?.isFavorite).toBe(false)
        await waitFor(() => expect(privateApi.endpoints.favorites.select(1)(store.getState()).data).toEqual([]))
        expect(await applyLocalFavorite({...stateFact(1, true), changed: true})).toBe(true)
        expect(privateApi.endpoints.favoriteState.select(stateArg())(store.getState()).data?.isFavorite).toBe(true)
        expect(privateApi.endpoints.favorites.select(1)(store.getState()).data).toEqual([])
        login(2)
        expect(await applyLocalFavorite({...stateFact(1, true), changed: true})).toBe(false)
        expect(privateApi.endpoints.favoriteState.select(stateArg(2))(store.getState()).isUninitialized).toBe(true)
    })
})
