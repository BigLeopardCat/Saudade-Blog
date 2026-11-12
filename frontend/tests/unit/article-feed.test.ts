import {describe, expect, it, vi} from 'vitest'
import {createArticleFeed, requireArticlePage, requireArticleRows, type ArticlePage} from '../../src/frontHome/Content/ContentHome/articleFeed'

const page = (items: string[], nextCursor: string | null = null): ArticlePage<string> => ({items, nextCursor})
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return {promise, resolve, reject}
}
function setup(request: (cursor: string | null, size: number) => Promise<ArticlePage<string>>) {
    const commit = vi.fn()
    const feed = createArticleFeed(request, {items: ['cached'], page: 1, pageSize: 2,
        nextCursor: 'after-cached', hasMore: true, loaded: true}, commit, value => value)
    return {feed, commit}
}

describe('homepage cursor feed', () => {
    it('validates cursor and pinned-list API envelopes without accepting business failures', () => {
        expect(requireArticleRows({data: {code: 200, data: []}})).toEqual([])
        expect(requireArticlePage({data: {code: 200, data: page([])}})).toEqual(page([]))
        for (const data of [[], null, {items: []}, {items: [], nextCursor: ''}, {items: [], nextCursor: 3}]) {
            expect(() => requireArticlePage({data: {code: 200, data}})).toThrow()
        }
        expect(() => requireArticlePage({data: {code: 500, data: page([])}})).toThrow()
        expect(() => requireArticleRows({data: {code: 500, data: []}})).toThrow()
    })

    it('preserves the exact failed cursor and cache until a successful retry', async () => {
        const request = vi.fn<(cursor: string | null, size: number) => Promise<ArticlePage<string>>>()
            .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page(['next']))
        const {feed, commit} = setup(request)
        await feed.more()
        expect(feed.snapshot()).toMatchObject({items: ['cached'], page: 1, nextCursor: 'after-cached', hasMore: true, error: expect.any(String)})
        expect(commit).not.toHaveBeenCalled()
        await feed.retry()
        expect(request.mock.calls).toEqual([['after-cached', 2], ['after-cached', 2]])
        expect(feed.snapshot()).toMatchObject({items: ['cached', 'next'], page: 2, nextCursor: null, hasMore: false, error: null})
    })

    it('coalesces repeated intersection callbacks into one pending request', async () => {
        const pending = deferred<ArticlePage<string>>()
        const request = vi.fn(() => pending.promise)
        const {feed} = setup(request)
        const first = feed.more()
        expect(feed.more()).toBe(first)
        pending.resolve(page(['a', 'b'], 'after-b'))
        await first
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('uses nextCursor instead of row count and stops at the confirmed end', async () => {
        const request = vi.fn().mockResolvedValueOnce(page(['a', 'b'])).mockResolvedValueOnce(page(['unexpected']))
        const {feed} = setup(request)
        await feed.more()
        await feed.more()
        expect(request).toHaveBeenCalledTimes(1)
        expect(feed.snapshot().hasMore).toBe(false)
    })

    it('deduplicates rows across responses without losing the next cursor', async () => {
        const {feed} = setup(async () => page(['cached', 'next'], 'next-cursor'))
        await feed.more()
        expect(feed.snapshot()).toMatchObject({items: ['cached', 'next'], nextCursor: 'next-cursor'})
    })

    it('rejects a non-advancing cursor so automatic loading cannot spin forever', async () => {
        const {feed, commit} = setup(async () => page(['duplicate'], 'after-cached'))
        await feed.more()
        expect(feed.snapshot()).toMatchObject({items: ['cached'], error: expect.any(String), pending: false})
        expect(commit).not.toHaveBeenCalled()
    })

    it('does not turn failed first-page replacement into a confirmed empty feed', async () => {
        const {feed, commit} = setup(async () => { throw new Error('offline') })
        await feed.first(4)
        expect(feed.snapshot()).toMatchObject({items: ['cached'], pageSize: 2, nextCursor: 'after-cached', error: expect.any(String)})
        expect(commit).not.toHaveBeenCalled()
    })

    it('discards stale next-page responses after a grid replacement', async () => {
        const more = deferred<ArticlePage<string>>(), first = deferred<ArticlePage<string>>()
        const {feed, commit} = setup(cursor => cursor === null ? first.promise : more.promise)
        const old = feed.more(), fresh = feed.first(4)
        first.resolve(page(['fresh'], 'fresh-cursor')); await fresh
        more.resolve(page(['stale'], 'stale-cursor')); await old
        expect(feed.snapshot()).toMatchObject({items: ['fresh'], page: 1, pageSize: 4, nextCursor: 'fresh-cursor'})
        expect(commit).toHaveBeenCalledTimes(1)
    })

    it('does not clear a newer replacement when an old request fails', async () => {
        const old = deferred<ArticlePage<string>>(), fresh = deferred<ArticlePage<string>>()
        const {feed} = setup((_cursor, size) => size === 3 ? old.promise : fresh.promise)
        const a = feed.first(3), b = feed.first(4)
        old.reject(new Error('stale')); await a
        expect(feed.snapshot().pending).toBe(true)
        fresh.resolve(page(['fresh'])); await b
        expect(feed.snapshot()).toMatchObject({items: ['fresh'], pending: false, error: null})
    })

    it('retries a failed grid replacement before requesting its next cursor', async () => {
        const request = vi.fn().mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(page(['a', 'b'], 'new-cursor')).mockResolvedValueOnce(page([]))
        const {feed} = setup(request)
        await feed.first(4); await feed.more(); await feed.more()
        expect(request.mock.calls).toEqual([[null, 4], [null, 4], ['new-cursor', 4]])
    })

    it('invalidates unmounted requests before they can update the session cache', async () => {
        const pending = deferred<ArticlePage<string>>()
        const {feed, commit} = setup(() => pending.promise)
        const request = feed.first(4)
        feed.invalidate(); pending.resolve(page(['stale'])); await request
        expect(feed.snapshot()).toMatchObject({items: ['cached'], pending: false})
        expect(commit).not.toHaveBeenCalled()
    })

    it('refreshes the loaded window using fresh cursors and retains the new tail', async () => {
        const request = vi.fn().mockResolvedValueOnce(page(['old-second'], 'old-tail'))
            .mockResolvedValueOnce(page(['fresh-a', 'fresh-b'], 'fresh-first'))
            .mockResolvedValueOnce(page(['fresh-c'], 'fresh-tail'))
        const {feed} = setup(request)
        await feed.more(); request.mockClear()
        await feed.refresh()
        expect(request.mock.calls).toEqual([[null, 2], ['fresh-first', 2]])
        expect(feed.snapshot()).toMatchObject({items: ['fresh-a', 'fresh-b', 'fresh-c'], page: 2,
            nextCursor: 'fresh-tail', hasMore: true, pending: false})
    })
})
